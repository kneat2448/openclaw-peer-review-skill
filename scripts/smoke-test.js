import dotenv from 'dotenv';
dotenv.config({ override: true });

import { db, makeProjectId, nowIso } from '../src/db.js';
import { analyzeProject, getDashboardData } from '../src/analysis.js';

const userId = String(process.env.TECH_LEAD_USER_ID || '8682856829');
const projectId = makeProjectId('Smoke Test Project');
const now = nowIso();

db.prepare(`
  INSERT INTO projects (project_id, project_name, owner_user_id, project_brief, project_goals, duration, review_cadence, review_dates_json, status, created_at, updated_at)
  VALUES (?, 'Smoke Test Project', ?, 'Validate local MVP pipeline.', '', '1 day', 'now', ?, 'created', ?, ?)
`).run(projectId, userId, JSON.stringify([now]), now, now);

db.prepare(`
  INSERT INTO team_members (project_id, telegram_user_id, name, role, role_level, role_criticality, expected_responsibilities)
  VALUES (?, ?, 'Nitai', 'Tech Lead', 'lead', 'high', 'Own delivery.')
`).run(projectId, userId);

db.prepare(`
  INSERT INTO responses (project_id, review_session_id, reviewer_user_id, reviewee_user_id, communication_score, execution_score, collaboration_score, strengths, improvements, submitted_at)
  VALUES (?, NULL, ?, ?, 8, 8.5, 9, 'Clear ownership and quick iteration.', 'Document decisions more consistently.', ?)
`).run(projectId, userId, userId, now);

const analyzed = analyzeProject(projectId);
const dashboard = getDashboardData(projectId);

if (!analyzed.results.length || !dashboard.results.length) throw new Error('Smoke test failed: no results generated');
console.log(`Smoke test passed: http://localhost:${process.env.PORT || 3000}/dashboard/${projectId}`);
