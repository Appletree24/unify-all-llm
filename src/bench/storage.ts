import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-f0-9]{24}$/, '无效的评测 ID');
export const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
export const filename = (dir: string, id: string) => join(dir, idSchema.parse(id) + '.json');
export function ids(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^[a-f0-9]{24}\.json$/.test(f)).sort().map(f => f.slice(0, -5));
}

export function insert(dir: string, id: string, data: unknown) {
  const path = filename(dir, id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, randomUUID() + '.tmp');
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { linkSync(tmp, path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  finally { unlinkSync(tmp); }
}

export function withWriteLock<T>(dir: string, write: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'write.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`另一个进程正在写入，请稍后重试。如进程已退出，可移除 ${lock}`);
    throw err;
  }
  try { return write(); } finally { unlinkSync(lock); }
}
