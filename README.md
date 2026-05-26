# OpenClaw Telegram Peer Review Skill

Telegram-native peer review MVP for OpenClaw. It collects project setup in one Telegram message, sends peer review questionnaires to team members, stores responses in SQLite, analyzes feedback, and serves a custom dashboard.

## What this repo contains

```text
src/
  bot.js          Telegram bot workflow and review session handling
  db.js           SQLite schema and migrations
  analysis.js     Score/risk/summary generation and dashboard JSON output
  scheduler.js    Scheduled review job runner
  server.js       Express dashboard server + bot bootstrap
scripts/
  check-env.js    Required environment variable validation
  smoke-test.js   End-to-end local smoke test
  test-cadence.js Review-date scheduling tests
  test-dashboard-team.js Dashboard/analysis integration test
  security-check.sh Pre-commit security/artifact scanner
dashboard/
  index.html      Dashboard frontend
data/
  company_profile.example.json Example company onboarding profile
  team_members.json Example roster; bot onboarding rewrites this locally
skills/
  peer-review-telegram/ OpenClaw skill package and migration docs
```

## Features

- One-message project creation flow in Telegram.
- First-run Telegram onboarding for company profile and team roster setup.
- One-message 15-question review questionnaire per reviewee.
- SQLite persistence for projects, schedules, responses, results, reviewer sessions, and send logs.
- Persistent reviewer state: reviewers can resume after process restarts.
- Per-reviewer send failure logging and tech-lead notification.
- Multi-project command targeting by project name or list number.
- Partial answer preservation when questionnaire validation fails.
- `later` snooze reminders for reviewers.
- Per-member status command.
- Score parsing for `8`, `7.5`, `8/10`, `8 out of 10`.
- Dashboard output with sensitive data excluded.
- OpenClaw skill instructions under `skills/peer-review-telegram/`.

## Requirements

- Node.js 20+
- npm
- Telegram bot token from BotFather
- Telegram numeric user ID for the tech lead
- A public URL for dashboard links if sharing outside localhost

## Quick start

```bash
npm install
cp .env.example .env
node scripts/check-env.js
npm start
```

Open:

```text
http://localhost:3000/
```

## Environment variables

Copy `.env.example` to `.env` and fill values:

```env
TELEGRAM_BOT_TOKEN=replace_me
TECH_LEAD_USER_ID=replace_me
PORT=3000
BASE_URL=http://localhost:3000
DB_PATH=./data/peer_review.db
APP_TIME_ZONE=Asia/Kolkata
LATER_REMIND_MS=14400000
```

Never commit `.env`.

## Team roster

On first `/start`, the configured tech lead is asked for company and team information.
The onboarding reply writes:

- `data/company_profile.json` for local company/team defaults
- `data/team_members.json` for the reusable roster

You can rerun onboarding any time in Telegram:

```text
setup company
```

Manual roster format in `data/team_members.json`:

```json
[
  {
    "name": "Nitai",
    "role": "Intern",
    "experience_years": 0,
    "telegram_user_id": "123456789"
  }
]
```

Every team member needs a numeric `telegram_user_id`. Each reviewer must open the Telegram bot and send `/start` once before the bot can DM them. The bot only responds to the configured tech lead and saved team-member Telegram IDs.

## Telegram commands

Only `TECH_LEAD_USER_ID` can use project-control commands.
Team members can only use `/start` or respond to review prompts.

```text
/start
create project
setup company
company profile
projects
start review [project name or number]
status [project name or number]
analyze reviews [project name or number]
dashboard [project name or number]
```

If no project argument is provided, the latest project is used.

## Review flow

