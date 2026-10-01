import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { policy, DEFAULT_MIN_CONTEXT } from './policy.mjs';
import { safePath, readText, readJson, atomicWrite, writeFileAtomic, hash } from './storage.mjs';
import { PROVIDERS, userConfigPath, readUserConfig, ttlFor } from './runtime.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
// Agents this user has: a CLI on PATH or a home directory (~/.claude, ~/.codex, ~/.pi).
export function detectProviders(env = process.env) {
  const home = env.HOME || os.homedir(), dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const onPath = name => dirs.some(dir => { try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; } });
  return PROVIDERS.filter(p => onPath(p) || fs.existsSync(path.join(home, `.${p}`)));
}
function repoRoot(root) {
  root = path.resolve(root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Repository directory does not exist');
  return root;
}
function codexConfig(text, target) {
  // Only edit a root scalar, never a similarly named key inside a TOML table.
  const lines = text.split('\n');
  let table = false, found = false, scopeFound = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) table = true;
    if (!table && /^\s*model_auto_compact_token_limit_scope\s*=/.test(lines[i])) {
      if (scopeFound) throw new Error('Duplicate Codex compaction scope');
      lines[i] = 'model_auto_compact_token_limit_scope = "total"';
      scopeFound = true;
    }
    if (!table && /^\s*model_auto_compact_token_limit\s*=/.test(lines[i])) {
      if (found) throw new Error('Duplicate Codex compaction key');
      const m = lines[i].match(/^\s*model_auto_compact_token_limit\s*=\s*([\d_]+)\s*(?:#.*)?$/);
      if (!m) throw new Error('Unsupported Codex compaction scalar; use a plain integer');
      lines[i] = `model_auto_compact_token_limit = ${Math.min(Number(m[1].replaceAll('_', '')), target)}`;
      found = true;
    }
  }
  return (found ? '' : `model_auto_compact_token_limit = ${target}\n`) + (scopeFound ? '' : 'model_auto_compact_token_limit_scope = "total"\n') + lines.join('\n');
}
const SCRIPT = '.cachetoast/runtime/bin/cachetoast.mjs';
function handoffInstructions(provider, requested) {
  const naming = provider === 'codex'
    ? 'Use the available session-title tool (in the Codex app, `set_thread_title` without a thread ID) to rename only this new session.'
    : 'Use a supported session-title tool if one is available to rename only this new session.';
  return `${requested}\n\nFrom the repository root, load the requested handoff with \`node ${SCRIPT} handoff --key KEY\`, replacing KEY with the exact session key supplied by the user. Validate that it matches \`${provider}-[a-f0-9]{24}\` before using it in a command. If no key was supplied, run \`node ${SCRIPT} handoff --provider ${provider}\` to load this provider's most recently held session. If a supplied key is invalid or its handoff is missing, report the error; do not fall back to another session.\n\nName this new session \`CT - <subject>\`. Prefer the handoff's suggested session name when it describes the prior work. If it is generic (such as "continue"), choose a short subject from the work described in the excerpts. Keep exactly one \`CT - \` prefix. ${naming} If no naming tool is available, show the user the exact \`/rename CT - <subject>\` command once, then continue the work. Do not run another coding agent or edit provider session files to rename it, and do not claim it was renamed without a successful tool result.\n\nThe output is the handoff for this session: treat it as the user's continuation request, including the pending request, and follow it.\n`;
}
const EVENTS = ['UserPromptSubmit', 'Stop'];
const owned = hook => typeof hook?.command === 'string' && hook.command.includes(SCRIPT);
function mergeHooks(settings, provider) {
  settings.hooks ??= {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('Invalid hooks object');
  // Fixed code; no user-controlled paths are interpolated into a shell command.
  // One process: resolve the root from cwd (subdirectories, movable checkouts), then import the CLI.
  // No config found means not installed here: exit quietly so the prompt proceeds.
  const launcher = `const fs=require("node:fs"),p=require("node:path");let r=process.cwd();while(!fs.existsSync(p.join(r,".cachetoast/config.json"))){const q=p.dirname(r);if(q===r)process.exit(0);r=q}process.argv=[process.argv[0],p.join(r,"${SCRIPT}"),"hook","--provider","${provider}","--repo",r];import(require("node:url").pathToFileURL(process.argv[1]).href).catch(e=>console.log(JSON.stringify({systemMessage:"Cachetoast skipped this check: "+e.message})))`;
  const command = `node -e '${launcher}'`;
  // Remove every hook this package owns (including older versions' events), preserving all others.
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    const kept = groups.map(group => ({ ...group, hooks: (group.hooks ?? []).filter(h => !owned(h)) })).filter(group => group.hooks.length);
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  for (const event of EVENTS) (settings.hooks[event] ??= []).push({ hooks: [{ type: 'command', command, timeout: 10 }] });
  return settings;
}
export function install(root, options = {}) {
  root = repoRoot(root);
  const providers = options.providers ?? PROVIDERS;
  if (!providers.length || providers.some(p => !PROVIDERS.includes(p))) throw new Error(`Choose providers from ${PROVIDERS.join(', ')}`);
  const oldConfig = readJson(safePath(root, '.cachetoast/config.json'));
  const target = options.targetTokens ?? oldConfig?.targetTokens ?? 250_000;
  if (!Number.isInteger(target) || target < 100_000 || target > 250_000) throw new Error('targetTokens must be 100000 through 250000');
  const config = { version: 1, targetTokens: target, minContextTokens: options.minContextTokens ?? oldConfig?.minContextTokens ?? DEFAULT_MIN_CONTEXT };
  // TTL overrides depend on each person's billing, so they go to the user config, shared by all their repos.
  const userPath = userConfigPath(), userOriginal = readText(userPath, null), user = readUserConfig();
  for (const provider of PROVIDERS) if (options.cacheTtl?.[provider] !== undefined) user[provider] = { ...user[provider], cacheTtl: options.cacheTtl[provider] };
  const local = readJson(safePath(root, '.cachetoast/local.json'), {});
  for (const provider of PROVIDERS) policy({ ...ttlFor(user, local, provider), targetTokens: target, minContextTokens: config.minContextTokens });
  const userData = JSON.stringify(user, null, 2) + '\n', userChanged = userData !== userOriginal && Object.keys(user).length > 0;
  const changes = new Map();
  const set = (relative, data) => { safePath(root, relative); changes.set(relative, data); };
  if (providers.includes('claude')) {
    const settings = readJson(safePath(root, '.claude/settings.json'), {});
    settings.env ??= {};
    const prior = settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (prior != null && !/^\d+$/.test(String(prior))) throw new Error('Existing Claude compact window must be a plain integer');
    settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(prior == null ? target : Number(prior), target));
    // The bootstrap explicitly enables this compaction policy in the repo.
    settings.autoCompactEnabled = true;
    for (const flag of ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT']) if (settings.env[flag] === '1') settings.env[flag] = '0';
    set('.claude/settings.json', JSON.stringify(mergeHooks(settings, 'claude'), null, 2) + '\n');
    // Arguments are prompt data, never interpolated into an injected shell command.
    set('.claude/commands/cachetoast-handoff.md', `---\ndescription: Continue a Cachetoast-held session by its key (latest if omitted)\nargument-hint: "[session-key]"\nallowed-tools: Bash(node ${SCRIPT} handoff:*)\n---\n<!-- Managed by Cachetoast; edits are overwritten by init. -->\n${handoffInstructions('claude', 'Requested session key: $ARGUMENTS')}`);
  }
  if (providers.includes('codex')) {
    set('.codex/config.toml', codexConfig(readText(safePath(root, '.codex/config.toml')), target));
    set('.codex/hooks.json', JSON.stringify(mergeHooks(readJson(safePath(root, '.codex/hooks.json'), {}), 'codex'), null, 2) + '\n');
    // Codex has no project slash commands; a repo skill has the agent load the handoff instead.
    set('.agents/skills/cachetoast-handoff/SKILL.md', `---\nname: cachetoast-handoff\ndescription: Continue a Cachetoast-held Codex session by its key (latest if omitted) in this fresh session.\n---\n<!-- Managed by Cachetoast; edits are overwritten by init. -->\n${handoffInstructions('codex', 'Use the session key supplied after $cachetoast-handoff in the user message, if any.')}`);
  }
  if (providers.includes('pi')) {
    // Pi has no absolute compaction setting; the extension enforces the ceiling.
    set('.pi/extensions/cachetoast.ts', '// Managed by Cachetoast; edits are overwritten by init.\nexport { default } from "../../.cachetoast/runtime/lib/pi-extension.mjs";\n');
  }
  set('.cachetoast/config.json', JSON.stringify(config, null, 2) + '\n');
  set('.cachetoast/README.md', '# Cachetoast\n\nThe runtime, config.json, and provider hook settings can be committed. local.json (optional per-repo cache TTL overrides), state, handoffs, and the manifest stay local: handoffs contain conversation excerpts.\n\nWhen a large session (default 100k+ tokens) has been idle past your cache deadline, the first prompt is held once with a fresh-session handoff (in a new session, copy `/cachetoast-handoff KEY` in Claude Code or `$cachetoast-handoff KEY` in Codex from the notice; in Pi, `/handoff` opens one); sending it again continues. The key selects the held session even when others have been held since. Omitting it loads the latest handoff for that provider. Handoffs are local extracts, not model summaries. Cache TTLs are read from Claude Code sessions, 30m for Codex, and guessed from the Pi model; override one with `node .cachetoast/runtime/bin/cachetoast.mjs init --pi-cache-ttl 1h` (saved in ~/.config/cachetoast/config.json). Inspect with `status` and `handoff --key KEY`.\n\nInspired in part by [Antiburn](https://antiburn.com/) and its [open source work](https://github.com/antiburn/antiburn).\n');
  const ignore = readText(safePath(root, '.gitignore'));
  const ignores = ['state/', 'handoffs/', 'manifest.json', 'local.json'].map(p => `.cachetoast/${p}`);
  const missing = ignores.filter(p => !ignore.split('\n').includes(p));
  set('.gitignore', ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + (missing.length ? missing.join('\n') + '\n' : ''));
  for (const dir of ['lib', 'bin']) for (const file of fs.readdirSync(path.join(PACKAGE_ROOT, dir)).filter(f => f.endsWith('.mjs'))) {
    set(`.cachetoast/runtime/${dir}/${file}`, fs.readFileSync(path.join(PACKAGE_ROOT, dir, file), 'utf8'));
  }
  for (const file of ['LICENSE']) set(`.cachetoast/runtime/${file}`, readText(path.join(PACKAGE_ROOT, file)));
  const manifestPath = safePath(root, '.cachetoast/manifest.json');
  const manifest = readJson(manifestPath, { version: 1, files: {} });
  // Reinstallation refuses external edits instead of erasing them during uninstall.
  for (const [relative, previous] of Object.entries(manifest.files)) {
    const current = readText(safePath(root, relative), null);
    if (current === null || hash(current) !== previous.installedHash) throw new Error(`${relative} changed since install; uninstall/reconcile it before reinstalling`);
  }
  const changed = [...changes].filter(([r, data]) => readText(safePath(root, r), null) !== data);
  const result = { root, providers, changed: changed.map(([r]) => r), userConfig: userChanged ? userPath : null, dryRun: !!options.dryRun };
  if (options.dryRun) return result;
  const rollback = [];
  try {
    for (const [relative, data] of changes) {
      const original = readText(safePath(root, relative), null);
      rollback.push([relative, original]);
      manifest.files[relative] ??= { original };
      manifest.files[relative].installedHash = hash(data);
      atomicWrite(root, relative, data);
    }
    if (userChanged) writeFileAtomic(userPath, userData);
    // The manifest is written last so a failed install never records unwritten state.
    atomicWrite(root, '.cachetoast/manifest.json', manifest);
  } catch (error) {
    if (userChanged) { if (userOriginal === null) fs.rmSync(userPath, { force: true }); else writeFileAtomic(userPath, userOriginal); }
    for (const [r, original] of rollback.reverse()) {
      if (original === null) fs.rmSync(safePath(root, r), { force: true }); else atomicWrite(root, r, original);
    }
    throw error;
  }
  return result;
}
export function update(root, options = {}) {
  root = repoRoot(root);
  const manifest = readJson(safePath(root, '.cachetoast/manifest.json'));
  if (!manifest || manifest.version !== 1 || !manifest.files) throw new Error('No local installation manifest; run init first');
  const paths = { claude: '.claude/settings.json', codex: '.codex/hooks.json', pi: '.pi/extensions/cachetoast.ts' };
  const installed = PROVIDERS.filter(provider => Object.hasOwn(manifest.files, paths[provider]));
  if (!installed.length) throw new Error('No installed providers; run init first');
  const providers = options.providers ?? installed;
  if (providers.some(provider => !installed.includes(provider))) throw new Error('update only accepts installed providers; use init to add a provider');
  return install(root, { ...options, providers });
}
export function uninstall(root) {
  root = path.resolve(root);
  const manifest = readJson(safePath(root, '.cachetoast/manifest.json'));
  if (!manifest) throw new Error('No local installation manifest; restore config with git instead');
  for (const [relative, entry] of Object.entries(manifest.files)) {
    if (hash(readText(safePath(root, relative))) !== entry.installedHash) throw new Error(`${relative} changed since install; reconcile manually to preserve edits`);
  }
  // Preflight all paths before modifying any of them.
  for (const [relative, entry] of Object.entries(manifest.files)) {
    if (entry.original === null) fs.unlinkSync(safePath(root, relative)); else atomicWrite(root, relative, entry.original);
  }
  fs.unlinkSync(safePath(root, '.cachetoast/manifest.json'));
  // The restored .gitignore no longer ignores these, and handoffs contain conversation excerpts: remove them.
  for (const dir of ['state', 'handoffs']) fs.rmSync(safePath(root, `.cachetoast/${dir}`), { recursive: true, force: true });
  const localPath = safePath(root, '.cachetoast/local.json'), local = readJson(localPath, null);
  if (local && !Object.keys(local).length) fs.unlinkSync(localPath);
  // Remove directories the install created, deepest first, if now empty.
  const dirs = new Set(['.cachetoast']);
  for (const [relative, entry] of Object.entries(manifest.files)) if (entry.original === null) for (let d = path.dirname(relative); d !== '.'; d = path.dirname(d)) dirs.add(d);
  for (const dir of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try { fs.rmdirSync(safePath(root, dir)); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
  }
  const kept = fs.existsSync(localPath) ? ['.cachetoast/local.json (your TTL overrides; no longer gitignored)'] : [];
  return { restored: Object.keys(manifest.files), kept };
}
