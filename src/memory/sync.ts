import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite } from '../core/atomic-write.js';
import { writeMemory } from './edit.js';
import { scanMemory, sha, writableTarget } from './scan.js';
import type { MemoryContext, MemoryFile, MemoryState } from './types.js';

export const MANAGED_START = '<!-- unify:managed:start -->';
export const MANAGED_END = '<!-- unify:managed:end -->';

interface SyncRecord {
  sourcePath: string;
  sourceHash: string;
  blockHash: string;
  syncedAt: number;
}

type SyncStateMap = Record<string, SyncRecord>;

export type SyncPlanStatus = 'shared' | 'unchanged' | 'create' | 'update' | 'conflict' | 'blocked';

export interface SyncTargetPlan {
  targetPath: string;
  display: string;
  status: SyncPlanStatus;
  reason?: string;
  baseHash?: string;
  before?: string;
  after?: string;
  changedLines?: number;
}

export interface SyncPreviewResult {
  sourcePath: string;
  sourceHash: string;
  targets: SyncTargetPlan[];
}

export interface SyncApplyItemResult {
  targetPath: string;
  status: 'written' | 'unchanged' | 'shared' | 'skipped' | 'error';
  message?: string;
}

const syncStatePath = (ctx: MemoryContext) => join(ctx.home, '.unify', 'memory-sync-state.json');

