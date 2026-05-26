import { Bot } from 'grammy';
import fs from 'node:fs';
import { db, makeProjectId, nowIso } from './db.js';
import { analyzeProject } from './analysis.js';
import { createProjectCronJobs, schedulePendingJobs } from './scheduler.js';

// In-memory sessions only used for project creation flow.
// Review sessions are persisted in DB (reviewer_sessions table).
const sessions = new Map();
const savedTeamPath = './data/team_members.json';

// How long after "later" before we send a reminder (default 4 hours).
const LATER_REMIND_MS = Number(process.env.LATER_REMIND_MS || 4 * 60 * 60 * 1000);

function isTechLead(userId) {
  return String(userId) === String(process.env.TECH_LEAD_USER_ID);
}

// Fix: accept bare numbers, x/10, x out of 10, "eight" not accepted intentionally
function scoreFromText(raw) {
  const text = String(raw).trim().toLowerCase();
  // bare number
  let n = Number(text);
  if (!Number.isFinite(n)) {
    // x/10 or x/10.0
    const slashMatch = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*10$/);
    if (slashMatch) n = Number(slashMatch[1]);
  }
  if (!Number.isFinite(n)) {
    // "x out of 10"
    const outOfMatch = text.match(/^(\d+(?:\.\d+)?)\s+out\s+of\s+10$/);
    if (outOfMatch) n = Number(outOfMatch[1]);
  }
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
}

const REVIEW_QUESTIONS = [
  { key: 'communication_score', type: 'score', prompt: 'Communication score for this project (0-10): clarity, status updates, responsiveness, and blocker escalation.' },
  { key: 'communication_feedback', type: 'text', prompt: 'Communication feedback with one project-specific example.' },
  { key: 'execution_score', type: 'score', prompt: 'Execution / delivery score for assigned project responsibilities (0-10).' },
  { key: 'execution_feedback', type: 'text', prompt: 'Execution feedback: quality, speed, ownership, missed work, or delivered outcomes.' },
  { key: 'collaboration_score', type: 'score', prompt: 'Collaboration score with teammates and cross-functional partners on this project (0-10).' },
  { key: 'collaboration_feedback', type: 'text', prompt: 'Collaboration feedback: teamwork, handoffs, support, conflict handling, or dependencies.' },
  { key: 'ownership_score', type: 'score', prompt: 'Ownership / accountability score for their role and commitments (0-10).' },
  { key: 'problem_solving_score', type: 'score', prompt: 'Problem-solving score: handling ambiguity, blockers, tradeoffs, and project constraints (0-10).' },
  { key: 'reliability_score', type: 'score', prompt: 'Reliability / follow-through score: consistency, deadlines, and dependability (0-10).' },
  { key: 'project_context_fit', type: 'text', prompt: 'How well did their work fit the project brief, expectations, duration, and role criticality?' },
  { key: 'strengths', type: 'text', prompt: 'Top strengths shown on this project. Mention concrete behaviors or outcomes.' },
  { key: 'improvements', type: 'text', prompt: 'Most important improvement areas for this project. Be specific and constructive.' },
  { key: 'impact_example', type: 'text', prompt: 'One concrete example of their impact, positive or negative, during this project.' },
  { key: 'support_needed', type: 'text', prompt: 'What support, resources, clarity, or process changes would help them perform better?' },
  { key: 'final_comment', type: 'text', prompt: 'Final project-specific comment or risk/recognition note. Send "none" if nothing else.' }
];

function projectContextForReview(project, member) {
  return [
    `Project: ${project.project_name}`,
    project.project_brief ? `Brief: ${project.project_brief}` : null,
    project.project_expectations ? `Expectations: ${project.project_expectations}` : null,
    project.reporting_structure ? `Reporting / ownership: ${project.reporting_structure}` : null,
    project.duration ? `Duration: ${project.duration}` : null,
    `Reviewing: ${member.name} — ${member.role} (${member.role_level}, ${member.role_criticality} criticality)`,
    member.expected_responsibilities ? `Expected responsibilities: ${member.expected_responsibilities}` : null
  ].filter(Boolean).join('\n');
}

