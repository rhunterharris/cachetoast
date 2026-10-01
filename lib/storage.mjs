import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export const keyFor = (provider, id) => `${provider}-${hash(String(id)).slice(0, 24)}`;
export function safePath(root, relative) {
  root = path.resolve(root);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('Path escapes repository');
  let cursor = root;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Repository root must not be a symlink');
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink: ${cursor}`);
  }
  return target;
}
export function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function readJson(file, fallback = null) {
  const text = readText(file);
  return text ? JSON.parse(text) : fallback;
}
export const atomicWrite = (root, relative, value) => writeFileAtomic(safePath(root, relative), value);
export function writeFileAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