function safeReal(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function readSyncState(ctx: MemoryContext): SyncStateMap {
  try {
    const raw = JSON.parse(readFileSync(syncStatePath(ctx), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function saveSyncState(ctx: MemoryContext, map: SyncStateMap): void {
  const path = syncStatePath(ctx);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, JSON.stringify(map, null, 2) + '\n');
}

function findScannedFile(state: MemoryState, absPath: string): MemoryFile | undefined {
  for (const h of state.harnesses) {
    for (const l of h.layers) {
      const hit = l.files.find((f) => resolve(f.path) === absPath);
      if (hit) return hit;
    }
  }
  return undefined;
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function locateManagedBlock(content: string): { kind: 'none' } | { kind: 'corrupt'; reason: string } | { kind: 'found'; startIdx: number; endIdx: number; inner: string } {
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; (i = content.indexOf(MANAGED_START, i)) >= 0; i += MANAGED_START.length) starts.push(i);
  for (let i = 0; (i = content.indexOf(MANAGED_END, i)) >= 0; i += MANAGED_END.length) ends.push(i);
  if (starts.length === 0 && ends.length === 0) return { kind: 'none' };
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return { kind: 'corrupt', reason: '目标文件的托管区块标记损坏或重复，已停止同步，请手动修复标记' };
  }
  const innerStart = starts[0] + MANAGED_START.length;
  const inner = content.slice(innerStart, ends[0]).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return { kind: 'found', startIdx: starts[0], endIdx: ends[0] + MANAGED_END.length, inner };
}

/**
 * Replace only the managed block, preserving every byte before and after it untouched.
 */
function buildManagedContent(before: string | undefined, sourceBody: string): { next: string; innerNormalized: string } {
  const innerNormalized = sourceBody.replace(/\r\n/g, '\n').trimEnd();
  const eol = before ? detectEol(before) : '\n';
  const bodyEol = innerNormalized.replace(/\n/g, eol);
  const block = `${MANAGED_START}${eol}${bodyEol}${bodyEol ? eol : ''}${MANAGED_END}`;

  if (before === undefined || before === '') {
    return { next: `${block}${eol}`, innerNormalized };
  }
  const loc = locateManagedBlock(before);
  if (loc.kind === 'found') {
    const next = before.slice(0, loc.startIdx) + block + before.slice(loc.endIdx);
    return { next, innerNormalized };
  }
  const suffix = before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol;
  return { next: `${before}${suffix}${block}${eol}`, innerNormalized };
}

function countChangedLines(a: string, b: string): number {
  const la = a ? a.split(/\r?\n/) : [];
  const lb = b ? b.split(/\r?\n/) : [];
  let diff = Math.abs(la.length - lb.length);
  const n = Math.min(la.length, lb.length);
  for (let i = 0; i < n; i++) if (la[i] !== lb[i]) diff++;
  return diff;
}

/**
 * Preview explicit one-way sync from a source memory file to one or more target memory files.
 * Zero-write when source and target share the same real file; stops on override shadowing or block conflict.
 */
export function previewMemorySync(ctx: MemoryContext, sourcePath: string, targetPaths: string[], force = false): SyncPreviewResult {
  const state = scanMemory(ctx);
  const srcAbs = resolve(sourcePath);
  if (!existsSync(srcAbs)) throw new Error(`源记忆文件不存在: ${sourcePath}`);
  const srcRaw = readFileSync(srcAbs, 'utf8');
  const srcBody = srcRaw.replace(/\r\n/g, '\n').trimEnd();
  const sourceHash = sha(srcBody);
  const srcReal = safeReal(srcAbs);
  const syncState = readSyncState(ctx);

  const targets: SyncTargetPlan[] = targetPaths.map((rawTarget) => {
    const abs = resolve(rawTarget);
    const scanned = findScannedFile(state, abs);
    const display = scanned?.display ?? rawTarget;

    if (safeReal(abs) === srcReal) {
      return { targetPath: abs, display, status: 'shared', reason: '与源文件为同一物理文件，无需同步写入' };
    }
    if (!writableTarget(state, abs) || (existsSync(abs) && !writableTarget(state, safeReal(abs)))) {
      return { targetPath: abs, display, status: 'blocked', reason: '目标路径不在允许写入的记忆槽位范围内' };
    }
    if (scanned?.shadowedBy) {
      return { targetPath: abs, display, status: 'blocked', reason: `目标文件被 ${scanned.shadowedBy} 取代，同步后也不会生效` };
    }

    const exists = existsSync(abs);
    const before = exists ? readFileSync(abs, 'utf8') : undefined;
    const baseHash = before === undefined ? '' : sha(before);

    if (before !== undefined) {
      const loc = locateManagedBlock(before);
      if (loc.kind === 'corrupt') {
        return { targetPath: abs, display, status: 'blocked', reason: loc.reason, baseHash };
      }
      if (loc.kind === 'found') {
        const curInnerHash = sha(loc.inner.replace(/\r\n/g, '\n').trimEnd());
        const prev = syncState[safeReal(abs)];
        if (!force && prev && curInnerHash !== prev.blockHash && curInnerHash !== sourceHash) {
          return {
            targetPath: abs, display, status: 'conflict',
            reason: '目标托管区块内容已被手工修改，已暂停同步以防覆盖（可检查后强制覆盖）',
            baseHash, before,
          };
        }
      }
    }

    const { next } = buildManagedContent(before, srcBody);
    if (before !== undefined && next === before) {
      return { targetPath: abs, display, status: 'unchanged', baseHash, before, after: next, changedLines: 0 };
    }
    return {
      targetPath: abs, display,
      status: exists ? 'update' : 'create',
      baseHash, before: before ?? '', after: next,
      changedLines: countChangedLines(before ?? '', next),
    };
  });

  return { sourcePath: srcAbs, sourceHash, targets };
}

/**
 * Execute one-way sync serially per target, verifying baseHash and preserving backups via writeMemory().
 */
export function applyMemorySync(
  ctx: MemoryContext,
  opts: { sourcePath: string; targetPaths: string[]; baseHashes?: Record<string, string>; force?: boolean },
): { results: SyncApplyItemResult[] } {
  const preview = previewMemorySync(ctx, opts.sourcePath, opts.targetPaths, !!opts.force);
  const syncState = readSyncState(ctx);
  const results: SyncApplyItemResult[] = [];
  const writtenReal = new Set<string>();

  for (const plan of preview.targets) {
    if (plan.status === 'shared') {
      results.push({ targetPath: plan.targetPath, status: 'shared', message: plan.reason });
      continue;
    }
    if (plan.status === 'unchanged') {
      results.push({ targetPath: plan.targetPath, status: 'unchanged', message: '内容已是最新' });
      continue;
    }
    if (plan.status === 'blocked' || plan.status === 'conflict') {
      results.push({ targetPath: plan.targetPath, status: 'skipped', message: plan.reason });
      continue;
    }

    const real = safeReal(plan.targetPath);
    if (writtenReal.has(real)) {
      results.push({ targetPath: plan.targetPath, status: 'shared', message: '指向已在本批次写入的同一文件' });
      continue;
    }

    const expectedHash = opts.baseHashes?.[plan.targetPath] ?? plan.baseHash;
    try {
      writeMemory(ctx, plan.targetPath, plan.after!, expectedHash, '同步共享记忆');
      writtenReal.add(safeReal(plan.targetPath));
      syncState[safeReal(plan.targetPath)] = {
        sourcePath: preview.sourcePath,
        sourceHash: preview.sourceHash,
        blockHash: preview.sourceHash,
        syncedAt: Date.now(),
      };
      results.push({ targetPath: plan.targetPath, status: 'written' });
    } catch (err) {
      results.push({ targetPath: plan.targetPath, status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  saveSyncState(ctx, syncState);
  return { results };
}