// Build questionnaire prompt, optionally pre-filling partial answers
function reviewQuestionnairePrompt(project, member, partialAnswers = {}) {
  const context = projectContextForReview(project, member);
  const questions = REVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q.prompt}`).join('\n');
  const template = REVIEW_QUESTIONS.map((q, i) => {
    const existing = partialAnswers[q.key] !== undefined ? partialAnswers[q.key] : '';
    return `${i + 1}: ${existing}`;
  }).join('\n');
  const prefilled = Object.keys(partialAnswers).length > 0 ? ' (your previous answers are pre-filled below)' : '';
  return `Peer review for ${member.name}\n\n${context}\n\nAnswer all 15 questions in one message. Scores: 0-10 (also accepts "8/10" or "8 out of 10").\n\n${questions}\n\nCopy this reply template${prefilled}:\n${template}\n\nSend "cancel" to stop.`;
}

// Fix: stricter line-start anchor — only match at true start of line (after trim)
// Fix: multi-line text answers — don't capture lines that look like question numbers
function parseReviewQuestionnaire(text) {
  const answers = {};
  let currentIndex = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Must be at true start of line: digit(s) followed immediately by ) . : -
    const match = line.match(/^(\d{1,2})[).:\-]\s*(.*)$/);
    if (match) {
      const index = Number(match[1]) - 1;
      if (index >= 0 && index < REVIEW_QUESTIONS.length) {
        currentIndex = index;
        answers[REVIEW_QUESTIONS[index].key] = match[2].trim();
        continue;
      }
    }
    // Continuation line — only append if it does NOT look like a question label
    if (currentIndex !== null && !line.match(/^\d{1,2}[).:\-]/)) {
      const key = REVIEW_QUESTIONS[currentIndex].key;
      answers[key] = `${answers[key] ? `${answers[key]}\n` : ''}${line}`.trim();
    }
  }

  const errors = [];
  for (let i = 0; i < REVIEW_QUESTIONS.length; i++) {
    const q = REVIEW_QUESTIONS[i];
    const value = answers[q.key];
    if (value === undefined || value === '') {
      errors.push(`${i + 1}. ${q.prompt}`);
      continue;
    }
    if (q.type === 'score') {
      const score = scoreFromText(String(value));
      if (score === null) errors.push(`${i + 1}. ${q.prompt} — must be 0-10 (e.g. 8, 7.5, 8/10)`);
      else answers[q.key] = score;
    }
  }

  return { answers, errors };
}

// --- DB-backed reviewer session helpers ---

function loadReviewerSession(reviewerUserId) {
  const row = db.prepare('SELECT * FROM reviewer_sessions WHERE reviewer_user_id = ?').get(reviewerUserId);
  if (!row) return null;
  return {
    mode: 'review',
    step: row.step,
    projectId: row.project_id,
    reviewSessionId: row.review_session_id,
    reviewQueue: JSON.parse(row.review_queue_json || '[]'),
    revieweeUserId: row.reviewee_user_id,
    partialAnswers: JSON.parse(row.partial_answers_json || '{}'),
    laterRemindAt: row.later_remind_at,
  };
}

function saveReviewerSession(reviewerUserId, state) {
  db.prepare(`
    INSERT INTO reviewer_sessions (reviewer_user_id, project_id, review_session_id, step, review_queue_json, reviewee_user_id, partial_answers_json, later_remind_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reviewer_user_id, project_id) DO UPDATE SET
      step=excluded.step, review_queue_json=excluded.review_queue_json,
      reviewee_user_id=excluded.reviewee_user_id, partial_answers_json=excluded.partial_answers_json,
      later_remind_at=excluded.later_remind_at, updated_at=excluded.updated_at
  `).run(
    reviewerUserId,
    state.projectId,
    state.reviewSessionId,
    state.step,
    JSON.stringify(state.reviewQueue || []),
    state.revieweeUserId || null,
    JSON.stringify(state.partialAnswers || {}),
    state.laterRemindAt || null,
    nowIso()
  );
}

function deleteReviewerSession(reviewerUserId) {
  db.prepare('DELETE FROM reviewer_sessions WHERE reviewer_user_id = ?').run(reviewerUserId);
}

// --- Review send helpers ---

function logReviewSend(projectId, reviewSessionId, reviewerUserId, status, errorText = null) {
  db.prepare(`
    INSERT INTO review_send_log (project_id, review_session_id, reviewer_user_id, sent_at, status, error_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, reviewSessionId, reviewerUserId, nowIso(), status, errorText);
}

