#!/usr/bin/env bash
set -euo pipefail
echo "--- env check ---"
node scripts/check-env.js
echo "--- syntax check ---"
node --check src/bot.js
node --check src/server.js
echo "--- cadence tests ---"
npm run test:cadence
echo "--- dashboard tests ---"
npm run test:dashboard
echo "--- smoke test ---"
npm run smoke
echo ""
echo "All checks passed."
