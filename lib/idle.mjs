// Host-neutral, single-shot timer. Hosts supply their own clock and native compaction API.
// Bundled into Claude's sandboxed module as well as imported by Pi.
export function createIdleCompactor({ read, record, compact, now, after, onError }) {
  let timer, revision = 0, running = false;
  const cancel = () => { revision++; timer?.cancel(); timer = undefined; };
  const eligible = s => s && s.lastActivity != null && Number.isFinite(s.contextTokens)
    && s.contextTokens >= s.p.minContextTokens && s.compaction?.activityId !== s.activityId;
  const arm = async () => {
    cancel();
    const ticket = revision;
    try {
      const s = await read(), time = await now();
      if (ticket !== revision || running || !eligible(s) || time >= s.lastActivity + s.p.ttlMs) return;
      timer = after(Math.max(0, s.lastActivity + s.p.idleMs - time), async () => {
        timer = undefined;
        try {
          const current = await read(), firedAt = await now();
          if (ticket !== revision || running || !eligible(current) || current.activityId !== s.activityId
            || current.lastActivity !== s.lastActivity || firedAt < current.lastActivity + current.p.idleMs
            || firedAt >= current.lastActivity + current.p.ttlMs) return;
          if (!await record(s, 'attempting') || ticket !== revision) return;
          running = true;
          try {
            const result = await compact();
            await record(s, result?.skip ? 'skipped' : 'succeeded', result);
          } catch (error) {
            await record(s, 'failed', { skip: error.message });
            throw error;
          } finally { running = false; }
        } catch (error) { onError(error); }
      });
    } catch (error) { onError(error); }
  };
  return { arm, cancel, isRunning: () => running };
}
