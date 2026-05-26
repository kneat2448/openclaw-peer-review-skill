#!/usr/bin/env bash
set -euo pipefail

fail() { echo "SECURITY CHECK FAILED: $*" >&2; exit 1; }
warn() { echo "WARN: $*" >&2; }

# Files that must never be committed
for f in .env data/peer_review.db data/peer_review.db-wal data/peer_review.db-shm; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    fail "$f is tracked by git"
  fi
done

# Ensure ignore rules exist
for pattern in ".env" "node_modules/" "data/*.db" "data/*.db-wal" "data/*.db-shm" "dashboard/public/data/*.json" "logs/"; do
  grep -qxF "$pattern" .gitignore || fail ".gitignore missing: $pattern"
done

# Scan staged/tracked source-like files for likely secrets.
files=$(git ls-files --cached --others --exclude-standard \
  ':!:node_modules/**' ':!:data/*.db' ':!:data/*.db-wal' ':!:data/*.db-shm' ':!:.env' 2>/dev/null || true)

if [ -n "$files" ]; then
  # Telegram bot tokens look like 123456789:AA...
  if grep -RInE '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' $files 2>/dev/null; then
    fail "possible Telegram bot token found"
  fi
  # Flag obvious non-placeholder env secret assignments. Allow examples like ***, replace_me, your_xxx, http://localhost.
  if grep -RInE '(TELEGRAM_BOT_TOKEN|BOT_TOKEN|API_KEY|SECRET|PASSWORD)=[^[:space:]]+' $files 2>/dev/null \
    | grep -Ev '=\*\*\*|=replace_me|=your_|=http://localhost|=https://your-|=example|=xxx|=REPLACE_ME'; then
    fail "possible env secret assignment found"
  fi
fi

# Validate sample env does not contain a real-looking token.
if [ -f .env.example ] && grep -Eq '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' .env.example; then
  fail ".env.example contains real-looking Telegram token"
fi

# Basic syntax checks.
node --check src/bot.js >/dev/null
node --check src/server.js >/dev/null

echo "Security check passed."
