import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/peer_review.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_brief TEXT,
  project_goals TEXT,
  project_expectations TEXT,
  reporting_structure TEXT,
  duration TEXT,
  review_cadence TEXT,
  review_dates_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sensitive_data (
  project_id TEXT PRIMARY KEY,
  contracts TEXT,
  offers TEXT,
  terms_and_conditions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Tech Lead',
  role_level TEXT NOT NULL DEFAULT 'lead',
  role_criticality TEXT NOT NULL DEFAULT 'high',
  expected_responsibilities TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS review_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  review_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  sent_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  review_session_id INTEGER,
  reviewer_user_id TEXT NOT NULL,
  reviewee_user_id TEXT NOT NULL,
  communication_score REAL NOT NULL,
  execution_score REAL NOT NULL,
  collaboration_score REAL NOT NULL,
  strengths TEXT NOT NULL,
  improvements TEXT NOT NULL,
  feedback_json TEXT NOT NULL DEFAULT '{}',
  project_context_snapshot TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  reviewee_user_id TEXT NOT NULL,
  final_score REAL NOT NULL,
  communication_score REAL NOT NULL,
  execution_score REAL NOT NULL,
  collaboration_score REAL NOT NULL,
  summary TEXT NOT NULL,
  strengths TEXT NOT NULL,
  improvements TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE(project_id, reviewee_user_id)
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

for (const migration of [
  `ALTER TABLE projects ADD COLUMN project_expectations TEXT`,
  `ALTER TABLE projects ADD COLUMN reporting_structure TEXT`,
  `ALTER TABLE responses ADD COLUMN feedback_json TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE responses ADD COLUMN project_context_snapshot TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS reviewer_sessions (
    reviewer_user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    review_session_id INTEGER NOT NULL,
    step TEXT NOT NULL DEFAULT 'review_request_confirmation',
    review_queue_json TEXT NOT NULL DEFAULT '[]',
    reviewee_user_id TEXT,
    partial_answers_json TEXT NOT NULL DEFAULT '{}',
    later_remind_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (reviewer_user_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS review_send_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    review_session_id INTEGER NOT NULL,
    reviewer_user_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    error_text TEXT
  )`
]) {
  try { db.exec(migration); } catch (err) {
    if (!String(err.message || err).includes('duplicate column name')) throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeProjectId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || 'project';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug}-${stamp}-${suffix}`;
}
