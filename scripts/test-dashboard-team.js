import dotenv from 'dotenv';
dotenv.config({ override: true });

import fs from 'node:fs';
import { db, makeProjectId, nowIso } from '../src/db.js';
import { analyzeProject, getDashboardData } from '../src/analysis.js';

const ownerUserId = String(process.env.TECH_LEAD_USER_ID || '8682856829');
const roster = JSON.parse(fs.readFileSync('./data/team_members.json', 'utf8'));
const selected = roster.filter((m) => ['Nitai', 'Deepak', 'Vatsal', 'Aditi'].includes(m.name));
const projectId = makeProjectId('Team Dataset Dashboard Test');
const now = nowIso();

db.prepare(`
  INSERT INTO projects (project_id, project_name, owner_user_id, project_brief, project_goals, duration, review_cadence, review_dates_json, status, created_at, updated_at)
  VALUES (?, 'Team Dataset Dashboard Test', ?, 'Validate roster dataset selection and dashboard output.', '', '1 week', 'now', ?, 'created', ?, ?)
`).run(projectId, ownerUserId, JSON.stringify([now]), now, now);

const insertMember = db.prepare(`
  INSERT INTO team_members (project_id, telegram_user_id, name, role, role_level, role_criticality, expected_responsibilities)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const roleLevel = (years) => years >= 4 ? 'senior' : years >= 2 ? 'mid' : 'junior';
const criticality = (role) => /operations|sde 2|lead|manager/i.test(role) ? 'high' : 'medium';

selected.forEach((member, index) => {
  insertMember.run(
    projectId,
    `member:${projectId}:${index + 1}`,
    member.name,
    member.role,
    roleLevel(Number(member.experience_years || 0)),
    criticality(member.role),
    `${member.role}; ${member.experience_years} years experience.`
  );
});

const session = db.prepare(`
  INSERT INTO review_sessions (project_id, review_date, status, sent_at)
  VALUES (?, ?, 'sent', ?)
`).run(projectId, now, now);

const insertResponse = db.prepare(`
  INSERT INTO responses (project_id, review_session_id, reviewer_user_id, reviewee_user_id, communication_score, execution_score, collaboration_score, strengths, improvements, submitted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

selected.forEach((member, index) => {
  const id = `member:${projectId}:${index + 1}`;
  insertResponse.run(
    projectId,
    session.lastInsertRowid,
    ownerUserId,
    id,
    7.5 + index * 0.4,
    7.2 + index * 0.5,
    7.8 + index * 0.3,
    `${member.name} showed solid ownership as ${member.role}.`,
    `${member.name} should document updates more consistently.`,
    now
  );
});

const analyzed = analyzeProject(projectId);
const dashboard = getDashboardData(projectId);

if (dashboard.metrics.team_size !== selected.length) throw new Error(`Expected ${selected.length} members, got ${dashboard.metrics.team_size}`);
if (dashboard.metrics.response_count !== selected.length) throw new Error(`Expected ${selected.length} responses, got ${dashboard.metrics.response_count}`);
if (dashboard.results.length !== selected.length) throw new Error(`Expected ${selected.length} result rows, got ${dashboard.results.length}`);

console.log(`Dashboard test passed: http://localhost:${process.env.PORT || 3000}/dashboard/${projectId}`);
console.log(JSON.stringify({ projectId, metrics: analyzed.metrics, members: analyzed.results.map((r) => ({ name: r.name, role: r.role, score: r.final_score })) }, null, 2));
