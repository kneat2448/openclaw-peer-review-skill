import dotenv from 'dotenv';
dotenv.config({ override: true });

const required = [
  ['TELEGRAM_BOT_TOKEN', 'Bot token from BotFather'],
  ['TECH_LEAD_USER_ID', 'Your Telegram user ID (numbers only)'],
  ['BASE_URL', 'Public URL for dashboard links, e.g. https://your-domain.com'],
];

const optional = [
  ['PORT', '3000'],
  ['DB_PATH', './data/peer_review.db'],
  ['APP_TIME_ZONE', 'Asia/Kolkata'],
];

let hasError = false;

for (const [key, hint] of required) {
  if (!process.env[key]) {
    console.error(`MISSING: ${key} — ${hint}`);
    hasError = true;
  }
}

for (const [key, defaultVal] of optional) {
  if (!process.env[key]) {
    console.warn(`OPTIONAL not set: ${key} (default: ${defaultVal})`);
  }
}

if (hasError) {
  console.error('\nFix the above in your .env file before starting.');
  process.exit(1);
}

console.log('Env check passed.');
