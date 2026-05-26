import dotenv from 'dotenv';
dotenv.config({ override: true });

// Fail fast on missing required env vars
const _requiredEnv = ['TELEGRAM_BOT_TOKEN', 'TECH_LEAD_USER_ID', 'BASE_URL'];
const _missingEnv = _requiredEnv.filter((k) => !process.env[k]);
if (_missingEnv.length) {
  console.error(`Missing required env vars: ${_missingEnv.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values, then restart.');
  process.exit(1);
}

import express from 'express';
import { createBot } from './bot.js';
import { getDashboardData } from './analysis.js';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use('/static', express.static('dashboard/public'));

app.get('/api/dashboard/:projectId', (req, res) => {
  const data = getDashboardData(req.params.projectId);
  if (!data) return res.status(404).json({ error: 'project_not_found' });
  res.json(data);
});

app.get('/dashboard/:projectId', (_req, res) => {
  res.sendFile(process.cwd() + '/dashboard/index.html');
});

app.get('/', (_req, res) => {
  res.type('text').send('Peer Review MVP running. Open /dashboard/<project_id>.');
});

app.listen(port, () => {
  console.log(`Dashboard server listening on http://localhost:${port}`);
});

createBot();
console.log('Telegram bot polling started.');
