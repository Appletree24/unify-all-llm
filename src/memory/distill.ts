import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRun, type PlanSource } from '../core/store.js';
import { runOne } from '../core/orchestrator.js';
import { extractFinalPlan, synthesisFormatter } from '../core/synth.js';
import type { ModelTarget } from '../core/types.js';
import { editEntry, writeMemory } from './edit.js';
import { appendEntry, parseMemory, replaceLines } from './parse.js';
import { scanMemory, sha, writableTarget } from './scan.js';
import type { MemoryContext, MemoryFile, Scope } from './types.js';

export type DistillSourceScope = 'answer' | 'synthesis' | 'exec';

export interface DistillSourceRef {
  turnId: string;
  runId: string;
  scope: DistillSourceScope;
  selectedText?: string;
}

export interface DistillTargetOption {
  path: string;
  display: string;
  harnessId: string;
  harnessName: string;
  layerId: string;
  layerTitle: string;
  scope: Scope;
  exists: boolean;
  baseHash: string;
  headings: string[];
  sharedWith?: string[];
  /** True if native CLIs read this file directly from disk on next turn. */
  affectsNativeCli: boolean;
}

export interface DistillProvenance {
  turnId: string;
  runId: string;
  scope: DistillSourceScope;
  targetId: string;
  sourceLabel: string;
  excerpt: string;
  labels?: Record<string, string>;
  planSource?: PlanSource;
}

export interface DistillPreparation {
  question: string;
  scope: DistillSourceScope;
  sourceLabel: string;
  defaultText: string;
  /** For exec cards, both the adopted plan and execution report are exposed separately. */
  planText?: string;
  execOutcome?: string;
  targets: DistillTargetOption[];
  defaultTargetPath?: string;
  provenance: DistillProvenance;
}

export interface DistillCandidate {
  text: string;
  scopeHint: 'project' | 'user' | 'local';
  quote: string;
}

export interface DuplicateMatch {
  start: number;
  end: number;
  text: string;
  heading: string[];
  score: number;
}

export interface DuplicateCheckResult {
  exact?: DuplicateMatch;
  similar: DuplicateMatch[];
}

export interface DistillSaveRequest {
  source: DistillSourceRef;
  targetPath: string;
  text: string;
  heading?: string;
  mode?: 'append' | 'replace';
  replaceStart?: number;
  replaceEnd?: number;
  baseHash?: string;
}

export interface DistillPreviewResult {
  targetPath: string;
  display: string;
  baseHash: string;
  before: string;
  after: string;
  duplicates: DuplicateCheckResult;
  affectsNativeCli: boolean;
  readers: string[];
}

export interface DistillApplyResult {
  auditId: string;
  targetPath: string;
  display: string;
  savedText: string;
  affectsNativeCli: boolean;
  readers: string[];
}

const provenanceLogPath = (ctx: MemoryContext) => join(ctx.home, '.unify', 'memory-provenance.jsonl');

function normalizeRule(text: string): string {
  return text
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function bigrams(text: string): Set<string> {
  const s = normalizeRule(text).replace(/\s+/g, '');
  const out = new Set<string>();
  if (s.length <= 2) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function similarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (!ba.size || !bb.size) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return inter / (ba.size + bb.size - inter);
}

/**
 * Check exact duplicates (including short Chinese rules < 16 chars) and near-duplicate entries.
 */
export function checkMemoryDuplicates(ctx: MemoryContext, targetPath: string, candidateText: string): DuplicateCheckResult {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) return { similar: [] };
  const norm = normalizeRule(candidateText);
  if (!norm) return { similar: [] };
  const parsed = parseMemory(readFileSync(abs, 'utf8'));
  let exact: DuplicateMatch | undefined;
  const similar: DuplicateMatch[] = [];

  for (const e of parsed.entries) {
    if (e.kind === 'code') continue;
    const en = normalizeRule(e.text);
    if (!en) continue;
    if (en === norm) {
      exact ??= { start: e.start, end: e.end, text: e.text, heading: e.heading, score: 1 };
      continue;
    }
    const score = similarity(norm, en);
    if (score >= 0.45) {
      similar.push({ start: e.start, end: e.end, text: e.text, heading: e.heading, score });
    }
  }
  similar.sort((a, b) => b.score - a.score);
  return { ...(exact ? { exact } : {}), similar: similar.slice(0, 5) };
}

