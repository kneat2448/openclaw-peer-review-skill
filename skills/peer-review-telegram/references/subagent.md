# OpenClaw Subagent Runbook

Use this file when the main OpenClaw agent needs to delegate peer-review bot operations to a focused subagent.

## Subagent role

The subagent is responsible for operating the Telegram peer-review app in this workspace:

- install Node dependencies
- configure `.env`
- run company/team onboarding
- keep the bot and dashboard process alive
- verify scheduled reviews are active
- debug Telegram delivery, SQLite state, and dashboard output
- run validation before code or config handoff

The subagent should read `skills/peer-review-telegram/subagent.manifest.json` for machine-readable entrypoints, then use this runbook for operational judgment.

## Startup contract

1. Confirm dependencies:

```bash
npm install
```

2. Confirm required env vars:

```bash
node scripts/check-env.js
```

3. Start the production process through PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

4. Check logs and health:

```bash
pm2 logs peer-review-bot
curl -fsS http://localhost:${PORT:-3000}/
```

Use `npm start` only for a foreground/local debug run. Scheduled reviews require a long-running process.

## Scheduling responsibility

The OpenClaw agent should keep this service alive rather than creating a separate OS cron for each review.

`src/scheduler.js` does the review timing inside the app:

- scheduled dates are stored in SQLite table `cron_jobs`
- future jobs are loaded when the app starts
- due jobs are reconciled every minute
- missed jobs run after restart if still marked `scheduled`

The correct OpenClaw behavior is:

```bash
pm2 start ecosystem.config.cjs
pm2 restart peer-review-bot
pm2 logs peer-review-bot
```

Only add an external cron if the host environment cannot keep PM2 alive. In that case, the external cron should restart/check the app process, not duplicate individual review jobs.

## Access model

The bot must only communicate with:

- `TECH_LEAD_USER_ID`
- team members listed in `data/team_members.json`

Onboarding requires numeric Telegram IDs for every team member. Unknown Telegram users should not receive project-control responses.

Team members must open the bot and send `/start` once before Telegram allows the bot to DM them.

## Onboarding flow

If company/team setup is missing, the tech lead sends `/start` or any normal message and receives the onboarding template.

The onboarding response writes:

- `data/company_profile.json`
- `data/team_members.json`

To rerun onboarding:

```text
setup company
```

To inspect saved setup:

```text
company profile
```

## Validation

Run these before handoff:

```bash
node --check src/bot.js
node --check src/server.js
npm run test:cadence
npm run test:onboarding
npm run test:dashboard
npm run smoke
npm audit --audit-level=moderate
bash scripts/security-check.sh
```

If `.env` is configured, the combined helper is:

```bash
bash skills/peer-review-telegram/scripts/validate-app.sh
```

## Troubleshooting checklist

Bot not responding:

- confirm PM2 process is running
- confirm only one process is polling the Telegram token
- confirm `TECH_LEAD_USER_ID` matches the sender
- check `pm2 logs peer-review-bot`

Reviews not reaching members:

- confirm every roster member has a numeric `telegram_user_id`
- ask each member to send `/start` to the bot
- inspect `review_send_log`

Scheduled reviews not firing:

- confirm `pm2 status peer-review-bot`
- confirm system time and `APP_TIME_ZONE`
- inspect SQLite `cron_jobs`
- restart PM2 so `schedulePendingJobs` reloads due jobs

Dashboard missing data:

- run `analyze reviews [project]` in Telegram
- check `/api/dashboard/<project_id>`
- inspect `results` and `responses` tables

## Handoff summary

At the end of a subagent run, report:

- process status
- health check result
- validation commands run
- current dashboard URL if a project exists
- any Telegram send failures or missing member setup
