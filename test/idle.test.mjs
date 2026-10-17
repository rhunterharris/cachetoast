import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIdleCompactor } from '../lib/idle.mjs';
import { policy } from '../lib/policy.mjs';
import { install } from '../lib/install.mjs';
import { handleHook, idleState, recordIdle } from '../lib/runtime.mjs';
import piExtension from '../lib/pi-extension.mjs';
import { spawnSync } from 'node:child_process';

// A deterministic host clock, including a suspended process that wakes after expiry.
function clock() {
  let time = 10_000;
  const timers = new Set();
  return {
    now: () => time,
    after(ms, fn) { const task = { at: time + ms, fn, cancel: () => timers.delete(task) }; timers.add(task); return task; },
    pending: () => timers.size,
    async advance(ms) { time += ms; for (const t of [...timers]) if (t.at <= time) { timers.delete(t); await t.fn(); } }
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetoast-idle test $-'));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, 'user');
  t.after(() => { if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); });
  install(root);
  return root;
}
function harness(ttl = '5m', overrides = {}) {
  const c = clock(), errors = [];
  let calls = 0, s = { activityId: 1, lastActivity: c.now(), contextTokens: 150_000, p: policy({ cacheTtl: ttl }) };
  const idle = createIdleCompactor({
    read: () => s,
    record: (snapshot, status) => {
      if (snapshot.activityId !== s.activityId) return false;
      s.compaction = { activityId: s.activityId, status }; return true;
    },
    compact: async () => { calls++; return {}; }, now: c.now, after: c.after, onError: error => errors.push(error), ...overrides
  });
  return { c, idle, errors, get state() { return s; }, set state(value) { s = value; }, calls: () => calls };
}