function collectTargetOptions(ctx: MemoryContext): { targets: DistillTargetOption[]; defaultTargetPath?: string } {
  const state = scanMemory(ctx);
  const seen = new Set<string>();
  const targets: DistillTargetOption[] = [];

  for (const hn of state.harnesses) {
    for (const l of hn.layers) {
      if (l.readonly) continue;
      for (const f of l.files) {
        if (!f.writable || f.shadowedBy) continue;
        const key = resolve(f.path);
        if (seen.has(key)) continue;
        seen.add(key);
        const headings = [...new Set(f.entries.map((e) => e.heading[e.heading.length - 1]).filter(Boolean))];
        targets.push({
          path: key,
          display: f.display,
          harnessId: hn.id,
          harnessName: hn.name,
          layerId: l.id,
          layerTitle: l.title,
          scope: l.scope,
          exists: f.exists,
          baseHash: f.exists ? (f.hash ?? '') : '',
          headings,
          sharedWith: f.sharedWith,
          affectsNativeCli: true,
        });
      }
    }
  }

  // Prefer an existing project AGENTS.md -> existing project CLAUDE.md -> uncreated project AGENTS.md -> first project file.
  const projectFiles = targets.filter((t) => t.scope === 'project');
  const defaultTarget =
    projectFiles.find((t) => t.exists && /(?:^|[\\/])AGENTS\.md$/i.test(t.path))
    ?? projectFiles.find((t) => t.exists && /(?:^|[\\/])CLAUDE\.md$/i.test(t.path))
    ?? projectFiles.find((t) => t.exists)
    ?? projectFiles.find((t) => /(?:^|[\\/])AGENTS\.md$/i.test(t.path))
    ?? targets[0];

  return { targets, defaultTargetPath: defaultTarget?.path };
}

/**
 * Prepare a distillation draft strictly from persisted RunRecord by (turnId, runId, scope).
 */
export function prepareDistill(ctx: MemoryContext, ref: DistillSourceRef): DistillPreparation {
  const run = loadRun(ctx.cwd, ref.turnId);
  let targetId = '';
  let sourceLabel = '';
  let body = '';
  let planText: string | undefined;
  let execOutcome: string | undefined;
  let labels: Record<string, string> | undefined;
  let planSource: PlanSource | undefined;

  if (ref.scope === 'synthesis') {
    if (!run.synthesis || run.synthesis.result.runId !== ref.runId || !run.synthesis.result.ok) {
      throw new Error('找不到对应的成功汇总记录');
    }
    const fmt = synthesisFormatter(run);
    targetId = run.synthesis.provider;
    const tLabel = run.targets.find((t) => t.id === targetId)?.label ?? targetId;
    sourceLabel = `汇总 · ${tLabel}`;
    labels = run.synthesis.labels;
    body = fmt(extractFinalPlan(run.synthesis.result.text));
  } else if (ref.scope === 'exec') {
    const res = run.results.find((r) => r.runId === ref.runId && r.ok);
    if (run.kind !== 'execution' || !res) {
      throw new Error('找不到对应的成功实施记录');
    }
    targetId = res.targetId;
    const tLabel = run.targets.find((t) => t.id === targetId)?.label ?? targetId;
    sourceLabel = `实施 · ${tLabel}`;
    planSource = run.planSource;
    planText = run.planSource?.planText?.trim();
    execOutcome = res.text.trim();
    body = planText || execOutcome;
  } else {
    const res = run.results.find((r) => r.runId === ref.runId && r.ok);
    if (!res) throw new Error('找不到对应的成功回答记录');
    targetId = res.targetId;
    const tLabel = run.targets.find((t) => t.id === targetId)?.label ?? targetId;
    sourceLabel = `回答 · ${tLabel}`;
    body = res.text.trim();
  }

  const chosen = ref.selectedText?.trim() || body;
  const { targets, defaultTargetPath } = collectTargetOptions(ctx);

  return {
    question: run.question,
    scope: ref.scope,
    sourceLabel,
    defaultText: chosen,
    ...(planText ? { planText } : {}),
    ...(execOutcome ? { execOutcome } : {}),
    targets,
    defaultTargetPath,
    provenance: {
      turnId: run.id,
      runId: ref.runId,
      scope: ref.scope,
      targetId,
      sourceLabel,
      excerpt: chosen.slice(0, 600),
      ...(labels ? { labels } : {}),
      ...(planSource ? { planSource } : {}),
    },
  };
}

function parseCandidatesJson(raw: string): DistillCandidate[] {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(trimmed);
  const text = fenced ? fenced[1].trim() : trimmed;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let arr: unknown;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: DistillCandidate[] = [];
  for (const item of arr.slice(0, 3)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    const scopeHint = r.scopeHint === 'user' || r.scopeHint === 'local' ? r.scopeHint : 'project';
    const quote = typeof r.quote === 'string' ? r.quote.trim() : '';
    const line = r.text.trim();
    out.push({ text: line.startsWith('-') ? line : `- ${line}`, scopeHint, quote });
  }
  return out;
}

/**
 * On-demand LLM distillation — invoked ONLY when the user explicitly clicks "提炼候选".
 * Runs completely isolated from main conversation history, excluding reasoning/tools/other answers/personal memory.
 */
