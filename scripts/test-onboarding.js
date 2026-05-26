import assert from 'node:assert/strict';
import { parseOnboardingSetup } from '../src/bot.js';

const input = `
Company name: Acme Labs
Industry: SaaS
Company size: 10-50
Team name: Platform
Default review cadence: halfway and end
Team members:
- Asha Rao | SDE 2 | 3 | 123456789 | Backend delivery and code reviews
- Karan Mehta | Operations | 4 | 987654321 | Release coordination
`;

const parsed = parseOnboardingSetup(input);

assert.deepEqual(parsed.errors, []);
assert.equal(parsed.profile.company_name, 'Acme Labs');
assert.equal(parsed.profile.team_name, 'Platform');
assert.equal(parsed.profile.default_review_cadence, 'halfway and end');
assert.equal(parsed.members.length, 2);
assert.equal(parsed.members[0].telegram_user_id, '123456789');
assert.equal(parsed.members[1].telegram_user_id, '987654321');
assert.equal(parsed.members[1].expected_responsibilities, 'Release coordination');

const invalid = parseOnboardingSetup('Company name: Missing Team');
assert.ok(invalid.errors.includes('Industry'));
assert.ok(invalid.errors.includes('Team name'));
assert.ok(invalid.errors.includes('Team members'));

const missingTelegramId = parseOnboardingSetup(`
Company name: Acme Labs
Industry: SaaS
Team name: Platform
Team members:
- No Id | SDE 1 | 2 | | Delivery
`);
assert.ok(missingTelegramId.errors.some((error) => error.includes('Telegram user ID must be numeric')));

console.log('Onboarding tests passed');
