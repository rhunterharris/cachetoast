import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { install, update, uninstall, detectProviders } from '../lib/install.mjs';
import { handleHook, handoffName, handoffPrompt, configAt, policyFor, ttlChoice, statePath } from '../lib/runtime.mjs';
import { hash, keyFor, readJson, safePath, atomicWrite } from '../lib/storage.mjs';
import { readTranscript } from '../lib/transcript.mjs';

// Each test gets its own user config so TTLs never leak between tests or from the real home directory.
test.beforeEach(() => { process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetoast-user-')); });
test.afterEach(() => { fs.rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true }); });
const fixture = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetoast test $ space-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
// Synthetic transcript reporting a context size and model-response time; Claude records also report a cache write's TTL.
const transcript = (root, provider, tokens, at = 0, text = 'Parser added. Still need tests.', ttl) => {
  const cache_creation = ttl && { [`ephemeral_${ttl}_input_tokens`]: 1000 };
  const record = provider === 'claude'
    ? { type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: text, usage: { input_tokens: tokens, cache_creation } } }
    : { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { total_tokens: tokens } } } };
  write(root, `${provider}.jsonl`, JSON.stringify(record) + '\n');
  return path.join(root, `${provider}.jsonl`);
};
const hook = (root, provider, event, now, extra = {}) => handleHook(root, provider, { session_id: 's1', cwd: root, hook_event_name: event, ...extra }, { now });
const runCli = (root, args, input, cwd = root) => spawnSync(process.execPath, [path.join(root, '.cachetoast/runtime/bin/cachetoast.mjs'), ...args], { cwd, input, encoding: 'utf8' });

