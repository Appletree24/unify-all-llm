import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite } from '../core/atomic-write.js';
import type { Config } from '../core/config.js';
import type { ModelTarget } from '../core/types.js';
import { parseMemory } from './parse.js';

export const DEFAULT_SHARED_MEMORY_MAX_BYTES = 32 * 1024;
const MAX_READ_BYTES = 512 * 1024;

export type SharedMemoryScope = 'user' | 'project';

export interface MemorySnapshotItem {
  scope: SharedMemoryScope;
  /** Stable logical identifier independent of cwd/truncation, e.g. "user:memory.md" or "project:AGENTS.md". */
  logicalPath: string;
  /** Absolute source path at capture time (local audit only, never placed in model prefix). */
  sourcePath: string;
  hash: string;
  bytes: number;
  truncated?: boolean;
  unexpandedImports?: string[];
}

export interface MemorySnapshot {
  version: string;
  items: MemorySnapshotItem[];
  notices?: string[];
  overrides?: string[];
}

export interface ResolvedSharedMemory {
  snapshot: MemorySnapshot;
  /** Normalized content keyed by item hash. */
  blobs: Record<string, { scope: SharedMemoryScope; content: string }>;
}

export interface SharedMemoryResolveContext {
  cwd: string;
  home?: string;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function gitRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

function dirChain(from: string, to: string): string[] {
  const rel = relative(from, to);
  if (rel.startsWith('..') || isAbsolute(rel)) return [to];
  const out = [from];
  for (const part of rel.split(sep).filter(Boolean)) out.push(join(out[out.length - 1], part));
  return out;
}

function safeRealpath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function readNormalized(path: string): { content: string; bytes: number; truncated: boolean; unexpandedImports: string[] } | undefined {
  let st;
  try {
    st = statSync(path);
    if (!st.isFile()) return undefined;
  } catch { return undefined; }
  let raw: string;
  try {
    const buf = readFileSync(path);
    if (buf.subarray(0, 8192).includes(0)) return undefined;
    raw = (buf.length > MAX_READ_BYTES ? buf.subarray(0, MAX_READ_BYTES) : buf).toString('utf8');
  } catch { return undefined; }
  const normalized = raw.replace(/\r\n/g, '\n').trimEnd();
  if (!normalized.trim()) return undefined;
  const parsed = parseMemory(normalized);
  const unexpandedImports = parsed.imports.map((i) => i.target);
  return {
    content: normalized,
    bytes: Buffer.byteLength(normalized, 'utf8'),
    truncated: st.size > MAX_READ_BYTES,
    unexpandedImports,
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes));
  // Decode cleanly without broken trailing replacement char
  let out = buf.toString('utf8');
  if (out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return out.trimEnd() + '\n... [记忆内容超出预算，已截断]';
}

/**
 * Lightweight, bounded shared-memory resolver for API targets.
 * Never scans subdirectories recursively and never runs git blame.
 */
export function resolveSharedMemory(ctx: SharedMemoryResolveContext, config: Config = {}): ResolvedSharedMemory {
  const cwd = resolve(ctx.cwd);
  const home = resolve(ctx.home ?? homedir());
  const root = gitRoot(cwd);
  const memCfg = config.memory;
  const projectSource = memCfg?.projectSource ?? 'auto';
  const maxBytes = memCfg?.maxBytes ?? DEFAULT_SHARED_MEMORY_MAX_BYTES;

  const items: MemorySnapshotItem[] = [];
  const blobs: Record<string, { scope: SharedMemoryScope; content: string }> = {};
  const notices: string[] = [];
  const overrides: string[] = [];
  const seenReal = new Set<string>();
  let remaining = maxBytes;

  const tryAdd = (scope: SharedMemoryScope, logicalPath: string, filePath: string): boolean => {
    const real = safeRealpath(filePath);
    if (seenReal.has(real)) return false;
    const read = readNormalized(filePath);
    if (!read) return false;
    if (remaining <= 0) {
      notices.push(`${logicalPath} 超出共享记忆 ${Math.round(maxBytes / 1024)} KiB 上限，已跳过`);
      return false;
    }
    seenReal.add(real);
    let content = read.content;
    let truncated = read.truncated;
    let bytes = read.bytes;
    if (bytes > remaining) {
      content = truncateUtf8(content, remaining);
      bytes = Buffer.byteLength(content, 'utf8');
      truncated = true;
      notices.push(`${logicalPath} 超出共享记忆剩余预算，已截断`);
    }
    remaining = Math.max(0, remaining - bytes);
    const hash = sha(content);
    blobs[hash] = { scope, content };
    items.push({
      scope,
      logicalPath,
      sourcePath: resolve(filePath),
      hash,
      bytes,
      ...(truncated ? { truncated: true } : {}),
      ...(read.unexpandedImports.length ? { unexpandedImports: read.unexpandedImports } : {}),
    });
    if (read.unexpandedImports.length) {
      notices.push(`${logicalPath} 含未展开的 @import（${read.unexpandedImports.join('、')}），纯文本模型仅收到正文`);
    }
    return true;
  };

  // 1. Optional user-level shared memory (only when explicitly enabled in user config).
  if (memCfg?.userEnabled) {
    const userFile = memCfg.userPath ? resolve(memCfg.userPath.startsWith('~') ? join(home, memCfg.userPath.slice(1)) : memCfg.userPath) : join(home, '.unify', 'memory.md');
    tryAdd('user', 'user:memory.md', userFile);
  }

  // 2. Project-level chain from git root down to cwd (at most one file per directory).
  if (projectSource !== 'off') {
    const dirs = dirChain(root, cwd);
    for (const dir of dirs) {
      const relDir = relative(root, dir).split(sep).filter(Boolean).join('/');
      const prefix = relDir ? `${relDir}/` : '';

      const overridePath = join(dir, 'AGENTS.override.md');
      if (existsSync(overridePath)) {
        overrides.push(`${prefix}AGENTS.override.md`);
      }

      if (projectSource === '.unify/memory.md') {
        if (dir === root) tryAdd('project', 'project:.unify/memory.md', join(root, '.unify', 'memory.md'));
        continue;
      }

      if (projectSource === 'AGENTS.md' || projectSource === 'CLAUDE.md') {
        tryAdd('project', `project:${prefix}${projectSource}`, join(dir, projectSource));
        continue;
      }

      // 'auto': prefer AGENTS.md, fall back to CLAUDE.md
      const agentsPath = join(dir, 'AGENTS.md');
      const claudePath = join(dir, 'CLAUDE.md');
      const hasAgents = existsSync(agentsPath);
      const hasClaude = existsSync(claudePath);
      if (hasAgents) {
        const added = tryAdd('project', `project:${prefix}AGENTS.md`, agentsPath);
        if (added && hasClaude && safeRealpath(agentsPath) !== safeRealpath(claudePath)) {
          notices.push(`${prefix}AGENTS.md 与 ${prefix}CLAUDE.md 同时存在，API 共享记忆默认采用 ${prefix}AGENTS.md`);
        }
      } else if (hasClaude) {
        tryAdd('project', `project:${prefix}CLAUDE.md`, claudePath);
      }
    }
  }

  if (overrides.length) {
    notices.push(`检测到 ${overrides.join('、')}，Codex CLI 会优先读取覆盖文件而非共享主源`);
  }

  const version = items.length ? sha(items.map((i) => `${i.scope}:${i.logicalPath}:${i.hash}`).join('\n')) : '';
  return {
    snapshot: {
      version,
      items,
      ...(notices.length ? { notices } : {}),
      ...(overrides.length ? { overrides } : {}),
    },
    blobs,
  };
}

/**
 * Determine whether a target is permitted to receive user-level personal shared memory.
 * Controlled strictly by user config so project configs cannot exfiltrate user preferences.
 */
export function canReceiveUserMemory(target: ModelTarget, config: Config): boolean {
  const memCfg = config.memory;
  if (!memCfg?.userEnabled) return false;
  if (memCfg.userAllowTargets) {
    return memCfg.userAllowTargets.includes(target.id) || memCfg.userAllowTargets.includes(target.adapter.id);
  }
  // Default policy when userEnabled is true and no allowlist is set:
  // allow official APIs, block arbitrary custom endpoints unless explicitly allowlisted.
  return !config.custom?.[target.id] && !config.custom?.[target.adapter.id];
}

function projectSnapshotDir(cwd: string): string {
  return join(cwd, '.unify', 'memory-snapshots');
}

function userSnapshotDir(home = homedir()): string {
  return join(home, '.unify', 'memory-snapshots');
}

/**
 * Persist snapshot blobs with strict privacy isolation:
 * project items stay in `<cwd>/.unify/memory-snapshots/`,
 * user items stay ONLY in `<home>/.unify/memory-snapshots/`.
 */
export function saveMemorySnapshots(cwd: string, resolved: ResolvedSharedMemory, home = homedir()): void {
  for (const [hash, blob] of Object.entries(resolved.blobs)) {
    const dir = blob.scope === 'user' ? userSnapshotDir(home) : projectSnapshotDir(cwd);
    const file = join(dir, `${hash}.md`);
    if (existsSync(file)) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWrite(file, blob.content);
  }
}

export function loadMemoryBlob(cwd: string, item: MemorySnapshotItem, home = homedir(), inMemory?: ResolvedSharedMemory['blobs']): string {
  const cached = inMemory?.[item.hash]?.content;
  if (cached !== undefined) return cached;
  const dir = item.scope === 'user' ? userSnapshotDir(home) : projectSnapshotDir(cwd);
  const file = join(dir, `${item.hash}.md`);
  if (!existsSync(file)) {
    throw new Error(`找不到记忆快照 ${item.logicalPath}（${item.hash}），可能已被清理，无法精确重放`);
  }
  return readFileSync(file, 'utf8');
}

/**
 * Build deterministic, KV-cache-friendly static memory prefix.
 * Contains ONLY stable logical paths and normalized content — never timestamps, runIds, or bundle hashes.
 */
export function formatSharedMemoryPrompt(
  cwd: string,
  snapshot: MemorySnapshot | undefined,
  opts: { includeUser: boolean; home?: string; blobs?: ResolvedSharedMemory['blobs'] },
): { text: string; items: MemorySnapshotItem[] } {
  if (!snapshot?.items.length) return { text: '', items: [] };
  const selected = snapshot.items.filter((i) => i.scope === 'project' || opts.includeUser);
  if (!selected.length) return { text: '', items: [] };
  const sections = selected.map((item) => {
    const body = loadMemoryBlob(cwd, item, opts.home, opts.blobs);
    return `<memory source="${item.logicalPath}">\n${body}\n</memory>`;
  });
  const text = `以下是 Unify 按固定层级顺序提供的持久记忆（用户层在前，项目层越靠后越具体、冲突时优先生效）：\n\n${sections.join('\n\n')}`;
  return { text, items: selected };
}

/** Append-only tail delta for mid-session newly saved memories without mutating the cached system prefix. */
export function formatMemoryUpdateDelta(updates: readonly string[] | undefined): string {
  const clean = (updates ?? []).map((u) => u.trim()).filter(Boolean);
  if (!clean.length) return '';
  return `<memory-update>\n以下是在当前对话中新沉淀的持久记忆，请在本轮及后续回答中遵循：\n${clean.map((u) => (u.startsWith('-') ? u : `- ${u}`)).join('\n')}\n</memory-update>`;
}