for (const [ttl, minutes] of [['5m', 4], ['30m', 25], ['1h', 55]]) {
  test(`${ttl} cache compacts at ${minutes} minutes and only once in an idle cycle`, async () => {
    const h = harness(ttl);
    await h.idle.arm();
    await h.c.advance(minutes * 60_000 - 1); assert.equal(h.calls(), 0);
    await h.c.advance(1); assert.equal(h.calls(), 1);
    assert.equal(h.state.compaction.status, 'succeeded');
    await h.idle.arm(); assert.equal(h.c.pending(), 0);
    h.state = { ...h.state, activityId: 2, lastActivity: h.c.now() };
    await h.idle.arm(); await h.c.advance(minutes * 60_000); assert.equal(h.calls(), 2);
  });
}
test('cancel, small/unknown contexts, activity changes, and sleep past expiry do not compact', async () => {
  const h = harness();
  await h.idle.arm(); h.idle.cancel(); await h.c.advance(240_000); assert.equal(h.calls(), 0);
  for (const tokens of [99_999, null, undefined]) {
    h.state = { ...h.state, lastActivity: h.c.now(), contextTokens: tokens };
    await h.idle.arm(); assert.equal(h.c.pending(), 0);
  }
  h.state = { ...h.state, lastActivity: h.c.now(), contextTokens: 150_000 };
  await h.idle.arm(); h.state = { ...h.state, activityId: 2 }; await h.c.advance(240_000); assert.equal(h.calls(), 0);
  h.state = { ...h.state, lastActivity: h.c.now() };
  await h.idle.arm(); await h.c.advance(300_000); assert.equal(h.calls(), 0);
  await h.idle.arm(); assert.equal(h.c.pending(), 0);
});
test('warm resume uses the remaining delay; failed and skipped attempts do not loop', async () => {
  for (const compact of [async () => ({ skip: 'busy' }), async () => { throw new Error('offline'); }]) {
    const h = harness('5m', { compact });
    await h.c.advance(180_000); await h.idle.arm();
    await h.c.advance(59_999); assert.equal(h.state.compaction, undefined);
    await h.c.advance(1); assert.ok(['skipped', 'failed'].includes(h.state.compaction.status));
    await h.idle.arm(); assert.equal(h.c.pending(), 0);
  }
});
test('cancel while reading asynchronously cannot resurrect a timer', async () => {
  let release;
  const h = harness('5m', { read: () => new Promise(resolve => { release = resolve; }) });
  const arming = h.idle.arm(); h.idle.cancel(); release(h.state); await arming;
  assert.equal(h.c.pending(), 0);
});
test('compaction success bypasses the handoff for this cycle; failures preserve it and stale results cannot replace new work', t => {
  const root = fixture(t);
  let now = 1_000_000;
  const hook = (provider, event, time) => handleHook(root, provider, { session_id: 's', hook_event_name: event, context_tokens: 150_000, cache_ttl_guess: '5m' }, { now: time });
  for (const status of ['succeeded', 'skipped', 'failed', 'attempting']) {
    hook('pi', 'Stop', now);
    const s = idleState(root, 'pi', 's');
    assert.equal(recordIdle(root, 'pi', 's', { ...s, status, tokensAfter: 120_000 }, { now: now + 240_000 }), true);
    const out = hook('pi', 'UserPromptSubmit', now + 400_000);
    assert.equal(out.decision, status === 'succeeded' ? undefined : 'block');
    hook('pi', 'Stop', now + 500_000);
    assert.equal(recordIdle(root, 'pi', 's', { ...s, status: 'succeeded' }), false);
    assert.equal(hook('pi', 'UserPromptSubmit', now + 900_000).decision, 'block');
    now += 1_000_000;
  }
});
test('installed Claude module runs native compaction, cancels on input, and records success', async t => {
  const root = fixture(t), c = clock(), on = {}, logs = [];
  const file = path.join(root, '.claude/skills/cachetoast-idle/hooks/register.mjs');
  const { register } = await import(pathToFileURL(file));
  let calls = 0;
  const $ = {
    session: { id: async () => 'claude-test', cwd: async () => root, compact: async () => { calls++; return { tokensAfter: 120_000 }; } },
    fs: { exists: async p => fs.existsSync(p) }, clock: c,
    ui: { log: text => logs.push(text) },
    process: { run: async (argv, options) => {
      assert.deepEqual(argv.slice(0, 2), ['node', path.join(root, '.cachetoast/runtime/bin/cachetoast.mjs')]);
      const input = JSON.parse(options.stdin);
      const out = input.status ? recordIdle(root, 'claude', input.session_id, input, { now: c.now() }) : idleState(root, 'claude', input.session_id);
      return { exitCode: 0, stdout: JSON.stringify(out) };
    } }
  };
  register((name, fn) => { on[name] = fn; });
  const stop = () => on['classic.Stop']($, {}, async () => {
    handleHook(root, 'claude', { session_id: 'claude-test', hook_event_name: 'Stop', context_tokens: 150_000, cache_ttl_guess: '5m' }, { now: c.now() });
    return {};
  });
  await stop(); assert.equal(c.pending(), 1);
  on['classic.UserPromptSubmit']($, {}, () => ({})); assert.equal(c.pending(), 0);
  await stop(); await c.advance(240_000); assert.equal(calls, 1);
  assert.equal(idleState(root, 'claude', 'claude-test').compaction.status, 'succeeded');
  await on['classic.SessionStart']($, {}, async () => ({})); assert.equal(c.pending(), 0);
  assert.deepEqual(logs, []);
});
test('Pi timer uses native compaction without repeating on its own settled event; busy sessions retain fallback', async t => {
  const root = fixture(t), on = {}, notices = [];
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let calls = 0, pending = false;
  const ctx = {
    cwd: root, model: { provider: 'anthropic', id: 'claude' },
    sessionManager: { getSessionId: () => 'pi-timer' },
    getContextUsage: () => ({ tokens: 150_000 }), isIdle: () => true, hasPendingMessages: () => pending,
    compact: options => { calls++; options.onComplete(); },
    ui: { notify: text => notices.push(text), setStatus() {}, setEditorText() {} }
  };
  piExtension({ on: (name, handler) => { on[name] = handler; }, registerCommand() {} });
  on.agent_settled({}, ctx); await flush();
  t.mock.timers.tick(239_999); await flush(); assert.equal(calls, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 1);
  const success = idleState(root, 'pi', 'pi-timer');
  assert.equal(success.compaction.status, 'succeeded');
  on.agent_settled({}, ctx); await flush();
  assert.equal(idleState(root, 'pi', 'pi-timer').activityId, success.activityId);
  assert.deepEqual(on.input({ text: 'Continue', source: 'interactive' }, ctx), { action: 'continue' });
  on.agent_settled({}, ctx); await flush(); pending = true;
  t.mock.timers.tick(240_000); await flush(); assert.equal(calls, 1);
  pending = false;
  assert.deepEqual(on.input({ text: 'Continue', source: 'interactive' }, ctx), { action: 'handled' });
  assert.equal(notices.length, 1);
  on.session_shutdown();
});
test('copied internal idle CLI records only matching session activity', t => {
  const root = fixture(t);
  handleHook(root, 'claude', { session_id: 'cli', hook_event_name: 'Stop', context_tokens: 150_000 });
  const run = input => {
    const out = spawnSync(process.execPath, [path.join(root, '.cachetoast/runtime/bin/cachetoast.mjs'), 'idle', '--provider', 'claude', '--repo', root], { input: JSON.stringify({ session_id: 'cli', ...input }), encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout);
  };
  const state = run({}); assert.equal(state.p.idleMs, 1_500_000);
  assert.equal(run({ activityId: state.activityId, lastActivity: state.lastActivity, status: 'succeeded' }), true);
  assert.equal(run({ activityId: state.activityId - 1, lastActivity: state.lastActivity, status: 'succeeded' }), false);
});
