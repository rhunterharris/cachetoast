import test from 'node:test';
import assert from 'node:assert/strict';
import { policy, evaluate, holdNotice, statusText } from '../lib/policy.mjs';

test('cache TTLs derive idle deadlines and reject invalid policies', () => {
  assert.equal(policy({ cacheTtl: '5m' }).idleMs, 240_000);
  assert.equal(policy({ cacheTtl: '30m' }).idleMs, 1_500_000);
  assert.equal(policy({ cacheTtl: '1h' }).idleMs, 3_300_000);
  assert.equal(policy().idleMs, 1_500_000);
  assert.throws(() => policy({ targetTokens: -1 }));
  assert.throws(() => policy({ cacheTtl: 'invented' })); assert.throws(() => policy({ cacheTtl: 'unknown' }));
});
test('idle cutoff, TTL, minimum context, and unknown size are distinct', () => {
  const p = policy({ cacheTtl: '30m' });
  const session = { lastActivity: 1000, contextTokens: 150_000 };
  assert.equal(evaluate(session, p, 1500999).action, 'wait');
  assert.equal(evaluate(session, p, 1501000).action, 'handoff');
  assert.equal(evaluate({ ...session, contextTokens: 99_999 }, p, 9999999).action, 'wait');
  assert.equal(evaluate({ ...session, contextTokens: null }, p, 9999999).action, 'wait');
  assert.equal(evaluate({ lastActivity: null, contextTokens: 150_000 }, p, 9999999).action, 'wait');
});
test('status text counts down, then reads cold; small sessions show nothing', () => {
  const p = policy({ cacheTtl: '30m' }), s = { lastActivity: 0, contextTokens: 180_000 };
  assert.equal(statusText(s, p, 60_000), 'cache warm 24m · 180k');
  assert.equal(statusText(s, p, 25 * 60_000), 'cache cold · 180k');
  assert.equal(statusText({ ...s, contextTokens: 50_000 }, p, 0), null);
});
test('notice states size, idle time, and TTL', () => {
  const notice = holdNotice({ contextTokens: 180_000, idleForMs: 25 * 60_000, cacheTtl: '30m' }, 'NEXT');
  assert.match(notice, /^Cachetoast held this prompt!\n\nThis ~180k-token session has been idle 25 min with a 30m cache TTL, so/); assert.match(notice, /\nNEXT$/);
});
