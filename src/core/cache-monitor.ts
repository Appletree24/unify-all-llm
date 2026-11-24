import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { httpMessages, type ChatMessage, type ModelTarget, type RunResult, type RunRequest } from './types.js';
import type { CallRecord } from './store.js';

export interface CacheBaseline {
  id: string;
  prompt: string;
  messages?: ChatMessage[];
  expected: 'append' | 'exact' | 'material';
  inputTokens?: number;
  cachedTokens?: number;
}

export interface CacheContext {
  scope: CallRecord['scope'] | 'benchmark' | 'distill' | 'model-check';
  project?: string;
  home?: string;
  turnId?: string;
  sessionId?: string;
  baseline?: CacheBaseline;
  reason?: string;
  expectedNative?: boolean;
  warn?(message: string): void;
}

const count = z.number().nonnegative();
const sampleSchema = z.object({
  id: z.string(), at: z.number(), project: z.string(), target: z.string(), provider: z.string(), model: z.string().optional(),
  scope: z.string(), updatedAt: z.number().optional(), sessionId: z.string().optional(), turnId: z.string().optional(), baselineId: z.string().optional(),
  transport: z.enum(['messages', 'prompt', 'native-resume', 'native-fork']),
  phase: z.enum(['submitted', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  comparison: z.string(), matchedBytes: count.optional(), expectedBytes: count.optional(),
  inputTokens: count.optional(), cachedTokens: count.optional(), writeTokens: count.optional(),
  warnings: z.array(z.string()),
  preflightAlert: z.boolean().optional(), usageAlert: z.boolean().optional(),
});
export type CacheSample = z.infer<typeof sampleSchema>;
export interface CacheReport {
  calls: CacheSample[];
  reported: number;
  warned: number;
  preflightAlerts: number;
  usageAlerts: number;
  cachedTokens: number;
}

// Compare content bytes in order, respecting message boundaries. These are client-visible
// bytes, not a guess at the provider's tokenizer, injected system prompt, or KV contents.
function compareInput(base: CacheBaseline, req: Pick<RunRequest, 'messages' | 'prompt'>) {
  const before = base.messages ?? [{ role: 'prompt', content: base.prompt }];
  const after = req.messages ?? [{ role: 'prompt', content: req.prompt }];
  let matchedBytes = 0;
  const expectedBytes = before.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0);
  for (const [i, old] of before.entries()) {
    const next = after[i];
    const name = base.messages ? '第 ' + (i + 1) + ' 条消息（' + old.role + '）' : '提示词';
    if (!next || old.role !== next.role) return { matchedBytes, expectedBytes, difference: name + '的角色或位置改变' };
    if (old.content === next.content) {
      matchedBytes += Buffer.byteLength(old.content);
      continue;
    }
    const extendLast = i === before.length - 1 && (base.expected === 'material' || (!base.messages && base.expected === 'append'));
    if (extendLast && next.content.startsWith(old.content)) {
      matchedBytes += Buffer.byteLength(old.content);
      continue;
    }
    const a = Buffer.from(old.content), b = Buffer.from(next.content);
    let offset = 0;
    while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
    return { expectedBytes, matchedBytes: matchedBytes + offset, difference: name + '从第 ' + (offset + 1) + ' 字节起发生变化' };
  }
  const difference = base.expected === 'exact' && before.length !== after.length ? '重试时消息数改变' : undefined;
  return { matchedBytes, expectedBytes, difference };
}

const days = 7;
const historyLimit = 100;
const dayMs = 86_400_000;
const dayName = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const logName = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const logDir = (home = homedir()) => join(home, '.unify', 'cache-monitor');
const lastCleanup = new Map<string, string>();

function record(sample: CacheSample, home?: string): void {
  const dir = logDir(home);
  const now = Date.now(), day = dayName(now);
  sample.updatedAt = now;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One short append per snapshot, independent across CLI and Desktop processes.
  appendFileSync(join(dir, day + '.jsonl'), JSON.stringify(sample) + '\n', { mode: 0o600 });
  if (lastCleanup.get(dir) === day) return;
  lastCleanup.set(dir, day);
  const earliest = dayName(now - (days - 1) * dayMs);
  for (const name of readdirSync(dir)) {
    if (logName.test(name) && name.slice(0, 10) < earliest) {
      try { unlinkSync(join(dir, name)); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  }
}

export function monitorCache(target: ModelTarget, req: Pick<RunRequest, 'prompt' | 'messages' | 'cwd' | 'conversation' | 'mode'>,
  result: RunResult, ctx?: CacheContext) {
  const native = !!req.conversation?.resumeId;
  const config = target.adapter.configuration;
  const messages = config?.type === 'openai' ? httpMessages(req, config.system) : req.messages;
  const sample: CacheSample = {
    id: result.runId, at: Date.now(), project: ctx?.project ?? req.cwd, target: target.id, provider: target.adapter.id,
    model: target.model ?? (config?.type === 'openai' ? config.model : undefined),
    scope: ctx?.scope ?? req.mode, sessionId: ctx?.sessionId, turnId: ctx?.turnId, baselineId: ctx?.baseline?.id,
    transport: native ? (req.conversation?.fork ? 'native-fork' : 'native-resume') : messages ? 'messages' : 'prompt',
    phase: 'submitted', comparison: ctx?.reason ?? '无可比基线', warnings: [],
  };
  let storageError = false;
  let finished = false;
  const write = () => {
    try { record(sample, ctx?.home); }
    catch {
      if (!storageError) ctx?.warn?.('缓存监控记录写入失败');
      storageError = true;
    }
  };
  const warn = (kind: 'preflightAlert' | 'usageAlert', message: string) => {
    if (sample.warnings.includes(message)) return;
    sample.warnings.push(message);
    sample[kind] = true;
    result.cacheWarnings = [...sample.warnings];
    ctx?.warn?.(message);
  };
  const base = ctx?.baseline;
  if (native) sample.comparison = '请求续接原生上下文';
  else if (base) {
    const { difference, matchedBytes, expectedBytes } = compareInput(base, { prompt: req.prompt, messages });
    Object.assign(sample, { matchedBytes, expectedBytes });
    sample.comparison = difference ? '前缀变化' : '预期前缀一致';
    if (difference) warn('preflightAlert', '发送前发现' + difference + '，匹配 ' + matchedBytes + ' / ' + expectedBytes + ' 字节');
  }
  const publicReplay = () => {
    if (finished || sample.comparison === '原生会话回退') return;
    sample.transport = 'prompt';
    sample.comparison = '原生会话回退';
    warn('preflightAlert', '原生上下文未能续接，本次使用公共历史回放');
    write();
  };
  if (!native && ctx?.expectedNative) publicReplay();
  else write();
  return {
    publicReplay,
    finish() {
      finished = true;
      sample.phase = result.status === 'running' ? 'submitted' : result.status;
      sample.cachedTokens = result.usage?.cachedInputTokens;
      sample.inputTokens = result.usage?.inputTokens;
      sample.writeTokens = result.usage?.cacheWriteTokens;
      // Multi-step native runs aggregate different amounts of tool work. Flag a confirmed
      // zero on a substantial warm continuation, not a percentage drop between those totals.
      const prev = base?.cachedTokens;
      const httpDrop = sample.transport === 'messages' && prev !== undefined &&
        sample.cachedTokens !== undefined && sample.cachedTokens <= prev / 2;
      const nativeMiss = native && sample.cachedTokens === 0 && (sample.inputTokens ?? 0) >= 1024;
      if (result.ok && prev !== undefined && prev >= 1024 && (httpDrop || nativeMiss)) {
        warn('usageAlert', '供应商上报的缓存读取从 ' + prev + ' 降至 ' + sample.cachedTokens + ' tokens');
      } else if (result.ok && sample.transport === 'messages' && base?.expected !== 'material' &&
        sample.comparison === '预期前缀一致' && (base?.inputTokens ?? 0) >= 2048 && sample.cachedTokens === 0) {
        warn('usageAlert', '前缀一致，上次输入至少 2048 tokens，本次缓存读取为 0，可核对缓存时效与路由');
      }
      write();
    },
  };
}

// Read from the end so polling a busy project costs at most the recent window.
async function readLatest(path: string, rows: Map<string, CacheSample>) {
  const file = await open(path, 'r');
  try {
    let end = (await file.stat()).size;
    let partial = Buffer.alloc(0);
    while (end > 0 && rows.size < historyLimit) {
      const size = Math.min(end, 64 * 1024);
      const buffer = Buffer.allocUnsafe(size);
      end -= size;
      const { bytesRead } = await file.read(buffer, 0, size, end);
      const chunk = Buffer.concat([buffer.subarray(0, bytesRead), partial]);
      let right = chunk.length;
      while (right > 0 && rows.size < historyLimit) {
        const left = chunk.lastIndexOf(10, right - 1);
        if (left < 0 && end > 0) break;
        if (left + 1 < right) {
          try {
            const row = sampleSchema.parse(JSON.parse(chunk.toString('utf8', left + 1, right)));
            if (!rows.has(row.id)) rows.set(row.id, row);
          } catch { /* Ignore an interrupted or partial final append. */ }
        }
        right = left;
      }
      partial = chunk.subarray(0, Math.max(0, right));
    }
  } finally { await file.close(); }
}

export async function readCacheReport(home?: string): Promise<CacheReport> {
  const dir = logDir(home);
  let names: string[];
  try { names = await readdir(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    names = [];
  }
  const rows = new Map<string, CacheSample>();
  const earliest = dayName(Date.now() - (days - 1) * dayMs);
  for (const name of names.filter(n => logName.test(n) && n.slice(0, 10) >= earliest).sort().reverse()) {
    try { await readLatest(join(dir, name), rows); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    if (rows.size >= historyLimit) break;
  }
  const calls = [...rows.values()];
  return { calls, reported: calls.filter(c => c.cachedTokens !== undefined).length, warned: calls.filter(c => c.warnings.length).length,
    preflightAlerts: calls.filter(c => c.preflightAlert).length, usageAlerts: calls.filter(c => c.usageAlert).length,
    cachedTokens: calls.reduce((sum, c) => sum + (c.cachedTokens ?? 0), 0) };
}