// --- Utilities ---

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDurationDays(duration) {
  const text = String(duration || '').toLowerCase();
  const match = text.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|quarter|quarters|year|years)\b/);
  if (!match) return 30;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith('day')) return Math.max(1, Math.round(value));
  if (unit.startsWith('week')) return Math.max(1, Math.round(value * 7));
  if (unit.startsWith('month')) return Math.max(1, Math.round(value * 30));
  if (unit.startsWith('quarter')) return Math.max(1, Math.round(value * 90));
  if (unit.startsWith('year')) return Math.max(1, Math.round(value * 365));
  return 30;
}

function uniqueIsoDates(dates) {
  return [...new Map(dates.map((d) => [d.toISOString(), d.toISOString()])).values()];
}

export function formatScheduledReviewDate(iso, locale = 'en-IN') {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: process.env.APP_TIME_ZONE || process.env.TZ || 'Asia/Kolkata',
    timeZoneName: 'shortOffset'
  }).format(new Date(iso));
}

export function computeReviewDates(cadence, duration, startDate = new Date()) {
  const now = new Date(startDate);
  const lower = String(cadence || '').toLowerCase();
  const durationDays = parseDurationDays(duration);
  const end = addDays(now, durationDays);

  if (lower.includes('now') || lower.includes('immediate') || lower.includes('today')) return [now.toISOString()];
  if (lower.includes('half') && lower.includes('end')) return uniqueIsoDates([addDays(now, Math.ceil(durationDays / 2)), end]);
  if (lower.includes('half') || lower.includes('mid')) return [addDays(now, Math.ceil(durationDays / 2)).toISOString()];
  if (lower.includes('end') || lower.includes('final')) return [end.toISOString()];

  const intervalMatch = lower.match(/(?:every\s*)?(\d+)\s*(day|days|week|weeks|month|months)\b/);
  let intervalDays = null;
  if (intervalMatch) {
    const n = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    intervalDays = unit.startsWith('day') ? n : unit.startsWith('week') ? n * 7 : n * 30;
  } else if (lower.includes('daily')) intervalDays = 1;
  else if (lower.includes('biweekly') || lower.includes('fortnight')) intervalDays = 14;
  else if (lower.includes('week')) intervalDays = 7;
  else if (lower.includes('month')) intervalDays = 30;

  if (intervalDays) {
    const dates = [];
    for (let day = intervalDays; day <= durationDays; day += intervalDays) {
      dates.push(addDays(now, day));
      if (dates.length >= 24) break;
    }
    if (!dates.length) dates.push(end);
    if (dates[dates.length - 1].getTime() < end.getTime() && lower.includes('end')) dates.push(end);
    return uniqueIsoDates(dates);
  }

  return [end.toISOString()];
}

// --- Project helpers ---

function allProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

function latestProject() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT 1').get();
}

// Resolve project from user input: name match, index, or latest
function resolveProject(input) {
  if (!input) return latestProject();
  const projects = allProjects();
  if (!projects.length) return null;
  // numeric index
  const idx = Number(input.trim());
  if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) return projects[idx - 1];
  // name match (case-insensitive)
  return projects.find((p) => p.project_name.toLowerCase().includes(input.trim().toLowerCase())) || null;
}

