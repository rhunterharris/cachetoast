export const DEFAULT_TARGET = 250_000;
export const DEFAULT_MIN_CONTEXT = 100_000;
export const CACHE_TTLS = Object.freeze({ '5m': 300_000, '30m': 1_800_000, '1h': 3_600_000, '24h': 86_400_000 });

export function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

// Idle deadline is the TTL minus a margin of at most five minutes (5m -> 4m, 30m -> 25m, 1h -> 55m).
export function policy(options = {}) {
  // Without a TTL, assume 30m: the shortest lifetime for large-context models other than Claude's 5m,
  // which Claude sessions report themselves.
  const cacheTtl = options.cacheTtl ?? '30m';
  if (!Object.hasOwn(CACHE_TTLS, cacheTtl)) throw new Error(`Unknown cache TTL: ${cacheTtl} (use ${Object.keys(CACHE_TTLS).join(', ')})`);
  const ttlMs = CACHE_TTLS[cacheTtl];
  const p = {
    cacheTtl, ttlMs,
    idleMs: ttlMs - Math.min(300_000, ttlMs / 5),
    targetTokens: options.targetTokens ?? DEFAULT_TARGET,
    minContextTokens: options.minContextTokens ?? DEFAULT_MIN_CONTEXT
  };
  positive(p.targetTokens, 'targetTokens'); positive(p.minContextTokens, 'minContextTokens');
  return p;
}

// This is a policy deadline, not an observation of the provider's cache.
// Small or unmeasured contexts never warn: a fresh session's re-grounding can cost more than the cache miss.
export function evaluate(session, p = policy(), now = Date.now()) {
  const idleForMs = session.lastActivity == null ? null : Math.max(0, now - session.lastActivity);
  const large = Number.isFinite(session.contextTokens) && session.contextTokens >= p.minContextTokens;
  const due = large && idleForMs !== null && idleForMs >= p.idleMs;
  return {
    action: due ? 'handoff' : 'wait',
    idleForMs,
    contextTokens: session.contextTokens ?? null,
    cacheTtl: p.cacheTtl
  };
}

// Short status for the Pi footer, shown before the next prompt. Null when the session is small or unmeasured.
export function statusText(session, p = policy(), now = Date.now()) {
  if (!Number.isFinite(session.contextTokens) || session.contextTokens < p.minContextTokens || session.lastActivity == null) return null;
  const size = `${Math.round(session.contextTokens / 1000)}k`, left = p.idleMs - (now - session.lastActivity);
  return left > 0 ? `cache warm ${Math.ceil(left / 60_000)}m · ${size}` : `cache cold · ${size}`;
}

// Keep the explanation separate from the action and copyable handoff command.
export function holdNotice(result = {}, next = '') {
  const size = Number.isFinite(result.contextTokens) ? `~${Math.round(result.contextTokens / 1000)}k-token ` : '';
  const idle = Number.isFinite(result.idleForMs) ? ` has been idle ${Math.round(result.idleForMs / 60_000)} min` : ' has been idle';
  const ttl = result.cacheTtl ? ` with a ${result.cacheTtl} cache TTL` : '';
  const lead = `Cachetoast held this prompt!\n\nThis ${size}session${idle}${ttl}, so its prompt cache has likely expired and continuing would re-read it all as uncached input.`;
  return next ? `${lead}\n${next}` : lead;
}
