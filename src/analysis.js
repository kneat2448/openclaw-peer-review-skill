import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso } from './db.js';

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function riskFromScore(score, roleCriticality) {
  if (score < 6) return 'High';
  if (score < 7 || (score < 7.5 && roleCriticality === 'high')) return 'Medium';
  return 'Low';
}

function expectationFit(score, roleCriticality, reportingStructure) {
  const hasPocDuty = /owner|owns|reports|poc|point[- ]of[- ]contact|lead|status/i.test(reportingStructure || '');
  const threshold = roleCriticality === 'high' || hasPocDuty ? 7.5 : 7;
  if (!score) return 'Insufficient feedback to evaluate against expectations.';
  if (score >= threshold + 1) return 'Exceeds project expectations for this role/context.';
  if (score >= threshold) return 'Meets project expectations for this role/context.';
  return 'Below expectations for this role/context; follow-up recommended.';
}

function compactText(items, fallback) {
  const joined = items.filter(Boolean).join(' | ').trim();
  return joined || fallback;
}

export function analyzeProject(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const members = db.prepare('SELECT * FROM team_members WHERE project_id = ?').all(projectId);
  const responses = db.prepare('SELECT * FROM responses WHERE project_id = ?').all(projectId);
  const generatedAt = nowIso();
  const analysisContext = {
    project_expectations: project.project_expectations || project.project_goals || project.project_brief || '',
    duration: project.duration || '',
    reporting_structure: project.reporting_structure || ''
  };

  const upsert = db.prepare(`
    INSERT INTO results (
      project_id, reviewee_user_id, final_score, communication_score, execution_score,
      collaboration_score, summary, strengths, improvements, risk_level, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, reviewee_user_id) DO UPDATE SET
      final_score=excluded.final_score,
      communication_score=excluded.communication_score,
      execution_score=excluded.execution_score,
      collaboration_score=excluded.collaboration_score,
      summary=excluded.summary,
      strengths=excluded.strengths,
      improvements=excluded.improvements,
      risk_level=excluded.risk_level,
      generated_at=excluded.generated_at
  `);

  const results = members.map((member) => {
    const ownResponses = responses.filter((r) => r.reviewee_user_id === member.telegram_user_id);
    const communicationScore = Number(avg(ownResponses.map((r) => r.communication_score)).toFixed(1));
    const executionScore = Number(avg(ownResponses.map((r) => r.execution_score)).toFixed(1));
    const collaborationScore = Number(avg(ownResponses.map((r) => r.collaboration_score)).toFixed(1));
    const finalScore = Number(avg([communicationScore, executionScore, collaborationScore].filter(Boolean)).toFixed(1));
    const riskLevel = ownResponses.length ? riskFromScore(finalScore, member.role_criticality) : 'Unknown';

    const strengths = compactText(ownResponses.map((r) => r.strengths), 'Not enough review data yet.');
    const improvements = compactText(ownResponses.map((r) => r.improvements), 'Not enough review data yet.');
    const fit = expectationFit(finalScore, member.role_criticality, analysisContext.reporting_structure);
    const summary = ownResponses.length
      ? `${member.name} was reviewed as ${member.role} (${member.role_level}, ${member.role_criticality} criticality). Overall score: ${finalScore}/10. ${fit}`
      : `${member.name} has no submitted review responses yet for ${project.project_name}.`;

    upsert.run(
      projectId,
      member.telegram_user_id,
      finalScore || 0,
      communicationScore || 0,
      executionScore || 0,
      collaborationScore || 0,
      summary,
      strengths,
      improvements,
      riskLevel,
      generatedAt
    );

    return {
      reviewee_user_id: member.telegram_user_id,
      name: member.name,
      role: member.role,
      role_level: member.role_level,
      role_criticality: member.role_criticality,
      final_score: finalScore || 0,
      communication_score: communicationScore || 0,
      execution_score: executionScore || 0,
      collaboration_score: collaborationScore || 0,
      summary,
      strengths,
      improvements,
      risk_level: riskLevel,
      expectation_fit: fit,
      response_count: ownResponses.length
    };
  });

  db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ?').run('analyzed', generatedAt, projectId);

  const dashboardData = {
    project: {
      project_id: project.project_id,
      project_name: project.project_name,
      project_brief: project.project_brief,
      project_expectations: project.project_expectations,
      duration: project.duration,
      review_cadence: project.review_cadence,
      status: 'analyzed',
      generated_at: generatedAt
    },
    metrics: {
      team_size: members.length,
      response_count: responses.length,
      average_final_score: Number(avg(results.map((r) => r.final_score).filter(Boolean)).toFixed(1)) || 0
    },
    analysis_context: {
      expectations_used: Boolean(analysisContext.project_expectations),
      reporting_structure_used: Boolean(analysisContext.reporting_structure),
      sensitive_data_excluded: true
    },
    results
  };

  const outDir = path.resolve('dashboard/public/data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${projectId}.json`), JSON.stringify(dashboardData, null, 2));

  return dashboardData;
}

export function getDashboardData(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
  if (!project) return null;
  const members = db.prepare('SELECT * FROM team_members WHERE project_id = ?').all(projectId);
  const responses = db.prepare('SELECT * FROM responses WHERE project_id = ?').all(projectId);
  const results = db.prepare(`
    SELECT r.*, tm.name, tm.role, tm.role_level, tm.role_criticality
    FROM results r
    LEFT JOIN team_members tm ON tm.project_id = r.project_id AND tm.telegram_user_id = r.reviewee_user_id
    WHERE r.project_id = ?
  `).all(projectId);

  return {
    project: {
      project_id: project.project_id,
      project_name: project.project_name,
      project_brief: project.project_brief,
      project_expectations: project.project_expectations,
      duration: project.duration,
      review_cadence: project.review_cadence,
      status: project.status,
      created_at: project.created_at,
      updated_at: project.updated_at,
      review_dates: JSON.parse(project.review_dates_json || '[]')
    },
    metrics: {
      team_size: members.length,
      response_count: responses.length,
      average_final_score: Number(avg(results.map((r) => r.final_score).filter(Boolean)).toFixed(1)) || 0
    },
    analysis_context: {
      expectations_used: Boolean(project.project_expectations || project.project_goals || project.project_brief),
      reporting_structure_used: Boolean(project.reporting_structure),
      sensitive_data_excluded: true
    },
    results: results.map((r) => ({ ...r, expectation_fit: expectationFit(r.final_score, r.role_criticality, project.reporting_structure) }))
  };
}