test('bootstrap merges, is idempotent, preserves earlier limits, and restores original bytes', t => {
  const root = fixture(t);
  const claude = JSON.stringify({ autoCompactEnabled: false, permissions: { allow: ['Read'] }, env: { OTHER: 'yes', DISABLE_AUTO_COMPACT: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo kept' }] }] } });
  const toml = 'model_auto_compact_token_limit = 180_000\nmodel_auto_compact_token_limit_scope = "body_after_prefix"\n[model_providers.custom]\nmodel_auto_compact_token_limit = 900000\n';
  write(root, '.claude/settings.json', claude); write(root, '.codex/config.toml', toml); write(root, 'AGENTS.md', 'Original instructions\n');
  install(root); assert.equal(install(root).changed.length, 0);
  const settings = readJson(path.join(root, '.claude/settings.json'));
  assert.equal(settings.env.OTHER, 'yes'); assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000');
  assert.equal(settings.autoCompactEnabled, true); assert.equal(settings.env.DISABLE_AUTO_COMPACT, '0');
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['Stop', 'UserPromptSubmit']);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Original instructions\n');
  const config = fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8');
  assert.match(config, /model_auto_compact_token_limit_scope = "total"/); assert.match(config, /^model_auto_compact_token_limit = 180000/);
  const command = fs.readFileSync(path.join(root, '.claude/commands/cachetoast-handoff.md'), 'utf8');
  assert.match(command, /Requested session key: \$ARGUMENTS/);
  assert.match(command, /handoff --key KEY/); assert.match(command, /handoff --provider claude/);
  assert.match(command, /\/rename CT - <subject>/);
  assert.doesNotMatch(command, /!`/);
  const skill = fs.readFileSync(path.join(root, '.agents/skills/cachetoast-handoff/SKILL.md'), 'utf8');
  assert.match(skill, /handoff --key KEY/); assert.match(skill, /handoff --provider codex/);
  assert.match(skill, /set_thread_title/); assert.match(skill, /without a thread ID/);
  hook(root, 'claude', 'UserPromptSubmit', 0, { prompt: 'Leaves state behind' });
  uninstall(root);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.claude', '.codex', 'AGENTS.md']);
  assert.deepEqual(fs.readdirSync(path.join(root, '.codex')).sort(), ['config.toml']);
  assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), claude);
  assert.equal(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8'), toml);
});
test('reinstall replaces hooks from older versions and keeps unrelated ones', t => {
  const root = fixture(t);
  const old = { type: 'command', command: `node -e '...p.join(r,".cachetoast/runtime/bin/cachetoast.mjs")...'` };
  write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [old] }], Stop: [{ hooks: [old, { type: 'command', command: 'echo kept' }] }] } }));
  install(root, { providers: ['codex'] });
  const hooks = readJson(path.join(root, '.codex/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['Stop', 'UserPromptSubmit']);
  assert.deepEqual(hooks.Stop[0].hooks, [{ type: 'command', command: 'echo kept' }]);
  assert.equal(hooks.Stop.length, 2);
});
test('dry-run and malformed settings never partially mutate a repo', t => {
  const root = fixture(t); install(root, { dryRun: true }); assert.deepEqual(fs.readdirSync(root), []);
  write(root, '.codex/hooks.json', 'not JSON');
  assert.throws(() => install(root)); assert.equal(fs.existsSync(path.join(root, '.claude/settings.json')), false);
});
test('TTL overrides are set once per user, shared by repos, and overridable per repo', t => {
  const root = fixture(t), other = fixture(t);
  install(root, { cacheTtl: { claude: '1h', pi: '30m' }, targetTokens: 200000, minContextTokens: 50000 });
  assert.equal(install(root).changed.length, 0);
  const committed = readJson(path.join(root, '.cachetoast/config.json'));
  assert.equal(JSON.stringify(committed).includes('cacheTtl'), false);
  assert.equal(fs.existsSync(path.join(root, '.cachetoast/local.json')), false);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.cachetoast\/local\.json$/m);
  const c = configAt(root);
  assert.equal(policyFor(c, 'pi').idleMs, 1_500_000);
  assert.equal(policyFor(c, 'claude').targetTokens, 200000); assert.equal(policyFor(c, 'codex').minContextTokens, 50000);
  // Observed beats configured beats guessed.
  assert.deepEqual(ttlChoice(c, 'claude', { observedTtl: '5m' }), { cacheTtl: '5m', ttlSource: 'observed' });
  assert.deepEqual(ttlChoice(c, 'pi', { guessedTtl: '1h' }), { cacheTtl: '30m', ttlSource: 'configured' });
  assert.deepEqual(ttlChoice(c, 'codex'), { cacheTtl: '30m', ttlSource: 'guessed' });
  // A second repo installs with no TTL flags and inherits them.
  install(other);
  assert.equal(configAt(other).ttl.claude, '1h'); assert.equal(configAt(other).ttl.codex, undefined);
  write(other, '.cachetoast/local.json', JSON.stringify({ claude: { cacheTtl: '5m' } }));
  assert.equal(configAt(other).ttl.claude, '5m'); assert.equal(configAt(root).ttl.claude, '1h');
  const before = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'cachetoast/config.json'), 'utf8');
  assert.throws(() => install(root, { cacheTtl: { pi: '2h' } }), /Unknown cache TTL/);
  assert.equal(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'cachetoast/config.json'), 'utf8'), before);
});
test('init detects installed agents and asks nothing', t => {
  const home = fixture(t), bin = fixture(t);
  write(bin, 'codex', '#!/bin/sh\n'); fs.chmodSync(path.join(bin, 'codex'), 0o755); write(bin, 'pi', 'not executable');
  fs.mkdirSync(path.join(home, '.claude'));
  assert.deepEqual(detectProviders({ HOME: home, PATH: bin }), ['claude', 'codex']);
  assert.deepEqual(detectProviders({ HOME: home, PATH: '' }), ['claude']);
  const root = fixture(t);
  const init = spawnSync(process.execPath, [path.resolve('bin/cachetoast.mjs'), 'init'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}` } });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /installed .* \(Claude Code, Codex\)\./); assert.match(init.stdout, /Codex: review \/hooks\./);
  assert.equal(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME, 'cachetoast')), false);
});
test('update previews and refreshes installed providers while preserving policy and handoffs', t => {
  const root = fixture(t);
  write(root, '.codex/config.toml', '[shell_environment_policy]\ninherit = "core"\n');
  install(root, { providers: ['codex', 'pi'], targetTokens: 180000, minContextTokens: 50000 });
  const key = keyFor('codex', 's1');
  hook(root, 'codex', 'UserPromptSubmit', 0, { prompt: 'Keep my session' });
  write(root, `.cachetoast/handoffs/${key}.md`, 'Saved handoff\n');
  // Simulate a previous package's runtime recorded by its installer.
  const runtime = '.cachetoast/runtime/lib/runtime.mjs';
  const old = fs.readFileSync(path.join(root, runtime), 'utf8') + '\n// Previous runtime\n';
  write(root, runtime, old);
  const manifest = readJson(path.join(root, '.cachetoast/manifest.json'));
  manifest.files[runtime].installedHash = hash(old);
  atomicWrite(root, '.cachetoast/manifest.json', manifest);
  const preserved = ['.codex/config.toml', '.cachetoast/config.json', statePath(key), `.cachetoast/handoffs/${key}.md`];
  const snapshot = Object.fromEntries([...Object.keys(manifest.files), '.cachetoast/manifest.json', ...preserved].map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  fs.mkdirSync(path.join(root, 'nested'));
  const run = args => spawnSync(process.execPath, [path.resolve('bin/cachetoast.mjs'), 'update', ...args], { cwd: path.join(root, 'nested'), encoding: 'utf8' });
  const preview = run(['--dry-run']);
  assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /Dry run: would update Cachetoast/);
  for (const [file, before] of Object.entries(snapshot)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), before);
  const updated = run([]);
  assert.equal(updated.status, 0, updated.stderr); assert.match(updated.stdout, /Cachetoast updated .* \(Codex, Pi\)/);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
  assert.equal(fs.readFileSync(path.join(root, runtime), 'utf8'), fs.readFileSync(path.resolve('lib/runtime.mjs'), 'utf8'));
  for (const file of preserved) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), snapshot[file]);
  const unchanged = run([]);
  assert.equal(unchanged.status, 0, unchanged.stderr); assert.equal(unchanged.stdout, `Cachetoast: up to date in ${fs.realpathSync(root)}.\n`);
  const wrongTarget = run(['--repo', path.join(root, 'nested')]);
  assert.equal(wrongTarget.status, 1); assert.match(wrongTarget.stderr, /No local installation manifest/);
  assert.throws(() => update(root, { providers: ['claude'] }), /use init to add a provider/);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
  write(root, '.codex/config.toml', 'model = "custom"\n');
  assert.throws(() => update(root), /changed since install/);
  assert.equal(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8'), 'model = "custom"\n');
  assert.throws(() => update(fixture(t)), /run init first/);
});

