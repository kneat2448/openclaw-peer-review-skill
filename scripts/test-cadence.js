import assert from 'node:assert/strict';
import { computeReviewDates } from '../src/bot.js';

const start = new Date('2026-01-01T00:00:00.000Z');
const daysFromStart = (iso) => Math.round((new Date(iso) - start) / 86400000);
const offsets = (cadence, duration) => computeReviewDates(cadence, duration, start).map(daysFromStart);

assert.deepEqual(offsets('halfway and end', '10 days'), [5, 10]);
assert.deepEqual(offsets('halfway and end', '2 months'), [30, 60]);
assert.deepEqual(offsets('weekly', '3 weeks'), [7, 14, 21]);
assert.deepEqual(offsets('biweekly', '6 weeks'), [14, 28, 42]);
assert.deepEqual(offsets('monthly', '3 months'), [30, 60, 90]);
assert.deepEqual(offsets('end', '45 days'), [45]);
assert.deepEqual(offsets('now', '6 months'), [0]);
assert.deepEqual(offsets('every 10 days', '1 month'), [10, 20, 30]);

console.log('Cadence tests passed');