1. Tech lead sends `/start` and completes company/team onboarding if needed.
2. Tech lead sends `create project`.
3. Bot replies with a project setup template using the saved company/team defaults.
4. Tech lead fills all fields in one message.
5. Review dates are computed from duration + cadence.
6. At schedule time, or when tech lead sends `start review`, reviewers receive a DM.
7. Reviewer replies `yes` to start or `later` to snooze.
8. Reviewer gets a 15-question numbered questionnaire for each teammate.
9. Reviewer replies once with answers `1:` through `15:`.
10. Bot validates answers, stores them, and moves to the next teammate.
11. Tech lead runs `analyze reviews`.
12. Dashboard URL is returned.

## Dashboard

Local dashboard URL:

```text
http://localhost:3000/dashboard/<project_id>
```

Set `BASE_URL` to a public tunnel/domain to share links:

```bash
npx localtunnel --port 3000
# or
ngrok http 3000
```

## Scheduled reviews

Scheduled review timing is owned by the running Node process. When OpenClaw deploys this skill, start the app as a persistent process so `src/scheduler.js` can load `cron_jobs`, run due reviews, and reconcile missed jobs every minute:

```bash
pm2 start ecosystem.config.cjs
```

Do not rely on a one-off `npm start` command for scheduled production reviews unless the terminal will stay open.

## Validation

Run before committing/deploying:

```bash
node scripts/check-env.js
node --check src/bot.js
node --check src/server.js
npm run test:cadence
npm run test:onboarding
npm run test:dashboard
npm run smoke
bash scripts/security-check.sh
```

Or use the skill helper:

```bash
bash skills/peer-review-telegram/scripts/validate-app.sh
```

## Persistent deployment with pm2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Useful commands:

```bash
pm2 logs peer-review-bot
pm2 restart peer-review-bot
pm2 stop peer-review-bot
```

## OpenClaw skill usage

The OpenClaw skill package is here:

```text
skills/peer-review-telegram/
```

It includes:

- `SKILL.md` — trigger/workflow summary
- `references/setup.md` — migration, setup, GitHub, and troubleshooting instructions
- `scripts/validate-app.sh` — app validation helper

For OpenClaw subagent handoff, also read:

- `subagent.manifest.json` - machine-readable OpenClaw subagent contract
- `references/subagent.md` - human-readable OpenClaw subagent runbook

To migrate this feature into another OpenClaw instance, copy or clone this repo, then ensure `skills/peer-review-telegram/` is present in the workspace.

## Security and privacy

- `.env` is ignored and must never be committed.
- `data/company_profile.json` is ignored because it contains local company/team setup.
- SQLite DB files are ignored by default.
- Generated dashboard JSON is ignored by default.
- Sensitive project setup fields are stored in `project_sensitive_data` and excluded from dashboard output.
- Reviewer identities are not shown on the dashboard.
- Run `bash scripts/security-check.sh` before every commit.

## Troubleshooting

### Bot is not responding

```bash
ps -ef | grep 'node src/server.js' | grep -v grep
node scripts/check-env.js
```

Check Telegram token:

```bash
node --input-type=module - <<'NODE'
import dotenv from 'dotenv'; dotenv.config({ override: true });
const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
console.log(r.status, await r.text());
NODE
```

Common causes:

- Wrong `TECH_LEAD_USER_ID`.
- Another poller is using the same bot token.
- Reviewer has not opened the bot first.
- Process died; use pm2 for persistence.

### Inspect send failures

```bash
node --input-type=module - <<'NODE'
import dotenv from 'dotenv'; dotenv.config({ override: true });
import Database from 'better-sqlite3';
const db = new Database(process.env.DB_PATH || './data/peer_review.db');
console.table(db.prepare('SELECT * FROM review_send_log ORDER BY sent_at DESC LIMIT 20').all());
NODE
```

### Inspect active reviewer sessions

```bash
node --input-type=module - <<'NODE'
import dotenv from 'dotenv'; dotenv.config({ override: true });
import Database from 'better-sqlite3';
const db = new Database(process.env.DB_PATH || './data/peer_review.db');
console.table(db.prepare('SELECT reviewer_user_id, project_id, step, updated_at FROM reviewer_sessions').all());
NODE
```

## License

Private/internal MVP unless a license is added.
