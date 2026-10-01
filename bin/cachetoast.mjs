#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { handleHook, configAt, ttlChoice, statePath, userConfigPath, KEY_RE, PROVIDERS } from '../lib/runtime.mjs';
import { readJson, readText, safePath } from '../lib/storage.mjs';

const HELP = `Cachetoast 0.1.0 — local handoffs, inspired in part by Antiburn
Usage: cachetoast <command> [--repo PATH] [options]
  init       Install in the current repo (or --repo) for the agents you have installed.
             [--provider claude,codex,pi] [--dry-run]
             [--claude-cache-ttl TTL] [--codex-cache-ttl TTL] [--pi-cache-ttl TTL]
             [--min-context-tokens 100000] [--target-tokens 250000]
  update     Refresh an existing installation from this copy of Cachetoast; keeps installed providers.
             [--provider claude,codex,pi] [--dry-run] (same policy options as init)
  status     List tracked sessions, policy, and handoff keys
  handoff    --key KEY, or --provider P for its latest: print the saved fresh-session prompt
  uninstall  Restore installation files if they have no external edits
  hook       --provider claude|codex: JSON lifecycle event on stdin (internal; Pi runs in-process)
Cache TTLs are read from Claude Code sessions, 30m for Codex (GPT-5.6+), and guessed from Pi's model.
To override (5m, 30m, 1h, 24h), pass --<agent>-cache-ttl: saved per user in ~/.config/cachetoast/config.json,
or per repo in the gitignored .cachetoast/local.json. A TTL a Claude session reports always wins.
Only sessions of 100k+ tokens are held: the first prompt after the cache goes cold, once per idle period.
Hooks and all commands run without LLMs, credentials, or network access.
`;
function options(args) {
  const result = {};
  const booleans = new Set(['dry-run', 'help']);
  const allowed = new Set(['repo', 'provider', 'claude-cache-ttl', 'codex-cache-ttl', 'pi-cache-ttl', 'min-context-tokens', 'target-tokens', 'key', ...booleans]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--') || !allowed.has(arg.slice(2))) throw new Error(`Unknown option: ${arg}`);
    const name = arg.slice(2);
    if (Object.hasOwn(result, name)) throw new Error(`Duplicate option: ${arg}`);
    if (booleans.has(name)) result[name] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`); result[name] = value; }
  }
  return result;
}
async function stdin() {
  let text = '';
  for await (const b of process.stdin) { text += b; if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('stdin exceeds 1 MiB'); }
  return text;
}
function findRoot(start) {
  let root = path.resolve(start);
  while (!fs.existsSync(path.join(root, '.cachetoast/config.json'))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error('No Cachetoast config found; run init');
    root = parent;
  }
  return root;
}
const NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
const integer = value => value === undefined ? undefined : Number(value);
function validateKey(key) { if (!KEY_RE.test(key ?? '')) throw new Error('Use a session key from status'); return key; }
function latestHandoff(root, provider) {
  if (!PROVIDERS.includes(provider)) throw new Error(`handoff needs --key KEY or --provider ${PROVIDERS.join('|')}`);
  const dir = safePath(root, '.cachetoast/handoffs');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md') && KEY_RE.test(f.slice(0, -3)) && f.startsWith(`${provider}-`)) : [];
  if (!files.length) throw new Error('No saved handoff yet');
  return files.map(f => [f.slice(0, -3), fs.statSync(path.join(dir, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0];
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(HELP); return; }
  const [command = 'help', ...args] = argv, o = options(args);
  if (command === 'help' || o.help) { process.stdout.write(HELP); return; }
  if (command === 'hook') {
    // A cost advisory must never stop work because of its own failure: fail open with a visible warning.
    let result;
    try {
      const input = JSON.parse(await stdin());
      result = handleHook(findRoot(o.repo ?? input.cwd ?? process.cwd()), o.provider, input);
    } catch (error) {
      result = { systemMessage: `Cachetoast skipped this check: ${error.message}. Run its status command to reconcile.` };
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  // Installer code loads only for install commands, keeping hooks fast.
  if (command === 'init' || command === 'update') {
    const { install, update, detectProviders } = await import('../lib/install.mjs');
    const updating = command === 'update';
    const root = updating && !o.repo ? findRoot(process.cwd()) : path.resolve(o.repo ?? process.cwd());
    const providers = o.provider ? o.provider.split(',') : updating ? undefined : detectProviders();
    if (providers && !providers.length) throw new Error('No Claude Code, Codex, or Pi installation found; pass --provider claude,codex,pi');
    if (providers?.some(p => !PROVIDERS.includes(p))) throw new Error(`Choose providers from ${PROVIDERS.join(', ')}`);
    const cacheTtl = Object.fromEntries(PROVIDERS.map(p => [p, o[`${p}-cache-ttl`]]));
    const result = (updating ? update : install)(root, {
      providers, cacheTtl, minContextTokens: integer(o['min-context-tokens']), targetTokens: integer(o['target-tokens']), dryRun: o['dry-run']
    });
    const list = items => items.map(p => NAMES[p] ?? p).join(', ');
    const action = updating ? 'update' : 'install';
    console.log(result.changed.length
      ? `${result.dryRun ? `Dry run: would ${action} Cachetoast` : `Cachetoast ${updating ? 'updated' : 'installed'}`} in ${root} (${list(result.providers)}).`
      : `Cachetoast: up to date in ${root}.`);
    if (result.dryRun && result.changed.length) {
      const changed = [...new Set(result.changed.map(f => f.startsWith('.cachetoast/runtime/') ? '.cachetoast/runtime/' : f))];
      console.log(`Would change: ${changed.join(', ')}`);
    }
    if (result.userConfig) console.log(`${result.dryRun ? 'Would save' : 'Saved'} cache TTLs to ${result.userConfig}.`);
    if (result.dryRun || !result.changed.length) return;
    const next = ['Restart your agent.'];
    if (result.providers.includes('codex') || result.providers.includes('pi')) next.push('Trust the repo.');
    if (result.providers.includes('codex')) next.push('Codex: review /hooks.');
    console.log(next.join(' '));
    return;
  }
  const root = findRoot(o.repo ?? process.cwd());
  if (command === 'uninstall') {
    const { uninstall } = await import('../lib/install.mjs');
    const result = uninstall(root);
    console.log(`Cachetoast uninstalled from ${root}.`);
    if (result.kept.length) console.log(`Kept: ${result.kept.join(', ')}.`);
  } else if (command === 'handoff') {
    // Without --key, the most recently held session for --provider: what a fresh session's /cachetoast-handoff wants.
    const key = o.key ? validateKey(o.key) : latestHandoff(root, o.provider);
    const text = readText(safePath(root, `.cachetoast/handoffs/${key}.md`));
    if (!text) throw new Error('No saved handoff for this session yet');
    process.stdout.write(text);
  } else if (command === 'status') {
    const config = configAt(root), dir = safePath(root, '.cachetoast/state');
    const keys = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && KEY_RE.test(f.slice(0, -5))).map(f => f.slice(0, -5)) : [];
    const sessions = keys.map(key => {
      try {
        const s = readJson(safePath(root, statePath(key)));
        return { key, provider: s.provider, ...ttlChoice(config, s.provider, s), heldAt: s.heldAt ?? null, contextTokens: s.contextTokens ?? null, lastActivity: s.lastActivity, warnings: s.warnings ?? [] };
      } catch (error) { return { key, error: `Unreadable state (${error.message}); delete it to reset` }; }
    });
    console.log(JSON.stringify({ config, userConfig: userConfigPath(), sessions, note: 'Cache availability is inferred, never guaranteed. Sessions with unknown context size are never held.' }, null, 2));
  } else throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(`cachetoast: ${error.message}`); process.exitCode = 1; });