test('uninstall/reinstall refuse external edits and symlinks', t => {
  const root = fixture(t); install(root); write(root, '.codex/hooks.json', '{"edited": true}');
  assert.throws(() => uninstall(root), /changed/); assert.throws(() => install(root), /changed/);
  const other = fixture(t); fs.symlinkSync(root, path.join(other, '.claude'));
  assert.throws(() => install(other), /symlink/);
  const dangling = fixture(t); fs.symlinkSync(path.join(dangling, 'missing'), path.join(dangling, '.claude'));
  assert.throws(() => install(dangling), /symlink/);
});
test('the first prompt after the cache goes cold is held once per idle period; small sessions pass', t => {
  // Claude reports 5m; Codex assumes 30m.
  for (const [provider, ttl, deadline] of [['claude', '5m', 4], ['codex', '30m', 25]]) {
    const root = fixture(t); install(root);
    const transcript_path = transcript(root, provider, 150_000, 0, undefined, '5m');
    hook(root, provider, 'UserPromptSubmit', 0, { prompt: 'Build a parser; preserve files', transcript_path });
    hook(root, provider, 'Stop', 0, { last_assistant_message: 'Parser added. Still need tests.', transcript_path });
    const D = deadline * 60_000;
    const out = hook(root, provider, 'UserPromptSubmit', D, { prompt: 'Add unicode support', transcript_path });
    assert.equal(out.decision, 'block');
    if (provider === 'codex') assert.equal(out.systemMessage, out.reason.split('\n\nYour held prompt:')[0]); else assert.equal(out.systemMessage, undefined);
    assert.match(out.reason, /held this prompt/); assert.match(out.reason, /\n\nYour held prompt:\nAdd unicode support$/);
    assert.match(out.reason, new RegExp(`~150k-token session has been idle ${deadline} min with a ${ttl} cache TTL`));
    const key = keyFor(provider, 's1'), handoff = fs.readFileSync(path.join(root, `.cachetoast/handoffs/${key}.md`), 'utf8');
    assert.ok(out.reason.includes(provider === 'claude' ? `run:\n /cachetoast-handoff ${key}\n` : `send:\n $cachetoast-handoff ${key}\n`));
    assert.match(handoff, /Add unicode support/); assert.match(handoff, /Still need tests/);
    assert.equal(runCli(root, ['handoff', '--key', key]).stdout, handoff);
    // A fresh session doesn't know the old key: --provider prints that agent's most recent handoff.
    assert.equal(runCli(root, ['handoff', '--provider', provider]).stdout, handoff);
    // Sending it again goes through, even much later; so does the next prompt.
    assert.deepEqual(hook(root, provider, 'UserPromptSubmit', 2 * D, { prompt: 'Add unicode support', transcript_path }), {});
    assert.deepEqual(hook(root, provider, 'UserPromptSubmit', 2 * D + 1000, { prompt: 'Right away', transcript_path }), {});
    // A new idle period holds again, including sessions over the compaction cap.
    transcript(root, provider, 692_000);
    hook(root, provider, 'Stop', 2 * D + 2000, { transcript_path });
    assert.equal(hook(root, provider, 'UserPromptSubmit', 3 * D + 2000, { prompt: 'Idle again', transcript_path }).decision, 'block');
    const small = fixture(t); install(small);
    const smallPath = transcript(small, provider, 12_000);
    hook(small, provider, 'Stop', 0, { transcript_path: smallPath });
    assert.deepEqual(hook(small, provider, 'UserPromptSubmit', 3_600_000, { prompt: 'Continue', transcript_path: smallPath }), {});
  }
});
test('handoff names keep the previous subject without accumulating CT prefixes', t => {
  const root = fixture(t);
  const file = path.join(root, 'claude.jsonl');
  write(root, 'claude.jsonl', [
    { type: 'ai-title', aiTitle: 'Generic generated title' },
    { type: 'custom-title', customTitle: 'CT - CT - Parser unicode support' },
    { type: 'custom-title', customTitle: 'Unrelated agent', isSidechain: true }
  ].map(record => JSON.stringify(record)).join('\n'));
  const evidence = readTranscript(file, 'claude');
  const state = { sessionName: evidence.sessionName, objective: 'Continue' };
  assert.equal(handoffName(root, state), 'CT - Parser unicode support');
  assert.match(handoffPrompt(root, state), /Suggested session name: CT - Parser unicode support/);
  assert.equal(handoffName(root, { objective: 'Build the parser\nPreserve files' }), 'CT - Build the parser');
  assert.equal(handoffName(root, { sessionName: '\u001b[31mParser\u001b[0m\u0000 tests' }), 'CT - Parser tests');
  assert.equal(handoffName(root), `CT - ${path.basename(root)}`);
  // Persist the native title in state so a later transcript tail need not contain it.
  install(root);
  handleHook(root, 'claude', { session_id: 'named', hook_event_name: 'Stop', transcript_path: file }, { now: 0 });
  write(root, 'claude.jsonl', JSON.stringify({ type: 'assistant', message: { content: 'Added unicode tests' } }));
  handleHook(root, 'claude', { session_id: 'named', hook_event_name: 'Stop', transcript_path: file }, { now: 1 });
  assert.equal(handoffName(root, readJson(path.join(root, statePath(keyFor('claude', 'named'))))), 'CT - Parser unicode support');
});

