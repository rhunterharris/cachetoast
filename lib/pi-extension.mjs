// Cachetoast adapter for Pi, loaded through the managed stub in .pi/extensions.
// Runs in-process: same policy, state, and handoffs as the Claude/Codex hooks.
import fs from 'node:fs';
import path from 'node:path';
import { handleHook, handoffFor, handoffName, configAt, policyFor, statePath } from './runtime.mjs';
import { statusText } from './policy.mjs';
import { readJson, safePath, keyFor } from './storage.mjs';

const findRoot = start => {
  let root = path.resolve(start);
  while (!fs.existsSync(path.join(root, '.cachetoast/config.json'))) {
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  return root;
};
const messageText = message => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : '';

// A rough guess mirroring pi-ai: Claude models write 5m, or 1h from Anthropic with PI_CACHE_RETENTION=long.
// Anything else falls back to the 30m default.
const ttlGuess = ({ model } = {}) => model?.provider !== 'anthropic' && !/claude/i.test(model?.id ?? '') ? undefined
  : model.provider === 'anthropic' && process.env.PI_CACHE_RETENTION === 'long' ? '1h' : '5m';

export default function cachetoast(pi) {
  let lastAssistant = '', compacting = false, timer = null;
  // Fail open: any error becomes a warning and Pi continues.
  const guarded = (ctx, action) => {
    try {
      const root = findRoot(ctx.cwd);
      return root ? action(root) : undefined;
    } catch (error) { ctx.ui.notify(`Cachetoast skipped this check: ${error.message}`, 'warning'); }
  };
  const hook = (root, ctx, event, extra) => handleHook(root, 'pi', {
    session_id: ctx.sessionManager.getSessionId(), hook_event_name: event,
    session_name: ctx.sessionManager.getSessionName?.(),
    context_tokens: ctx.getContextUsage()?.tokens ?? undefined, cache_ttl_guess: ttlGuess(ctx), ...extra
  });

  // Footer status, visible before the next prompt; a timer flips it to cold while idle. Errors just clear it.
  const status = ctx => {
    try {
      const root = findRoot(ctx.cwd);
      const state = root && ctx.isIdle() ? readJson(safePath(root, statePath(keyFor('pi', ctx.sessionManager.getSessionId())))) : null;
      const text = state && statusText({ ...state, contextTokens: ctx.getContextUsage()?.tokens }, policyFor(configAt(root), 'pi', { ...state, guessedTtl: ttlGuess(ctx) }));
      ctx.ui.setStatus('cachetoast', text ? (text.startsWith('cache cold') ? `${text} · /handoff` : text) : undefined);
    } catch { try { ctx.ui.setStatus('cachetoast', undefined); } catch {} }
  };
  pi.on('session_start', (_event, ctx) => {
    clearInterval(timer);
    timer = setInterval(() => status(ctx), 30_000);
    timer.unref?.();
    status(ctx);
  });
  pi.on('session_shutdown', () => { clearInterval(timer); timer = null; });
  pi.on('input', (event, ctx) => {
    // Only prompts that start a new run after idle; steering and queued follow-ups do not.
    if (event.source === 'extension' || event.streamingBehavior) return { action: 'continue' };
    const out = guarded(ctx, root => hook(root, ctx, 'UserPromptSubmit', { prompt: event.text }));
    if (out?.decision === 'block') {
      // Held once: the text goes back in the editor, so Enter sends it anyway.
      ctx.ui.notify(out.reason, 'warning');
      ctx.ui.setEditorText(event.text);
      return { action: 'handled' };
    }
    ctx.ui.setStatus('cachetoast', undefined);
    return { action: 'continue' };
  });
  pi.on('agent_end', event => {
    const last = [...(event.messages ?? [])].reverse().find(m => m.role === 'assistant');
    if (last) lastAssistant = messageText(last);
  });
  pi.on('agent_settled', (_event, ctx) => guarded(ctx, root => {
    hook(root, ctx, 'Stop', { last_assistant_message: lastAssistant });
    // Same context ceiling as Claude/Codex. Pi's compact() aborts a running turn, so only compact once idle.
    const tokens = ctx.getContextUsage()?.tokens;
    if (!compacting && ctx.isIdle() && Number.isFinite(tokens) && tokens >= configAt(root).targetTokens) {
      compacting = true;
      const done = () => { compacting = false; };
      ctx.compact({ onComplete: done, onError: done });
    }
    status(ctx);
  }));
  pi.registerCommand('handoff', {
    description: 'Cachetoast: open a fresh session with a handoff prompt',
    handler: async (_args, ctx) => {
      const root = findRoot(ctx.cwd);
      if (!root) return ctx.ui.notify('Cachetoast is not installed in this repo.', 'warning');
      const prompt = handoffFor(root, 'pi', ctx.sessionManager.getSessionId());
      const state = readJson(safePath(root, statePath(keyFor('pi', ctx.sessionManager.getSessionId())))) ?? {};
      const name = handoffName(root, { ...state, sessionName: ctx.sessionManager.getSessionName?.() || state.sessionName });
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async manager => { manager.appendSessionInfo(name); },
        // Only the replacement ctx is valid here; the prompt is plain data captured above.
        withSession: async next => {
          next.ui.setEditorText(prompt);
          next.ui.notify('Cachetoast: review the handoff prompt, then send it.', 'info');
        }
      });
    }
  });
}