export async function distillCandidates(
  ctx: MemoryContext,
  ref: DistillSourceRef,
  target: ModelTarget,
  timeoutMs = 60_000,
): Promise<DistillCandidate[]> {
  const prep = prepareDistill(ctx, ref);
  const material = ref.selectedText?.trim()
    || (prep.scope === 'exec'
      ? [prep.planText && `【采纳的方案】\n${prep.planText}`, prep.execOutcome && `【实施回报（仅作来源，勿自动视作已验证事实）】\n${prep.execOutcome}`].filter(Boolean).join('\n\n')
      : prep.defaultText);

  const prompt = `你是一名克制的技术文档编辑。请从下面一次对话材料中，提炼出真正值得长期复用的持久记忆（如项目规范、架构约束、环境踩坑、明确偏好）。

严格要求：
- 最多提炼 3 条；如果材料里都是一次性操作或没有长期复用的约定，直接返回空数组 []。
- 每条必须是一句简洁、可执行、脱离本次对话也能独立读懂的 Markdown 列表项（以 "- " 开头）。
- 仅基于给定材料提炼，不要编造未出现的事实，也不要把模型自称的“已完成”写成客观验证事实。
- 仅输出一个 JSON 数组，不要额外解释。数组元素格式为：
  {"text": "- 规则正文", "scopeHint": "project" | "user" | "local", "quote": "材料中对应的原句摘录"}

<original_question>
${prep.question}
</original_question>

<source_type>${prep.scope}</source_type>

<material>
${material.slice(0, 12_000)}
</material>`;

  const res = await runOne(target, {
    cwd: ctx.cwd,
    mode: 'ask',
    prompt,
    messages: [{ role: 'user', content: prompt }],
    timeoutMs,
  });
  if (!res.ok) throw new Error(res.error || '提炼候选失败');
  return parseCandidatesJson(res.text);
}

function findFileInfo(ctx: MemoryContext, targetPath: string): { display: string; readers: string[]; affectsNativeCli: boolean; file?: MemoryFile } {
  const state = scanMemory(ctx);
  const abs = resolve(targetPath);
  const readers = new Set<string>();
  let display = targetPath;
  let file: MemoryFile | undefined;
  for (const hn of state.harnesses) {
    for (const l of hn.layers) {
      const f = l.files.find((x) => resolve(x.path) === abs);
      if (f) {
        file ??= f;
        display = f.display;
        if (!f.shadowedBy) readers.add(hn.name);
        for (const s of f.sharedWith ?? []) readers.add(s);
      }
    }
  }
  return { display, readers: [...readers], affectsNativeCli: readers.size > 0, file };
}

export function previewDistillSave(ctx: MemoryContext, req: DistillSaveRequest): DistillPreviewResult {
  const state = scanMemory(ctx);
  const abs = resolve(req.targetPath);
  if (!writableTarget(state, abs)) throw new Error(`${req.targetPath} 不是可写入的记忆文件`);
  const cleanText = req.text.trim();
  if (!cleanText) throw new Error('记忆内容不能为空');
  const exists = existsSync(abs);
  const before = exists ? readFileSync(abs, 'utf8') : '';
  const baseHash = exists ? sha(before) : '';
  const mode = req.mode ?? 'append';
  const after = mode === 'replace'
    ? replaceLines(before, req.replaceStart!, req.replaceEnd!, cleanText)
    : appendEntry(before, cleanText, req.heading?.trim() || undefined);
  const info = findFileInfo(ctx, abs);
  const duplicates = checkMemoryDuplicates(ctx, abs, cleanText);
  return {
    targetPath: abs,
    display: info.display,
    baseHash,
    before,
    after,
    duplicates,
    affectsNativeCli: info.affectsNativeCli,
    readers: info.readers,
  };
}

/**
 * Save clean Markdown rule immediately to disk (using editEntry/writeMemory for backup & baseHash conflict guard)
 * and persist full provenance metadata in local audit log without polluting the Markdown file.
 */
export function applyDistillSave(ctx: MemoryContext, req: DistillSaveRequest): DistillApplyResult {
  const prep = prepareDistill(ctx, req.source);
  const abs = resolve(req.targetPath);
  const cleanText = req.text.trim();
  if (!cleanText) throw new Error('记忆内容不能为空');

  const beforeExists = existsSync(abs);
  const beforeHash = beforeExists ? sha(readFileSync(abs, 'utf8')) : '';

  if ((req.mode ?? 'append') === 'replace') {
    editEntry(ctx, {
      op: 'update',
      path: abs,
      baseHash: req.baseHash,
      start: req.replaceStart,
      end: req.replaceEnd,
      text: cleanText,
    });
  } else if (!beforeExists) {
    writeMemory(ctx, abs, appendEntry('', cleanText, req.heading?.trim() || undefined), req.baseHash ?? '', '沉淀记忆');
  } else {
    editEntry(ctx, {
      op: 'add',
      path: abs,
      baseHash: req.baseHash,
      text: cleanText,
      heading: req.heading?.trim() || undefined,
    });
  }

  const afterHash = sha(readFileSync(abs, 'utf8'));
  const auditId = randomUUID();
  const logFile = provenanceLogPath(ctx);
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  appendFileSync(logFile, JSON.stringify({
    id: auditId,
    time: Date.now(),
    cwd: ctx.cwd,
    targetPath: abs,
    mode: req.mode ?? 'append',
    heading: req.heading?.trim() || undefined,
    text: cleanText,
    beforeHash,
    afterHash,
    provenance: prep.provenance,
  }) + '\n', 'utf8');

  const info = findFileInfo(ctx, abs);
  return {
    auditId,
    targetPath: abs,
    display: info.display,
    savedText: cleanText,
    affectsNativeCli: info.affectsNativeCli,
    readers: info.readers,
  };
}