test('explicit handoff keys select the held session even after another session is held', t => {
  for (const provider of ['claude', 'codex']) {
    const root = fixture(t); install(root);
    const keys = ['first', 'second'].map(id => keyFor(provider, id));
    const deadline = 25 * 60_000;
    for (const [index, id] of ['first', 'second'].entries()) {
      handleHook(root, provider, { session_id: id, hook_event_name: 'UserPromptSubmit', context_tokens: 150_000, prompt: `Build ${id}` }, { now: 0 });
      const out = handleHook(root, provider, { session_id: id, hook_event_name: 'UserPromptSubmit', context_tokens: 150_000, prompt: `Continue ${id}` }, { now: deadline + index * 1000 });
      assert.equal(out.decision, 'block'); assert.ok(out.reason.includes(keys[index]));
      // File timestamps, rather than hook's injected clock, choose the latest fallback.
      fs.utimesSync(path.join(root, `.cachetoast/handoffs/${keys[index]}.md`), 100 + index, 100 + index);
    }
    const first = runCli(root, ['handoff', '--key', keys[0]]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /User’s pending continuation request:\nContinue first/);
    assert.doesNotMatch(first.stdout, /Continue second/);
    assert.match(runCli(root, ['handoff', '--provider', provider]).stdout, /Continue second/);
    fs.unlinkSync(path.join(root, `.cachetoast/handoffs/${keys[0]}.md`));
    const missing = runCli(root, ['handoff', '--key', keys[0]]);
    assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /No saved handoff for this session/);
    const invalid = runCli(root, ['handoff', '--key', 'invalid']);
    assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  }
});

