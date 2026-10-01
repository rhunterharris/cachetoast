import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../lib/install.mjs';
import { handleHook } from '../lib/runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetoast-demo-'));
// Keep the demo away from your real ~/.config/cachetoast.
process.env.XDG_CONFIG_HOME = path.join(root, '.config');
try {
  install(root);
  // A synthetic Codex transcript reporting a 180k-token context.
  const transcript = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date(0).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 180_000 } } } }) + '\n');
  const event = (name, at, extra) => handleHook(root, 'codex', { session_id: 'demo', hook_event_name: name, cwd: root, transcript_path: transcript, ...extra }, { now: at });
  event('UserPromptSubmit', 0, { prompt: 'Finish the parser. Keep the public API stable.' });
  event('Stop', 0, { last_assistant_message: 'Parser refactor is complete. Unicode tests remain.' });
  const result = event('UserPromptSubmit', 25 * 60_000, { prompt: 'Add the remaining unicode tests.' });
  console.log(result.reason);
  console.log('\n--- saved handoff ---\n' + fs.readFileSync(path.join(root, '.cachetoast/handoffs', fs.readdirSync(path.join(root, '.cachetoast/handoffs'))[0]), 'utf8'));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
