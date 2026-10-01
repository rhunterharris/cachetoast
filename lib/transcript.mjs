import fs from 'node:fs';

export const terse = (text, max = 1600) => String(text ?? '').replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').trim().slice(0, max);
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text ?? '').join('\n') : '';
const TAIL_BYTES = 1024 * 1024;

// Reads only the tail: the latest usage, response timestamp, and messages live there.
// Partial/malformed JSONL lines and tool content are ignored.
// Provider transcripts are unstable; these fields are evidence, not a semantic summary.
export function readTranscript(file, provider) {
  const result = { latestUser: '', assistant: '', summary: '', sessionName: '', contextTokens: null, lastActivity: null, cacheTtl: null, warnings: [] };
  if (!file) return result;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Transcript must be a regular file');
    const length = Math.min(stat.size, TAIL_BYTES), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    let lines = buffer.toString('utf8').split('\n');
    if (stat.size > length) lines = lines.slice(1);
    let customName = '', aiName = '';
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.isSidechain) continue;
      let user = '', assistant = '', summary = '', tokens = null, activity = false;
      if (provider === 'claude') {
        if (r.type === 'custom-title') customName = terse(r.customTitle, 200);
        if (r.type === 'ai-title') aiName = terse(r.aiTitle, 200);
        const m = r.message ?? {};
        if (r.type === 'user' && !r.isMeta) user = contentText(m.content);
        if (r.type === 'assistant') {
          assistant = contentText(m.content);
          const u = m.usage;
          if (u) {
            tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
            activity = true;
            // Each cache write records its TTL, so the latest write shows what this session actually gets
            // (1h on Pro/Max, 5m on API keys or usage credits), with no Claude settings read.
            const w = u.cache_creation ?? {};
            if (w.ephemeral_1h_input_tokens > 0) result.cacheTtl = '1h';
            else if (w.ephemeral_5m_input_tokens > 0) result.cacheTtl = '5m';
          }
        }
        if (r.isCompactSummary) { summary = contentText(m.content); user = ''; }
      } else {
        const p = r.payload ?? {};
        if (r.type === 'response_item' && p.type === 'message') {
          if (p.role === 'user') user = contentText(p.content);
          if (p.role === 'assistant') assistant = contentText(p.content);
        }
        if (r.type === 'event_msg' && p.type === 'token_count') {
          tokens = p.info?.last_token_usage?.total_tokens ?? null;
          activity = tokens !== null;
        }
        if (r.type === 'compacted') summary = p.message ?? '';
      }
      if (user) result.latestUser = terse(user);
      if (assistant) result.assistant = terse(assistant, 2400);
      if (summary) result.summary = terse(summary, 3000);
      if (Number.isFinite(tokens) && tokens >= 0) result.contextTokens = tokens;
      const ts = Date.parse(r.timestamp);
      if (activity && Number.isFinite(ts)) result.lastActivity = Math.max(result.lastActivity ?? 0, ts);
    }
    result.sessionName = customName || aiName;
  } catch (e) { result.warnings.push(`Transcript unavailable: ${e.message}`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return result;
}