function projectListText(projects) {
  return projects.map((p, i) => `${i + 1}. ${p.project_name} [${p.status}]`).join('\n');
}

function roleLevelFromExperience(years) {
  if (years >= 4) return 'senior';
  if (years >= 2) return 'mid';
  return 'junior';
}

function roleCriticality(role) {
  return /operations|sde 2|lead|manager/i.test(role) ? 'high' : 'medium';
}

function parseTeamMemberNames(text) {
  const roster = loadSavedTeamMembers();
  if (!roster?.length) return { members: null, missing: [], roster: [] };
  const trimmed = text.trim();
  const requestedNames = /^(all|default|saved|use saved|same)$/i.test(trimmed)
    ? roster.map((m) => m.name)
    : trimmed.split(/[\n,|]+/).map((n) => n.trim()).filter(Boolean);
  const members = [], missing = [];
  for (const name of requestedNames) {
    const member = roster.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (member) members.push(member);
    else missing.push(name);
  }
  return { members: members.length ? members : null, missing, roster };
}

function loadSavedTeamMembers() {
  if (!fs.existsSync(savedTeamPath)) return null;
  return JSON.parse(fs.readFileSync(savedTeamPath, 'utf8'));
}

function insertTeamMembers(projectId, members) {
  const insert = db.prepare(`
    INSERT INTO team_members (project_id, telegram_user_id, name, role, role_level, role_criticality, expected_responsibilities)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  members.forEach((member, index) => {
    const years = Number(member.experience_years || 0);
    insert.run(
      projectId,
      member.telegram_user_id ? String(member.telegram_user_id) : `member:${projectId}:${index + 1}`,
      member.name, member.role,
      roleLevelFromExperience(years),
      roleCriticality(member.role),
      member.expected_responsibilities || `${member.role}; ${years} years experience.`
    );
  });
}

function reviewRequestPrompt(project, reviewer, revieweeCount) {
  const plural = revieweeCount === 1 ? 'teammate' : 'teammates';
  return `Hi ${reviewer.name}, it is time for the ${project.project_name} peer review.\n\nCan you review ${revieweeCount} ${plural}? Reply "yes" to start or "later" if you cannot do it now.`;
}

function projectSetupPrompt() {
  const saved = loadSavedTeamMembers();
  const savedText = saved?.length
    ? saved.map((m) => `- ${m.name} — ${m.role}, ${m.experience_years}y${m.telegram_user_id ? `, Telegram: ${m.telegram_user_id}` : ''}`).join('\n')
    : 'No saved roster found.';
  return `Send the project details in one message. You can copy this template:\n\nProject name: \nProject brief: \nExpectations / success criteria: \nDuration: \nReview cadence: \nTeam members: \nReporting / point of contact: \nExpected responsibilities: \nContracts: none\nOffers / commercial commitments: none\nTerms / constraints: none\n\nSaved roster:\n${savedText}\n\nFor team members, send names from the saved roster, comma-separated, or "all". Expected responsibilities is optional — describe what each member is accountable for.`;
}

function parseLabeledProjectSetup(text) {
  const fieldAliases = new Map([
    ['project name', 'project_name'], ['name', 'project_name'],
    ['project brief', 'project_brief'], ['brief', 'project_brief'],
    ['expectations / success criteria', 'project_expectations'],
    ['expectations', 'project_expectations'], ['success criteria', 'project_expectations'],
    ['duration', 'duration'], ['project duration', 'duration'],
    ['review cadence', 'review_cadence'], ['cadence', 'review_cadence'],
    ['team members', 'team_members_text'], ['members', 'team_members_text'],
    ['reporting / point of contact', 'reporting_structure'],
    ['reporting', 'reporting_structure'], ['point of contact', 'reporting_structure'],
    ['expected responsibilities', 'expected_responsibilities'],
    ['responsibilities', 'expected_responsibilities'],
    ['contracts', 'contracts'], ['contract', 'contracts'],
    ['offers / commercial commitments', 'offers'], ['offers', 'offers'],
    ['commercial commitments', 'offers'],
    ['terms / constraints', 'terms_and_conditions'],
    ['terms', 'terms_and_conditions'], ['constraints', 'terms_and_conditions']
  ]);
  const answers = {};
  let currentKey = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const key = fieldAliases.get(match[1].trim().toLowerCase());
      if (key) { currentKey = key; answers[key] = match[2].trim(); continue; }
    }
    if (currentKey) answers[currentKey] = `${answers[currentKey] ? `${answers[currentKey]}\n` : ''}${line}`.trim();
  }
  for (const key of ['contracts', 'offers', 'terms_and_conditions']) {
    if (!answers[key]) answers[key] = 'none';
  }
  return answers;
}

function missingProjectSetupFields(answers) {
  return [
    ['project_name', 'Project name'], ['project_brief', 'Project brief'],
    ['project_expectations', 'Expectations / success criteria'],
    ['duration', 'Duration'], ['review_cadence', 'Review cadence'],
    ['team_members_text', 'Team members'], ['reporting_structure', 'Reporting / point of contact']
  ].filter(([key]) => !answers[key]?.trim()).map(([, label]) => label);
}

async function reply(ctx, text) {
  return ctx.reply(text, { link_preview_options: { is_disabled: true } }).catch(() => ctx.reply(text));
}

// --- Per-member review status ---

function reviewStatusText(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
  const members = db.prepare('SELECT * FROM team_members WHERE project_id = ?').all(projectId);
  const responses = db.prepare('SELECT DISTINCT reviewer_user_id FROM responses WHERE project_id = ?').all(projectId);
  const submittedIds = new Set(responses.map((r) => r.reviewer_user_id));
  const realReviewers = members.filter((m) => !m.telegram_user_id.startsWith('member:'));

  const lines = [`${project.project_name} — ${project.status}\n`];
  lines.push('Reviewer status:');
  for (const m of realReviewers) {
    const submitted = submittedIds.has(m.telegram_user_id);
    const pending = loadReviewerSession(m.telegram_user_id);
    let status = '— not started';
    if (submitted) status = '✓ submitted';
    else if (pending?.step === 'review_request_confirmation') status = '… waiting for confirmation';
    else if (pending?.step === 'review_questions') status = '… in progress';
    lines.push(`  ${m.name}: ${status}`);
  }
  const total = realReviewers.length;
  const done = realReviewers.filter((m) => submittedIds.has(m.telegram_user_id)).length;
  lines.push(`\n${done}/${total} reviewers submitted.`);
  return lines.join('\n');
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

  const bot = new Bot(token);

  // --- Send reviews with per-reviewer failure handling ---

  async function sendReviewForProject(projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
    if (!project) return;
    const members = db.prepare('SELECT * FROM team_members WHERE project_id = ?').all(projectId);
    const session = db.prepare(`
      INSERT INTO review_sessions (project_id, review_date, status, sent_at)
      VALUES (?, ?, 'sent', ?)
    `).run(projectId, nowIso(), nowIso());

    const realReviewers = members.filter((m) => !m.telegram_user_id.startsWith('member:'));
    const reviewerJobs = realReviewers.length
      ? realReviewers.map((reviewer) => ({
          reviewer,
          reviewerUserId: String(reviewer.telegram_user_id),
          reviewees: members.filter((m) => m.telegram_user_id !== reviewer.telegram_user_id)
        }))
      : [{
          reviewer: { name: 'Tech Lead' },
          reviewerUserId: String(project.owner_user_id),
          reviewees: members
        }];

    const failed = [];
    for (const job of reviewerJobs) {
      if (!job.reviewees.length) continue;
      const state = {
        mode: 'review',
        step: 'review_request_confirmation',
        projectId,
        reviewSessionId: session.lastInsertRowid,
        reviewQueue: job.reviewees.map((m) => m.telegram_user_id),
        revieweeUserId: job.reviewees[0]?.telegram_user_id,
        partialAnswers: {},
        laterRemindAt: null,
      };
      try {
        await bot.api.sendMessage(job.reviewerUserId, reviewRequestPrompt(project, job.reviewer, job.reviewees.length));
        saveReviewerSession(job.reviewerUserId, state);
        logReviewSend(projectId, session.lastInsertRowid, job.reviewerUserId, 'sent');
      } catch (err) {
        const errText = String(err?.message || err);
        logReviewSend(projectId, session.lastInsertRowid, job.reviewerUserId, 'failed', errText);
        failed.push(`${job.reviewer.name} (${errText})`);
        console.error(`Failed to send review to ${job.reviewerUserId}:`, err);
      }
    }

    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ?').run('review_requested', nowIso(), projectId);

    // Notify tech lead of failures
    if (failed.length) {
      try {
        await bot.api.sendMessage(
          String(process.env.TECH_LEAD_USER_ID),
          `Review sent for ${project.project_name}, but failed to reach:\n${failed.map((f) => `- ${f}`).join('\n')}\n\nCheck that these users have started the bot.`
        );
      } catch (e) { console.error('Could not notify tech lead of failures:', e); }
    }
  }

  // --- Reminder loop: check for "later" timeouts every 5 minutes ---

  setInterval(async () => {
    const now = new Date().toISOString();
    const due = db.prepare(`
      SELECT * FROM reviewer_sessions
      WHERE step = 'review_request_confirmation' AND later_remind_at IS NOT NULL AND later_remind_at <= ?
    `).all(now);

    for (const row of due) {
      const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(row.project_id);
      if (!project) continue;
      try {
        await bot.api.sendMessage(
          row.reviewer_user_id,
          `Hi! Just a reminder — the ${project.project_name} peer review is still waiting for you. Reply "yes" to start or "later" to snooze again.`
        );
        // Clear remind_at so it doesn't fire again unless they say "later" again
        db.prepare('UPDATE reviewer_sessions SET later_remind_at = NULL, updated_at = ? WHERE reviewer_user_id = ?')
          .run(nowIso(), row.reviewer_user_id);
      } catch (err) {
        console.error(`Reminder failed for ${row.reviewer_user_id}:`, err);
      }
    }
  }, 5 * 60 * 1000);

  schedulePendingJobs({ sendReviewForProject });

  // --- Commands ---

  bot.command(['start', 'help'], async (ctx) => {
    const userId = ctx.from?.id;
    if (!isTechLead(userId)) return reply(ctx, 'This MVP only accepts project-control commands from the configured tech lead.');
    return reply(ctx, 'Peer Review MVP ready.\n\nCommands:\n- create project\n- start review [project name or number]\n- analyze reviews [project name or number]\n- dashboard [project name or number]\n- status [project name or number]\n- projects');
  });

  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    const lower = text.toLowerCase();

    // Always check reviewer session from DB first
    const reviewState = loadReviewerSession(userId);
    if (reviewState) return handleReview(ctx, reviewState, bot);

    // In-memory create_project state
    const state = sessions.get(userId);
    if (state?.mode === 'create_project') return handleCreateProject(ctx, state);

    if (!isTechLead(userId)) {
      return reply(ctx, 'This MVP is currently limited to the configured tech lead.');
    }

    if (['create project', 'project start', 'start project'].includes(lower)) {
      sessions.set(userId, { mode: 'create_project', step: 'project_setup', answers: {} });
      return reply(ctx, projectSetupPrompt());
    }

    // start review [optional project name/number]
    if (lower.startsWith('start review') || lower.startsWith('send review')) {
      const arg = text.replace(/^(start|send)\s+review\s*/i, '').trim() || null;
      const projects = allProjects();
      if (!projects.length) return reply(ctx, 'No projects found. Send: create project');
      const project = resolveProject(arg);
      if (!project) return reply(ctx, `Project not found.\n\nAvailable:\n${projectListText(projects)}`);
      await sendReviewForProject(project.project_id);
      return reply(ctx, `Review started for ${project.project_name}.`);
    }

    // analyze reviews [optional project name/number]
    if (lower.startsWith('analyze reviews') || lower.startsWith('analyse reviews')) {
      const arg = text.replace(/^analys[ei]s?\s+reviews?\s*/i, '').trim() || null;
      const projects = allProjects();
      if (!projects.length) return reply(ctx, 'No projects found.');
      const project = resolveProject(arg);
      if (!project) return reply(ctx, `Project not found.\n\nAvailable:\n${projectListText(projects)}`);
      const data = analyzeProject(project.project_id);
      return reply(ctx, `Analysis complete.\nDashboard:\n${process.env.BASE_URL}/dashboard/${data.project.project_id}`);
    }

    // dashboard [optional project name/number]
    if (lower.startsWith('dashboard')) {
      const arg = text.replace(/^dashboard\s*/i, '').trim() || null;
      const projects = allProjects();
      if (!projects.length) return reply(ctx, 'No projects found.');
      const project = resolveProject(arg);
      if (!project) return reply(ctx, `Project not found.\n\nAvailable:\n${projectListText(projects)}`);
      return reply(ctx, `Dashboard:\n${process.env.BASE_URL}/dashboard/${project.project_id}`);
    }

    // status [optional project name/number]
    if (lower.startsWith('status')) {
      const arg = text.replace(/^status\s*/i, '').trim() || null;
      const projects = allProjects();
      if (!projects.length) return reply(ctx, 'No projects found.');
      const project = resolveProject(arg);
      if (!project) return reply(ctx, `Project not found.\n\nAvailable:\n${projectListText(projects)}`);
      return reply(ctx, reviewStatusText(project.project_id));
    }

    // list all projects
    if (lower === 'projects') {
      const projects = allProjects();
      if (!projects.length) return reply(ctx, 'No projects found. Send: create project');
      return reply(ctx, `Projects:\n${projectListText(projects)}`);
    }

    return reply(ctx, 'Command not recognized. Send /help for commands.');
  });

  bot.catch((err) => console.error('Telegram bot error:', err));
  bot.start();

  return { bot, sendReviewForProject };
}

// --- Create project ---

async function handleCreateProject(ctx, state) {
  const userId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  if (state.step === 'project_setup') {
    const answers = parseLabeledProjectSetup(text);
    const missing = missingProjectSetupFields(answers);
    if (missing.length) return reply(ctx, `I need these fields: ${missing.join(', ')}.\n\n${projectSetupPrompt()}`);

    const { members, missing: missingMembers, roster } = parseTeamMemberNames(answers.team_members_text);
    if (missingMembers.length) return reply(ctx, `Could not find: ${missingMembers.join(', ')}\n\nAvailable: ${roster.map((m) => m.name).join(', ')}`);
    if (!members) return reply(ctx, 'No matching team members found. Use names from the roster, or send "all".');

    state.answers = { ...answers, team_members: members };
    return createProjectFromAnswers(ctx, state.answers, userId);
  }
}

async function createProjectFromAnswers(ctx, answers, userId) {
  const members = answers.team_members;
  const projectId = makeProjectId(answers.project_name);
  const reviewDates = computeReviewDates(answers.review_cadence, answers.duration);
  const now = nowIso();

  db.prepare(`
    INSERT INTO projects (
      project_id, project_name, owner_user_id, project_brief, project_goals, project_expectations,
      reporting_structure, duration, review_cadence, review_dates_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)
  `).run(
    projectId, answers.project_name, userId, answers.project_brief, '',
    answers.project_expectations, answers.reporting_structure, answers.duration,
    answers.review_cadence, JSON.stringify(reviewDates), now, now
  );

  db.prepare(`
    INSERT INTO project_sensitive_data (project_id, contracts, offers, terms_and_conditions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, answers.contracts || 'none', answers.offers || 'none', answers.terms_and_conditions || 'none', now, now);

  insertTeamMembers(projectId, members);
  createProjectCronJobs(projectId, reviewDates);
  sessions.delete(userId);

  return reply(ctx, `Project created: ${answers.project_name}\n\nTeam:\n${members.map((m) => `- ${m.name} — ${m.role} — ${m.experience_years}y`).join('\n')}\n\nReviews scheduled: ${reviewDates.map(formatScheduledReviewDate).join(', ')}\nDashboard URL:\n${process.env.BASE_URL}/dashboard/${projectId}`);
}

// --- Review flow ---

async function handleReview(ctx, state, bot) {
  const userId = String(ctx.from.id);
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();

  const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(state.projectId);
  const member = state.revieweeUserId
    ? db.prepare('SELECT * FROM team_members WHERE project_id = ? AND telegram_user_id = ?').get(state.projectId, state.revieweeUserId)
    : null;

  if (state.step === 'review_request_confirmation') {
    if (/^(later|no|not now|skip)$/i.test(lower)) {
      const remindAt = new Date(Date.now() + LATER_REMIND_MS).toISOString();
      saveReviewerSession(userId, { ...state, laterRemindAt: remindAt });
      const hours = Math.round(LATER_REMIND_MS / 3600000);
      return reply(ctx, `No problem. I will remind you in ${hours} hour${hours !== 1 ? 's' : ''}.`);
    }
    if (!/^(yes|y|start|ok|sure|ready)$/i.test(lower)) {
      return reply(ctx, 'Please reply "yes" to start the peer review, or "later" to snooze.');
    }
    saveReviewerSession(userId, { ...state, step: 'review_questions', partialAnswers: {} });
    return reply(ctx, reviewQuestionnairePrompt(project, member, {}));
  }

  if (state.step === 'review_questions') {
    if (/^(cancel|stop)$/i.test(lower)) {
      deleteReviewerSession(userId);
      return reply(ctx, 'Review cancelled. You can restart when the next review request is sent.');
    }

    const { answers, errors } = parseReviewQuestionnaire(text);

    if (errors.length) {
      // Merge valid parsed answers with any previously partial answers for pre-fill
      const merged = { ...state.partialAnswers, ...answers };
      saveReviewerSession(userId, { ...state, partialAnswers: merged });
      return reply(ctx, `Please fix the missing/invalid answers:\n${errors.map((e) => `- ${e}`).join('\n')}\n\n${reviewQuestionnairePrompt(project, member, merged)}`);
    }

    const projectContextSnapshot = projectContextForReview(project, member);
    db.prepare(`
      INSERT INTO responses (
        project_id, review_session_id, reviewer_user_id, reviewee_user_id,
        communication_score, execution_score, collaboration_score, strengths, improvements,
        feedback_json, project_context_snapshot, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.projectId, state.reviewSessionId, userId, state.revieweeUserId,
      answers.communication_score, answers.execution_score, answers.collaboration_score,
      answers.strengths, answers.improvements,
      JSON.stringify(answers), projectContextSnapshot, nowIso()
    );

    const remaining = (state.reviewQueue || []).filter((id) => id !== state.revieweeUserId);
    const nextId = remaining[0];
    if (nextId) {
      const nextMember = db.prepare('SELECT * FROM team_members WHERE project_id = ? AND telegram_user_id = ?').get(state.projectId, nextId);
      saveReviewerSession(userId, { ...state, step: 'review_questions', reviewQueue: remaining, revieweeUserId: nextId, partialAnswers: {} });
      return reply(ctx, `Review submitted. Next teammate:\n\n${reviewQuestionnairePrompt(project, nextMember, {})}`);
    }

    deleteReviewerSession(userId);
    return reply(ctx, 'All reviews submitted. Thank you!');
  }
}
