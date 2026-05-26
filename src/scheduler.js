import cron from 'node-cron';
import { db, nowIso } from './db.js';

const scheduled = new Map();

function msUntil(iso) {
  return new Date(iso).getTime() - Date.now();
}

export function createProjectCronJobs(projectId, reviewDates) {
  const insert = db.prepare(`
    INSERT INTO cron_jobs (project_id, job_type, run_at, status, created_at, updated_at)
    VALUES (?, ?, ?, 'scheduled', ?, ?)
  `);
  const now = nowIso();
  for (const runAt of reviewDates) {
    insert.run(projectId, 'send_review', runAt, now, now);
  }
}

export function schedulePendingJobs({ sendReviewForProject }) {
  for (const timeout of scheduled.values()) clearTimeout(timeout);
  scheduled.clear();

  const jobs = db.prepare(`
    SELECT * FROM cron_jobs
    WHERE status = 'scheduled'
    ORDER BY run_at ASC
  `).all();

  for (const job of jobs) {
    const delay = msUntil(job.run_at);
    if (delay <= 0) {
      runJob(job, sendReviewForProject).catch(console.error);
      continue;
    }
    const timeout = setTimeout(() => runJob(job, sendReviewForProject).catch(console.error), Math.min(delay, 2147483647));
    scheduled.set(job.id, timeout);
  }

  // Lightweight reconciliation: every minute, catch missed due jobs.
  cron.schedule('* * * * *', () => {
    const due = db.prepare(`
      SELECT * FROM cron_jobs
      WHERE status = 'scheduled' AND datetime(run_at) <= datetime('now')
      ORDER BY run_at ASC
    `).all();
    for (const job of due) runJob(job, sendReviewForProject).catch(console.error);
  });
}

async function runJob(job, sendReviewForProject) {
  const fresh = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(job.id);
  if (!fresh || fresh.status !== 'scheduled') return;

  db.prepare('UPDATE cron_jobs SET status = ?, updated_at = ? WHERE id = ?').run('running', nowIso(), job.id);
  try {
    if (job.job_type === 'send_review') await sendReviewForProject(job.project_id);
    db.prepare('UPDATE cron_jobs SET status = ?, updated_at = ? WHERE id = ?').run('done', nowIso(), job.id);
  } catch (error) {
    db.prepare('UPDATE cron_jobs SET status = ?, updated_at = ? WHERE id = ?').run('failed', nowIso(), job.id);
    throw error;
  }
}
