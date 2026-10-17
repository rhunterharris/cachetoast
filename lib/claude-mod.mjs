import { createIdleCompactor } from './idle.mjs';

// The installer bundles this module into a repo-local Claude Code plugin.
// No Node globals: all host access goes through Claude's portable mod API.
let controller, root, sessionId;
function warn($, error) { void Promise.resolve($.ui.log(`Cachetoast idle compaction skipped: ${error.message}. The handoff remains available.`)).catch(() => {}); }
async function command($, input, target = { root, sessionId }) {
  const result = await $.process.run(['node', `${target.root}/.cachetoast/runtime/bin/cachetoast.mjs`, 'idle', '--provider', 'claude', '--repo', target.root], {
    cwd: target.root, stdin: JSON.stringify({ session_id: target.sessionId, ...input }), timeoutMs: 10_000
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Cannot read compaction state');
  return JSON.parse(result.stdout);
}
async function connect($) {
  const id = await $.session.id();
  let dir = await $.session.cwd();
  while (!await $.fs.exists(`${dir}/.cachetoast/config.json`)) {
    const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
    if (parent === dir) return false;
    dir = parent;
  }
  if (controller && (sessionId !== id || root !== dir)) { controller.cancel(); controller = undefined; }
  root = dir; sessionId = id;
  const target = { root, sessionId };
  controller ??= createIdleCompactor({
    read: () => command($, {}, target),
    record: (s, status, result) => command($, { activityId: s.activityId, lastActivity: s.lastActivity, status, skip: result?.skip, tokensAfter: result?.tokensAfter }, target),
    compact: () => $.session.compact(),
    now: () => $.clock.now(), after: (ms, fn) => $.clock.after(ms, fn), onError: error => warn($, error)
  });
  return true;
}
export function register(on) {
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e);
    if (!e.agent_id && !controller?.isRunning()) {
      try { if (await connect($)) await controller.arm(); } catch (error) { warn($, error); }
    }
    return result;
  });
  on('classic.SessionStart', async ($, e, next) => {
    controller?.cancel();
    const result = await next(e);
    try { if (await connect($)) await controller.arm(); } catch (error) { warn($, error); }
    return result;
  });
  on('classic.UserPromptSubmit', ($, e, next) => { controller?.cancel(); return next(e); });
  on('turn.start', ($, e, next) => { controller?.cancel(); return next(e); });
  on('session.end', ($, e, next) => { controller?.cancel(); return next(e); });
  // Manual/threshold compaction also satisfies this idle cycle; precompute does not install a summary.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') return next(e);
    if (controller?.isRunning()) return next(e);
    controller?.cancel();
    let state;
    try { if (await connect($)) state = await command($, {}); } catch (error) { warn($, error); }
    const target = { root, sessionId };
    const result = await next(e);
    if (state && !result.skip) {
      try { await command($, { activityId: state.activityId, lastActivity: state.lastActivity, status: 'succeeded', tokensAfter: result.tokensAfter }, target); }
      catch (error) { warn($, error); }
    }
    return result;
  });
}