test('Claude sessions use the TTL their latest cache write reports, over any configured TTL', t => {
  const root = fixture(t); install(root, { cacheTtl: { claude: '5m' } });
  const M = 60_000, transcript_path = transcript(root, 'claude', 150_000, 0, 'Done.', '1h');
  hook(root, 'claude', 'Stop', 0, { transcript_path });
  assert.deepEqual(hook(root, 'claude', 'UserPromptSubmit', 54 * M, { prompt: 'Still warm', transcript_path }), {});
  hook(root, 'claude', 'Stop', 54 * M, { transcript_path });
  const out = hook(root, 'claude', 'UserPromptSubmit', 109 * M, { prompt: 'Cold', transcript_path });
  assert.equal(out.decision, 'block'); assert.match(out.reason, /idle 55 min with a 1h cache TTL/);
  assert.match(runCli(root, ['status']).stdout, /"cacheTtl": "1h",\s+"ttlSource": "observed"/);
  // Switching to usage credits shortens the TTL, and the next write shows it.
  transcript(root, 'claude', 150_000, 200 * M, 'Done.', '5m');
  hook(root, 'claude', 'Stop', 200 * M, { transcript_path });
  assert.equal(hook(root, 'claude', 'UserPromptSubmit', 204 * M, { prompt: 'Cold sooner', transcript_path }).decision, 'block');
});
test('long and interrupted turns measure idle time from the latest model response', t => {
  const root = fixture(t); install(root);
  const M = 60_000, transcript_path = transcript(root, 'claude', 150_000, 0, 'Done.', '5m');
  hook(root, 'claude', 'Stop', 0, { transcript_path });
  hook(root, 'claude', 'UserPromptSubmit', M, { prompt: 'Long task', transcript_path });
  hook(root, 'claude', 'Stop', 6 * M, { transcript_path });
  assert.deepEqual(hook(root, 'claude', 'UserPromptSubmit', 6 * M + 1000, { prompt: 'Next', transcript_path }), {});
  // Interrupted turn: no Stop, but the transcript records a response at 15 min.
  transcript(root, 'claude', 150_000, 15 * M, 'Done.', '5m');
  assert.deepEqual(hook(root, 'claude', 'UserPromptSubmit', 16 * M, { prompt: 'After interrupt', transcript_path }), {});
});
test('session keys cannot traverse paths', t => {
  const root = fixture(t); install(root);
  assert.throws(() => safePath(root, '../escape'));
  assert.notEqual(runCli(root, ['handoff', '--key', '../escape']).status, 0);
});
test('transcripts distinguish per-request context from cumulative traffic and ignore tools/sidechains', t => {
  const root = fixture(t), file = path.join(root, 'transcript.jsonl');
  write(root, 'transcript.jsonl', [
    { type: 'user', message: { content: 'Fix parser' } },
    { type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { content: [{ type: 'text', text: 'Need tests' }, { type: 'tool_use', input: 'secret' }], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 } } },
    { type: 'assistant', isSidechain: true, message: { content: 'Ignore this', usage: { input_tokens: 9999 } } }
  ].map(r => JSON.stringify(r)).join('\n') + '\n{partial');
  const a = readTranscript(file, 'claude'); assert.equal(a.contextTokens, 135); assert.equal(a.assistant, 'Need tests'); assert.equal(a.latestUser, 'Fix parser');
  write(root, 'transcript.jsonl', JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 999999 }, last_token_usage: { total_tokens: 1234 } } } }));
  assert.equal(readTranscript(file, 'codex').contextTokens, 1234);
});
test('large transcripts are read from the tail only', t => {
  const root = fixture(t), file = path.join(root, 'big.jsonl');
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } });
  write(root, 'big.jsonl', [JSON.stringify({ type: 'assistant', message: { content: 'old', usage: { input_tokens: 1 } } }), ...Array(400).fill(filler), JSON.stringify({ type: 'assistant', message: { content: 'new', usage: { input_tokens: 200000 } } })].join('\n'));
  const r = readTranscript(file, 'claude'); assert.equal(r.contextTokens, 200000); assert.equal(r.assistant, 'new');
});
test('installed hooks run from nested directories with shell-sensitive path names', t => {
  const root = fixture(t); install(root); fs.mkdirSync(path.join(root, 'nested'));
  const command = readJson(path.join(root, '.codex/hooks.json')).hooks.UserPromptSubmit[0].hooks[0].command;
  const run = cwd => spawnSync('/bin/sh', ['-c', command], { cwd, input: JSON.stringify({ session_id: 'nested', hook_event_name: 'UserPromptSubmit', cwd, prompt: 'hi' }), encoding: 'utf8' });
  const child = run(path.join(root, 'nested'));
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), {});
  assert.ok(fs.existsSync(path.join(root, statePath(keyFor('codex', 'nested')))));
  const outside = fixture(t), quiet = run(outside);
  assert.equal(quiet.status, 0); assert.equal(quiet.stdout, '');
});
test('hook errors fail open with a warning; corrupt state resets', t => {
  const root = fixture(t); install(root);
  write(root, statePath(keyFor('codex', 'bad')), '{broken');
  const event = JSON.stringify({ session_id: 'bad', hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'Continue' });
  const reset = runCli(root, ['hook', '--provider', 'codex'], event);
  assert.equal(reset.status, 0); assert.deepEqual(JSON.parse(reset.stdout), {});
  write(root, '.cachetoast/config.json', '{broken');
  const broken = runCli(root, ['hook', '--provider', 'codex'], event);
  assert.equal(broken.status, 0); const out = JSON.parse(broken.stdout);
  assert.equal(out.decision, undefined); assert.match(out.systemMessage, /skipped this check/);
  assert.match(JSON.parse(runCli(root, ['hook', '--provider', 'codex'], 'not json').stdout).systemMessage, /skipped/);
});
test('review regressions: stale evidence, launcher', t => {
  // Unreadable transcript: cached size must not warn.
  const a = fixture(t); install(a);
  const transcript_path = transcript(a, 'claude', 150_000);
  hook(a, 'claude', 'Stop', 0, { transcript_path });
  fs.rmSync(transcript_path);
  assert.deepEqual(hook(a, 'claude', 'UserPromptSubmit', 3_600_000, { prompt: 'Go', transcript_path }), {});
  // Launcher fails open when the vendored CLI is missing.
  const d = fixture(t); install(d);
  const command = readJson(path.join(d, '.claude/settings.json')).hooks.UserPromptSubmit[0].hooks[0].command;
  fs.rmSync(path.join(d, '.cachetoast/runtime/bin/cachetoast.mjs'));
  const child = spawnSync('/bin/sh', ['-c', command], { cwd: d, input: '{}', encoding: 'utf8' });
  assert.equal(child.status, 0); assert.match(JSON.parse(child.stdout).systemMessage, /skipped/);
});
test('Pi extension: idle warning, /handoff, idle-time context cap, fail open', async t => {
  const root = fixture(t); install(root, { providers: ['pi'] });
  assert.equal(fs.existsSync(path.join(root, '.pi/settings.json')), false);
  assert.match(fs.readFileSync(path.join(root, '.pi/extensions/cachetoast.ts'), 'utf8'), /runtime\/lib\/pi-extension\.mjs/);
  const { default: extension } = await import(pathToFileURL(path.join(root, '.cachetoast/runtime/lib/pi-extension.mjs')).href);
  const on = {}, commands = {}, notices = [], statuses = [];
  const sourceName = 'Parser unicode support';
  let sessionName = null;
  extension({ on: (event, handler) => { on[event] = handler; }, registerCommand: (name, command) => { commands[name] = command; } });
  let tokens = 150_000, compactions = 0, editor = null, parent = null, broken = false;
  fs.mkdirSync(path.join(root, 'nested'));
  const ctx = {
    cwd: path.join(root, 'nested'),
    ui: { notify: message => notices.push(message), setEditorText: text => { editor = text; }, setStatus: (key, text) => statuses.push([key, text]) },
    sessionManager: { getSessionId: () => 'p1', getSessionFile: () => '/sessions/p1.jsonl', getSessionName: () => sourceName },
    getContextUsage: () => { if (broken) throw new Error('usage offline'); return { tokens }; },
    isIdle: () => true,
    compact: options => { compactions++; options.onComplete(); },
    newSession: async options => { parent = options.parentSession; await options.setup({ appendSessionInfo: name => { sessionName = name; } }); await options.withSession(ctx); return {}; },
    model: { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5-5' }
  };
  const statefile = path.join(root, statePath(keyFor('pi', 'p1')));
  const idleFor = ms => { const state = readJson(statefile); state.lastActivity = Date.now() - ms; atomicWrite(root, statePath(keyFor('pi', 'p1')), state); };
  assert.deepEqual(on.input({ text: 'Build the parser', source: 'interactive' }, ctx), { action: 'continue' });
  on.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Parser done; tests remain.' }] }] });
  on.session_start({}, ctx);
  on.agent_settled({}, ctx);
  assert.equal(notices.length, 0); assert.equal(compactions, 0);
  assert.deepEqual(statuses.at(-1), ['cachetoast', 'cache warm 4m · 150k']);
  // The TTL is guessed from the model: Claude writes 5m; anything else assumes 30m.
  const claude = ctx.model; ctx.model = { provider: 'openai', api: 'openai-responses', id: 'gpt-6.1' }; on.session_start({}, ctx);
  assert.deepEqual(statuses.at(-1), ['cachetoast', 'cache warm 25m · 150k']);
  ctx.model = claude;
  idleFor(10 * 60_000);
  on.session_start({}, ctx);
  assert.deepEqual(statuses.at(-1), ['cachetoast', 'cache cold · 150k · /handoff']);
  on.session_shutdown({}, ctx);
  on.input({ text: 'Steer', source: 'interactive', streamingBehavior: 'steer' }, ctx);
  assert.equal(notices.length, 0);
  assert.deepEqual(on.input({ text: 'Add unicode tests', source: 'interactive' }, ctx), { action: 'handled' });
  assert.match(notices[0], /~150k-token session has been idle 10 min/); assert.match(notices[0], /\/handoff/);
  assert.equal(editor, 'Add unicode tests');
  assert.deepEqual(on.input({ text: 'Add unicode tests', source: 'interactive' }, ctx), { action: 'continue' });
  assert.equal(notices.length, 1);
  await commands.handoff.handler('', ctx);
  assert.equal(sessionName, 'CT - Parser unicode support');
  assert.match(editor, /Suggested session name: CT - Parser unicode support/);
  assert.equal(parent, '/sessions/p1.jsonl'); assert.match(editor, /Parser done; tests remain/); assert.match(editor, /Add unicode tests/); assert.match(editor, /Build the parser/);
  tokens = 260_000; on.agent_settled({}, ctx); assert.equal(compactions, 1);
  broken = true; notices.length = 0;
  assert.deepEqual(on.input({ text: 'Go', source: 'interactive' }, ctx), { action: 'continue' });
  assert.match(notices[0], /skipped this check: usage offline/);
});
