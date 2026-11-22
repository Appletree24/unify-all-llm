import { atomicWrite } from './atomic-write.js';
import { formatMemoryReferences } from '../memory/report.js';
import { extractFinalPlan, synthesisFormatter } from './synth.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import { customSchema, effortSchema, readJson } from './config.js';
export { loadConfig, type Config } from './config.js';

const safeId = z.string().regex(/^[\w-]+$/);
const capabilities = z.object({
  askPolicy: z.enum(['read-tools', 'sandbox-read-only', 'provider-plan', 'text-only', 'unrestricted-command']),
  exec: z.boolean(),
});
const targetSchema = z.object({ id: safeId, label: z.string(), provider: safeId, model: z.string().optional(), reasoningEffort: effortSchema.optional(), capabilities, configuration: customSchema.optional() });
const toolUseSchema = z.object({ name: z.string(), detail: z.string().optional() });
const resultSchema = z.object({
  runId: safeId, targetId: safeId, provider: safeId, model: z.string().optional(), reasoningEffort: effortSchema.optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  ok: z.boolean(), text: z.string(), reasoning: z.string(), error: z.string().optional(), durationMs: z.number().nonnegative(),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  tools: z.array(toolUseSchema).optional(),
  memoryReferences: z.array(z.object({ source: z.string(), content: z.string(), effect: z.string() })).optional(),
  observerErrors: z.array(z.string()).optional(),
}).refine((r) => r.ok === (r.status === 'succeeded'), 'ok 与 status 不一致');
const historySchema = z.array(z.object({ turnId: safeId, question: z.string(), answer: z.string() }));
const inputSchema = z.object({ prompt: z.string(), cwd: z.string(), history: historySchema });
const sourceSchema = z.object({
  turnId: safeId, runId: safeId, targetId: safeId, scope: z.enum(['answer', 'synthesis']),
  planText: z.string().optional(),
});
const recordSchema = z.object({
  schemaVersion: z.literal(2), kind: z.enum(['comparison', 'execution']), id: safeId, sessionId: safeId,
  parentTurnId: safeId.optional(), retryOf: safeId.optional(), createdAt: z.string(), updatedAt: z.string(),
  owner: z.object({ pid: z.number().int().positive(), hostname: z.string() }).optional(),
  question: z.string(), input: inputSchema, targets: z.array(targetSchema),
  status: z.enum(['created', 'deciding', 'answering', 'synthesizing', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']),
  error: z.string().optional(), results: z.array(resultSchema),
  calls: z.array(z.object({
    id: safeId, scope: z.enum(['decision', 'answer', 'synthesis', 'exec']), target: targetSchema,
    input: z.object({ prompt: z.string(), cwd: z.string(), mode: z.enum(['ask', 'exec']), timeoutMs: z.number().positive() }),
    result: resultSchema,
  })),
  decision: z.object({ providers: z.array(safeId), synthesize: z.boolean(), reason: z.string().optional() }).optional(),
  synthesis: z.object({
    provider: safeId, labels: z.record(z.string(), safeId), result: resultSchema,
    preferredProvider: safeId.optional(), fallback: z.boolean().optional(), alsoAnswered: z.boolean().optional(),
  }).optional(),
  planSource: sourceSchema.optional(),
  observerErrors: z.array(z.string()).optional(),
});
export type RunRecord = z.infer<typeof recordSchema>;
export type CallRecord = RunRecord['calls'][number];
export type HistoryEntry = z.infer<typeof historySchema>[number];
export type PlanSource = z.infer<typeof sourceSchema>;

const legacyResult = z.object({
  provider: safeId, ok: z.boolean(), text: z.string(), reasoning: z.string().default(''),
  error: z.string().optional(), durationMs: z.number().nonnegative(), usage: resultSchema.shape.usage,
});
const legacySchema = z.object({
  id: safeId, createdAt: z.string(), question: z.string(), results: z.array(legacyResult),
  synthesis: z.object({ provider: safeId, labels: z.record(z.string(), safeId), result: legacyResult }).optional(),
});

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID()}`;
}

const runsDir = (cwd: string) => join(cwd, '.unify', 'runs');

function runDir(cwd: string, id: string): string {
  return join(runsDir(cwd), safeId.parse(id));
}

/** Reserve an exclusive directory before starting model work. */
export function createRun(cwd: string, run: RunRecord): void {
  mkdirSync(runsDir(cwd), { recursive: true, mode: 0o700 });
  mkdirSync(runDir(cwd, run.id), { mode: 0o700 });
  saveRun(cwd, run);
}

/** run.json is authoritative; readable exports are atomically replaced individually. */
export function saveRun(cwd: string, run: RunRecord): string {
  const dir = runDir(cwd, run.id);
  run.updatedAt = new Date().toISOString();
  atomicWrite(join(dir, 'run.json'), JSON.stringify(recordSchema.parse(run), null, 2) + '\n');
  return dir;
}

export function exportRun(cwd: string, run: RunRecord): void {
  const dir = runDir(cwd, run.id);
  atomicWrite(join(dir, 'question.md'), run.question + '\n');
  for (const r of run.results) atomicWrite(join(dir, `answer-${safeId.parse(r.targetId)}.md`), `${r.ok ? '' : `**${r.status}**: ${r.error ?? ''}\n\n`}${r.text}${formatMemoryReferences(r.memoryReferences)}\n`);
  if (run.synthesis) atomicWrite(join(dir, 'synthesis.md'), synthesisFormatter(run)(run.synthesis.result.text) + formatMemoryReferences(run.synthesis.result.memoryReferences) + '\n');
}

export function listRunIds(cwd: string): string[] {
  try {
    return readdirSync(runsDir(cwd), { withFileTypes: true }).filter((e) => e.isDirectory() && safeId.safeParse(e.name).success).map((e) => e.name).sort();
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function ownerAlive(run: RunRecord): boolean {
  if (!run.owner || run.owner.hostname !== hostname()) return false;
  try { process.kill(run.owner.pid, 0); return true; }
  catch (err) { return err instanceof Error && 'code' in err && err.code === 'EPERM'; }
}

/** Legacy records are normalized in memory. Unfinished records without a live owner are interrupted. */
export function loadRun(cwd: string, id?: string): RunRecord {
  const target = id ?? listRunIds(cwd).at(-1);
  if (!target) throw new Error('当前目录下还没有记录');
  const raw = readJson(join(runDir(cwd, target), 'run.json'));
  if (!raw) throw new Error(`找不到记录 ${target}`);
  let run: RunRecord;
  if (typeof raw === 'object' && 'schemaVersion' in raw) run = recordSchema.parse(raw);
  else {
    const old = legacySchema.parse(raw);
    const convert = (r: z.infer<typeof legacyResult>, suffix: string): z.infer<typeof resultSchema> => ({
      ...r, targetId: r.provider, runId: `${old.id}-${suffix}`, status: r.ok ? 'succeeded' : 'failed',
    });
    run = {
      schemaVersion: 2, kind: 'comparison', id: old.id, sessionId: old.id,
      createdAt: old.createdAt, updatedAt: old.createdAt, question: old.question,
      input: { cwd, prompt: old.question, history: [] }, targets: [], calls: [],
      status: old.results.some((r) => r.ok) ? 'completed' : 'failed',
      results: old.results.map((r, i) => convert(r, String(i))),
      synthesis: old.synthesis ? { ...old.synthesis, result: convert(old.synthesis.result, 'synth') } : undefined,
    };
  }
  if (run.id !== target) throw new Error('记录 id 与目录不一致');
  if (['created', 'deciding', 'answering', 'synthesizing'].includes(run.status) && !ownerAlive(run)) {
    run.status = 'interrupted';
    for (const result of [...run.results, ...run.calls.map((c) => c.result), ...(run.synthesis ? [run.synthesis.result] : [])]) {
      if (result.status === 'running') { result.status = 'interrupted'; result.ok = false; result.error = '上次执行未保存终态'; }
    }
  }
  return run;
}

export function latestComparison(cwd: string): RunRecord {
  for (const id of listRunIds(cwd).reverse()) {
    const run = loadRun(cwd, id);
    if (run.kind === 'comparison') return run;
  }
  throw new Error('没有可继续的问答记录');
}

/** Find the latest non-cancelled execution that adopted a plan from this comparison turn. */
export function latestExecutionFor(cwd: string, comparison: RunRecord): RunRecord | undefined {
  if (comparison.kind !== 'comparison') return undefined;
  const ids = listRunIds(cwd);
  const idx = ids.indexOf(comparison.id);
  if (idx < 0) return undefined;
  let latest: RunRecord | undefined;
  for (let i = ids.length - 1; i > idx; i--) {
    let run: RunRecord;
    try { run = loadRun(cwd, ids[i]); } catch { continue; }
    if (run.kind !== 'execution' || run.sessionId !== comparison.sessionId || run.planSource?.turnId !== comparison.id) continue;
    if (run.status === 'cancelled' || run.results[0]?.status === 'cancelled') continue;
    if (run.results[0]?.ok) return run;
    latest ??= run;
  }
  return latest;
}

function sourceDisplayName(source: PlanSource, comparison?: RunRecord): string {
  const target = comparison?.targets.find((t) => t.id === source.targetId);
  const config = target?.configuration;
  const name = target?.model ?? (config?.type === 'openai' ? config.model : undefined) ?? target?.label ?? source.targetId;
  return source.scope === 'synthesis' ? `汇总（${name}）` : name;
}

function resolveChosenPlan(comparison: RunRecord, source: PlanSource): string | undefined {
  if (source.planText?.trim()) return source.planText.trim();
  if (source.scope === 'synthesis' && comparison.synthesis?.result.ok && comparison.synthesis.result.text.trim()) {
    return synthesisFormatter(comparison)(extractFinalPlan(comparison.synthesis.result.text));
  }
  const match = comparison.results.find((r) => (r.runId === source.runId || r.targetId === source.targetId) && r.ok && r.text.trim());
  return match?.text.trim();
}

function formatExecutedAnswer(planText: string | undefined, execution: RunRecord, comparison?: RunRecord): string | undefined {
  const execResult = execution.results[0];
  const execOk = !!execResult?.ok && !!execResult.text.trim();
  const srcLabel = execution.planSource ? sourceDisplayName(execution.planSource, comparison) : undefined;
  const execLabel = execution.targets[0]?.label ?? execResult?.targetId ?? '执行模型';
  if (planText) {
    const header = srcLabel ? `[已采纳方案：${srcLabel}]\n` : '';
    const outcome = execOk ? `\n\n[已由 ${execLabel} 实施]\n${execResult.text.trim()}` : '';
    return `${header}${planText}${outcome}`;
  }
  return execOk ? execResult.text.trim() : undefined;
}

export function historyAfter(run: RunRecord, followUpExecution?: RunRecord, fromTargetId?: string): HistoryEntry[] {
  if (run.kind === 'execution') {
    const answer = formatExecutedAnswer(run.planSource?.planText?.trim(), run);
    return [...run.input.history, ...(answer ? [{ turnId: run.planSource?.turnId ?? run.id, question: run.question, answer }] : [])];
  }
  if (fromTargetId) {
    if (fromTargetId === 'synthesis') {
      if (run.synthesis?.result.ok && run.synthesis.result.text.trim()) {
        return [...run.input.history, { turnId: run.id, question: run.question, answer: synthesisFormatter(run)(run.synthesis.result.text) }];
      }
    } else {
      const picked = run.results.find((r) => r.targetId === fromTargetId && r.ok && r.text.trim());
      if (picked) {
        const label = sourceDisplayName({ turnId: run.id, runId: picked.runId, targetId: picked.targetId, scope: 'answer' }, run);
        return [...run.input.history, { turnId: run.id, question: run.question, answer: `[已选定回答：${label}]\n${picked.text.trim()}` }];
      }
    }
  }
  if (followUpExecution?.kind === 'execution' && followUpExecution.planSource?.turnId === run.id) {
    const planText = resolveChosenPlan(run, followUpExecution.planSource);
    const answer = formatExecutedAnswer(planText, followUpExecution, run);
    if (answer) return [...run.input.history, { turnId: run.id, question: run.question, answer }];
  }
  if (run.synthesis?.result.ok && run.synthesis.result.text.trim()) {
    const answer = synthesisFormatter(run)(run.synthesis.result.text);
    return [...run.input.history, { turnId: run.id, question: run.question, answer }];
  }
  const best = run.results.find((r) => r.ok && r.text.trim());
  return [...run.input.history, ...(best ? [{ turnId: run.id, question: run.question, answer: best.text }] : [])];
}
