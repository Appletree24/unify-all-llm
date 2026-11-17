import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appendEntry, replaceLines } from './parse.js';
import { scanMemory, sha, writableTarget } from './scan.js';
import type { MemoryContext } from './types.js';

/** The file changed on disk after it was read; nothing was written. */
export class ConflictError extends Error {
  constructor(public path: string) { super('文件已在别处被修改，请刷新后再保存'); }
}

export interface Backup {
  id: string;
  path: string;
  time: number;
  reason: string;
  bytes: number;
}

const backupDir = (ctx: MemoryContext) => join(ctx.home, '.unify', 'memory-backups');
const MAX_BACKUPS = 200;

function current(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function guard(ctx: MemoryContext, path: string): string {
  const target = resolve(path);
  if (!writableTarget(scanMemory(ctx), target)) throw new Error(`${target} 不是可编辑的记忆文件`);
  return target;
}

/** Keep the previous content so every change made here can be undone. */
function backup(ctx: MemoryContext, path: string, content: string, reason: string): void {
  const dir = backupDir(ctx);
  mkdirSync(dir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, path, time: Date.now(), reason, content }));
  const all = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) rmSync(join(dir, old), { force: true });
}

function atomicWrite(path: string, content: string): void {
  // Write through a symlink (CLAUDE.md → AGENTS.md) instead of replacing it.
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, target); } catch (err) { rmSync(tmp, { force: true }); throw err; }
}

/**
 * Create or replace a memory file. `baseHash` is the hash the editor started
 * from ('' for a file that did not exist); a mismatch means someone else, often
 * the harness itself, wrote in between.
 */
export function writeMemory(ctx: MemoryContext, path: string, content: string, baseHash: string | undefined, reason = '编辑'): { hash: string } {
  const target = guard(ctx, path);
  const before = current(target);
  if (baseHash !== undefined && (before === undefined ? '' : sha(before)) !== baseHash) throw new ConflictError(target);
  if (before === content) return { hash: sha(content) };
  if (before !== undefined) backup(ctx, target, before, reason);
  atomicWrite(target, content);
  return { hash: sha(content) };
}

export function deleteMemory(ctx: MemoryContext, path: string, baseHash?: string): void {
  const target = guard(ctx, path);
  const before = current(target);
  if (before === undefined) return;
  if (baseHash !== undefined && sha(before) !== baseHash) throw new ConflictError(target);
  backup(ctx, target, before, '删除文件');
  rmSync(target);
}

export interface EntryEdit {
  op: 'update' | 'delete' | 'add' | 'copy' | 'move';
  path: string;
  baseHash?: string;
  /** Line range of the entry (update, delete, copy, move). */
  start?: number;
  end?: number;
  /** New text (update, add). */
  text?: string;
  /** Heading to file an added or copied entry under. */
  heading?: string;
  /** Destination file (copy, move). */
  to?: string;
}

/** Change a single remembered item, leaving the rest of the file byte-for-byte alone. */
export function editEntry(ctx: MemoryContext, e: EntryEdit): void {
  const source = current(resolve(e.path));
  const range = (): [number, number] => {
    if (source === undefined) throw new Error('文件不存在');
    if (!e.start || !e.end) throw new Error('缺少行范围');
    return [e.start, e.end];
  };
  if (e.op === 'add') {
    if (!e.text?.trim()) throw new Error('内容不能为空');
    writeMemory(ctx, e.path, appendEntry(source ?? '', e.text, e.heading), e.baseHash ?? (source === undefined ? '' : undefined), '新增记忆');
  } else if (e.op === 'update') {
    if (!e.text?.trim()) throw new Error('内容不能为空；要移除请用删除');
    writeMemory(ctx, e.path, replaceLines(source!, ...range(), e.text), e.baseHash, '修改记忆');
  } else if (e.op === 'delete') {
    writeMemory(ctx, e.path, replaceLines(source!, ...range(), ''), e.baseHash, '删除记忆');
  } else {
    if (!e.to) throw new Error('缺少目标文件');
    if (resolve(e.to) === resolve(e.path)) throw new Error('目标与来源是同一个文件');
    const [start, end] = range();
    if (e.baseHash !== undefined && sha(source!) !== e.baseHash) throw new ConflictError(resolve(e.path));
    const text = source!.split(/\r?\n/).slice(start - 1, end).join('\n');
    // Write the destination first: a failure there must not lose the item.
    writeMemory(ctx, e.to, appendEntry(current(resolve(e.to)) ?? '', text, e.heading), undefined, e.op === 'move' ? '移入记忆' : '复制记忆');
    if (e.op === 'move') writeMemory(ctx, e.path, replaceLines(source!, start, end, ''), e.baseHash, '移出记忆');
  }
}

export function listBackups(ctx: MemoryContext, path?: string): Backup[] {
  const dir = backupDir(ctx);
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { return []; }
  const out: Backup[] = [];
  for (const name of names) {
    try {
      const b = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!path || b.path === resolve(path)) out.push({ id: b.id, path: b.path, time: b.time, reason: b.reason, bytes: Buffer.byteLength(b.content) });
    } catch { /* a damaged backup is skipped, not fatal */ }
  }
  return out;
}

export function readBackup(ctx: MemoryContext, id: string): { path: string; content: string } {
  if (!/^[\w-]+$/.test(id)) throw new Error('无效的备份 id');
  const b = JSON.parse(readFileSync(join(backupDir(ctx), `${id}.json`), 'utf8'));
  return { path: b.path, content: b.content };
}

/** Put a backed-up version back. The version it replaces is itself backed up. */
export function restoreBackup(ctx: MemoryContext, id: string): { path: string } {
  const b = readBackup(ctx, id);
  writeMemory(ctx, b.path, b.content, undefined, '恢复备份');
  return { path: b.path };
}
