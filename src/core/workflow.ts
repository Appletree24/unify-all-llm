import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config.js';
import { timeoutMillis } from './config.js';
import { resolveSharedFileContext } from './context.js';
import { buildDecisionPrompt, parseDecision } from './decider.js';
import { fanOut, runOne } from './orchestrator.js';
import { createRun, exportRun, historyAfter, latestExecutionFor, newRunId, saveRun, type CallRecord, type PlanSource, type RunRecord } from './store.js';
import { anonymize, buildApiMessages, buildConversationPrompt, buildExecPrompt, buildSynthesisInput, buildSynthesisInstructions, buildSynthesisPrompt, buildTurnUserContent, extractFinalPlan, synthesisFormatter } from './synth.js';
import { appendToolUse, snapshotTarget, type ChatMessage, type ModelTarget, type ProviderEvent, type RunResult, type TargetSnapshot } from './types.js';
import { defaultTargetIds, detectTargets } from './targets.js';
import { memoryReportMarker, requestMemoryReport } from '../memory/report.js';
import { canReceiveUserMemory, formatMemoryUpdateDelta, formatSharedMemoryPrompt, resolveSharedMemory, saveMemorySnapshots, type MemorySnapshot, type ResolvedSharedMemory } from '../memory/shared.js';

type Scope = CallRecord['scope'];
export type WorkflowEvent =
  | { type: 'stage'; turnId: string; stage: RunRecord['status']; targets: TargetSnapshot[] }
  | { type: 'call'; turnId: string; callId: string; scope: Scope; target: TargetSnapshot }
  | { type: 'provider'; turnId: string; callId: string; scope: Scope; targetId: string; event: ProviderEvent }
  | { type: 'notice'; turnId: string; message: string }
  | { type: 'end'; turnId: string; status: RunRecord['status'] };

interface CommonOptions {
  cwd: string;
  home?: string;
  config: Config;
  targets: ModelTarget[];
  signal?: AbortSignal;
  onEvent?: (event: WorkflowEvent, record: RunRecord) => void;
}
export interface ComparisonOptions extends CommonOptions {
  question: string;
  selected?: string[];
  manualSelection?: boolean;
  synthesize?: boolean;
  previous?: RunRecord;
  continueFrom?: string;
  /** Optional append-only memory deltas saved mid-session, injected at the tail of the next API user turn. */
  memoryUpdates?: string[];
  retry?: { record: RunRecord; targetIds: string[] };
}
export interface WorkflowHandle {
  record: RunRecord;
  done: Promise<RunRecord>;
  cancel(): void;
  cancelTarget(id: string): boolean;
}

const REDACTED_USER_MEMORY_SYSTEM = '[user-memory-snapshot-redacted]';

interface PreparedInput {
  prompt: string;
  messages?: ChatMessage[];
  memoryReportMarker?: string;
  memorySnapshot?: MemorySnapshot;
  includesUserMemory?: boolean;
  /** When true, requestMemoryReport is already applied or should not be appended again. */
  skipReportWrap?: boolean;
}

/**
 * Strip personal user-memory text before writing to project `.unify/runs/<id>/run.json`.
 * Exact replay reconstructs the system message byte-for-byte from `<home>/.unify/memory-snapshots/`.
 */
function sanitizeMessagesForRun(messages: ChatMessage[] | undefined, includesUserMemory?: boolean): ChatMessage[] | undefined {
  if (!messages) return undefined;
  if (!includesUserMemory) return messages;
  return messages.map((m, i) => (i === 0 && m.role === 'system' ? { role: 'system', content: REDACTED_USER_MEMORY_SYSTEM } : m));
}

function restoreMessagesForReplay(
  cwd: string,
  home: string | undefined,
  call: CallRecord,
  target: ModelTarget,
  blobs?: ResolvedSharedMemory['blobs'],
): ChatMessage[] | undefined {
  const saved = call.input.messages;
  if (!saved?.length) return undefined;
  if (!call.input.includesUserMemory) return structuredClone(saved);
  const baseSystem = target.adapter.configuration?.type === 'openai' ? target.adapter.configuration.system : undefined;
  const { text: memText } = formatSharedMemoryPrompt(cwd, call.input.memorySnapshot, { includeUser: true, home, blobs });
  const systemParts = [
    baseSystem?.trim(),
    memText.trim(),
    call.scope === 'synthesis' ? buildSynthesisInstructions(false) : undefined,
  ].filter((s): s is string => !!s);
  return saved.map((m, i) => (i === 0 && m.role === 'system' ? { role: 'system', content: systemParts.join('\n\n') } : { ...m }));
}
/** Checkpoints own I/O failure handling so a broken display cannot stop model work. */
class Journal {
  readonly ctl = new AbortController();
  private writeError?: Error;
  private lastWrite = 0;
  private readonly liveMessages = new Map<string, ChatMessage[]>();
  private readonly abort = () => this.ctl.abort();
  constructor(readonly record: RunRecord, private opts: CommonOptions) {
    createRun(opts.cwd, record);
    opts.signal?.addEventListener('abort', this.abort, { once: true });
    if (opts.signal?.aborted) this.abort();
  }
  emit(event: WorkflowEvent): void {
    try { this.opts.onEvent?.(event, this.record); }
    catch (err) {
      if ((this.record.observerErrors?.length ?? 0) < 20) (this.record.observerErrors ??= []).push(String(err));
    }
  }
  checkpoint(force = true): void {
    if (this.writeError || (!force && Date.now() - this.lastWrite < 250)) return;
    try { saveRun(this.opts.cwd, this.record); this.lastWrite = Date.now(); }
    catch (err) { this.writeError = err instanceof Error ? err : new Error(String(err)); this.ctl.abort(); }
  }
  assertWritable(): void { if (this.writeError) throw this.writeError; }
  stage(status: RunRecord['status'], targets: ModelTarget[] = []): void {
    this.record.status = status;
    this.checkpoint();
    this.assertWritable();
    this.emit({ type: 'stage', turnId: this.record.id, stage: status, targets: targets.map(snapshotTarget) });
  }
  prepare(target: ModelTarget, scope: Scope, input: string | PreparedInput, timeoutMs: number): CallRecord {
    const id = randomUUID();
    const spec: PreparedInput = typeof input === 'string' ? { prompt: input } : { ...input };
    let prompt = spec.prompt;
    let messages = spec.messages ? spec.messages.map((m) => ({ ...m })) : undefined;
    let reportMarker = spec.memoryReportMarker;

    const shouldReport = !spec.skipReportWrap && scope !== 'decision' && (
      target.adapter.capabilities.askPolicy !== 'text-only'
      || !!spec.memorySnapshot?.items.length
    );
    if (shouldReport) {
      reportMarker ??= memoryReportMarker(id);
      if (messages?.length && messages[messages.length - 1].role === 'user') {
        const last = messages[messages.length - 1];
        messages[messages.length - 1] = { role: 'user', content: requestMemoryReport(last.content, id, reportMarker) };
      }
      prompt = requestMemoryReport(prompt, id, reportMarker);
    }

    if (messages) this.liveMessages.set(id, messages);
    const call: CallRecord = {
      id, scope, target: snapshotTarget(target),
      input: {
        prompt,
        ...(messages ? { messages: sanitizeMessagesForRun(messages, spec.includesUserMemory) } : {}),
        ...(reportMarker ? { memoryReportMarker: reportMarker } : {}),
        ...(spec.memorySnapshot?.items.length ? { memorySnapshot: spec.memorySnapshot } : {}),
        ...(spec.includesUserMemory ? { includesUserMemory: true } : {}),
        cwd: this.opts.cwd, mode: scope === 'exec' ? 'exec' : 'ask', timeoutMs,
      },
      result: { runId: id, targetId: target.id, provider: target.adapter.id, model: target.model, reasoningEffort: target.reasoningEffort, status: 'running', ok: false, text: '', reasoning: '', durationMs: 0 },
    };
    this.record.calls.push(call);
    return call;
  }
  messagesFor(callId: string): ChatMessage[] | undefined {
    return this.liveMessages.get(callId);
  }
  begin(call: CallRecord): void {
    this.emit({ type: 'call', turnId: this.record.id, callId: call.id, scope: call.scope, target: call.target });
  }
  event(call: CallRecord, event: ProviderEvent): void {
    if (event.type === 'delta') call.result.text += event.text;
    else if (event.type === 'reasoning') call.result.reasoning += event.text;
    else if (event.type === 'tool') appendToolUse(call.result, event);
    else if (event.type === 'done') Object.assign(call.result, { text: event.text, status: 'succeeded', ok: true, usage: event.usage, memoryReferences: event.memoryReferences });
    else if (event.type === 'error') Object.assign(call.result, { error: event.message, status: event.status ?? 'failed', ok: false });
    this.checkpoint(event.type === 'done' || event.type === 'error');
    this.emit({ type: 'provider', turnId: this.record.id, callId: call.id, targetId: call.target.id, scope: call.scope, event });
  }
  async one(
    target: ModelTarget,
    scope: Scope,
    input: string | PreparedInput,
    timeoutMs: number,
    synthesisMeta?: { labels: Record<string, string>; preferredProvider?: string; fallback?: boolean; alsoAnswered?: boolean },
  ): Promise<CallRecord> {
    const call = this.prepare(target, scope, input, timeoutMs);
    if (scope === 'exec') this.record.results.push(call.result);
    if (scope === 'synthesis') {
      this.record.synthesis = {
        provider: target.id,
        labels: synthesisMeta?.labels ?? {},
        result: call.result,
        ...(synthesisMeta?.preferredProvider ? { preferredProvider: synthesisMeta.preferredProvider } : {}),
        ...(synthesisMeta?.fallback !== undefined ? { fallback: synthesisMeta.fallback } : {}),
        ...(synthesisMeta?.alsoAnswered !== undefined ? { alsoAnswered: synthesisMeta.alsoAnswered } : {}),
      };
    }
    this.checkpoint();
    this.assertWritable();
    this.begin(call);
    Object.assign(call.result, await runOne(target, {
      ...call.input,
      messages: this.messagesFor(call.id),
      memoryReportMarker: call.input.memoryReportMarker,
      runId: call.id, signal: this.ctl.signal, onEvent: (_id, event) => this.event(call, event),
    }));
    this.checkpoint();
    this.assertWritable();
    return call;
  }
  async finish(work: () => Promise<void>): Promise<RunRecord> {
    try {
      await work();
      this.assertWritable();
      const results = [...this.record.results, ...(this.record.synthesis ? [this.record.synthesis.result] : [])];
      this.record.status = this.ctl.signal.aborted ? 'cancelled'
        : results.length && results.every((r) => r.ok) ? 'completed'
        : results.some((r) => r.ok) ? 'partial' : 'failed';
    } catch (err) {
      this.record.status = 'failed';
      this.record.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.opts.signal?.removeEventListener('abort', this.abort);
      this.checkpoint();
      this.assertWritable();
      exportRun(this.opts.cwd, this.record);
      this.emit({ type: 'end', turnId: this.record.id, status: this.record.status });
    }
    return this.record;
  }
}

function initialRecord(opts: CommonOptions, question: string, previous?: RunRecord, continueFrom?: string): RunRecord {
  const id = newRunId();
  if (continueFrom && previous?.kind === 'comparison') {
    const ok = continueFrom === 'synthesis'
      ? !!(previous.synthesis?.result.ok && previous.synthesis.result.text.trim())
      : previous.results.some((r) => r.targetId === continueFrom && r.ok && r.text.trim());
    if (!ok) throw new Error(`上一轮中没有来自「${continueFrom}」的可用回答`);
  }
  const followUp = !continueFrom && previous?.kind === 'comparison' ? latestExecutionFor(opts.cwd, previous) : undefined;
  const history = previous ? historyAfter(previous, followUp, continueFrom) : [];
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, kind: 'comparison', id, sessionId: previous?.sessionId ?? id, parentTurnId: followUp?.id ?? previous?.id,
    createdAt: now, updatedAt: now, question, input: { cwd: opts.cwd, prompt: buildConversationPrompt(history, question), history },
    owner: { pid: process.pid, hostname: hostname() },
    targets: [], status: 'created', results: [], calls: [],
  };
}

/** CLI and TUI share routing, fallbacks, context, cancellation, and persistence. */
export function startComparison(opts: ComparisonOptions): WorkflowHandle {
  const question = opts.retry?.record.question ?? opts.question.trim();
  if (!question) throw new Error('问题不能为空');
  const record = initialRecord(opts, question, opts.retry ? undefined : opts.previous, opts.retry ? undefined : opts.continueFrom);
  if (opts.retry) {
    if (opts.retry.record.kind !== 'comparison') throw new Error('实施记录不能自动重试');
    record.input = structuredClone(opts.retry.record.input);
    record.input.cwd = opts.cwd;
    record.sessionId = opts.retry.record.sessionId;
    record.parentTurnId = opts.retry.record.parentTurnId;
    record.retryOf = opts.retry.record.id;
  }
  const selected = opts.retry?.targetIds ?? opts.selected ?? defaultTargetIds(opts.config, opts.targets);
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择不重复的目标');
  let targets = selected.map((id) => {
    const t = opts.targets.find((t) => t.id === id);
    if (!t) throw new Error(`未知目标 ${id}`);
    if (!opts.retry) return t;
    const saved = opts.retry.record.targets.find((s) => s.id === id);
    if (!saved) throw new Error(`记录不包含目标 ${id}`);
    if (t.adapter.id !== saved.provider) throw new Error(`目标 ${id} 的 provider 已改变`);
    if (!isDeepStrictEqual(t.adapter.configuration, saved.configuration)) throw new Error(`目标 ${id} 的传输配置已改变，请重新提问`);
    return { ...t, model: saved.model, reasoningEffort: saved.reasoningEffort };
  });
  record.targets = targets.map(snapshotTarget);
  const journal = new Journal(record, opts);
  const controls = new Map(targets.map((t) => [t.id, new AbortController()]));
  const done = Promise.resolve().then(() => journal.finish(async () => {
    const available = await detectTargets(opts.targets, journal.ctl.signal);
    if (journal.ctl.signal.aborted) return;
    const unavailable = targets.filter((t) => !available.get(t.id));
    if (unavailable.length) {
      journal.emit({ type: 'notice', turnId: record.id, message: `不可用: ${unavailable.map((t) => t.label).join('、')}` });
      // Explicit choices fail visibly instead of silently changing the requested comparison.
      if (opts.selected || opts.retry || opts.config.providers) throw new Error('选择的目标不可用，请运行 unify doctor');
      targets = targets.filter((t) => available.get(t.id));
    }
    if (!targets.length) throw new Error('没有可用的模型，请运行 unify doctor');
    let synthesize = opts.synthesize !== false;
    const decider = opts.targets.find((t) => t.id === opts.config.decider);
    if (decider && !opts.manualSelection && !opts.retry && targets.length > 1 && available.get(decider.id)) {
      journal.stage('deciding', targets);
      const call = await journal.one(decider, 'decision', buildDecisionPrompt({ question: record.input.prompt, available: targets }), timeoutMillis(opts.config.decisionTimeoutSec ?? 60));
      if (journal.ctl.signal.aborted) return;
      const decision = call.result.ok ? parseDecision(call.result.text, targets.map((t) => t.id)) : undefined;
      if (decision) {
        record.decision = decision;
        targets = targets.filter((t) => decision.providers.includes(t.id));
        synthesize &&= decision.synthesize;
      }
      journal.emit({ type: 'notice', turnId: record.id, message: decision ? `决策 · ${decider.label}: ${decision.reason ?? decision.providers.join('、')}` : '决策无可用结果，已发给全部选中模型' });
    }
    if (journal.ctl.signal.aborted) return;
    record.targets = targets.map(snapshotTarget);
    const hasTextOnly = targets.some((t) => t.adapter.capabilities.askPolicy === 'text-only')
      || (synthesize && opts.targets.some((t) => t.id === (opts.config.synthesizer ?? 'claude') && t.adapter.capabilities.askPolicy === 'text-only'));

    // Resolve shared @file attachments and shared memory snapshot once per new turn;
    // retries strictly replay the saved call snapshot without re-reading disk.
    let shared = { text: '', files: [] as string[], skipped: [] as { path: string; reason: string }[] };
    let memorySnapshot: MemorySnapshot | undefined = record.input.memorySnapshot;
    let memoryBlobs: ResolvedSharedMemory['blobs'] | undefined;

    if (!opts.retry) {
      if (hasTextOnly) {
        shared = resolveSharedFileContext(opts.cwd, record.question);
        if (shared.files.length) {
          record.input.sharedFiles = shared.files;
          const skipNote = shared.skipped.length ? `（跳过 ${shared.skipped.length} 个）` : '';
          journal.emit({ type: 'notice', turnId: record.id, message: `已为纯文本模型附带引用文件: ${shared.files.join('、')}${skipNote}` });
        }
        // Inherit frozen SessionStart memory snapshot on follow-up; resolve fresh only if absent.
        if (opts.previous?.input.memorySnapshot) {
          memorySnapshot = structuredClone(opts.previous.input.memorySnapshot);
          record.input.memorySnapshot = memorySnapshot;
        } else {
          const resolved = resolveSharedMemory({ cwd: opts.cwd, home: opts.home }, opts.config);
          if (resolved.snapshot.items.length || resolved.snapshot.notices?.length) {
            saveMemorySnapshots(opts.cwd, resolved, opts.home);
            memorySnapshot = resolved.snapshot;
            memoryBlobs = resolved.blobs;
            record.input.memorySnapshot = memorySnapshot;
          }
          if (resolved.snapshot.items.length) {
            journal.emit({
              type: 'notice', turnId: record.id,
              message: `已为纯文本模型载入共享记忆: ${resolved.snapshot.items.map((i) => i.logicalPath).join('、')}`,
            });
          }
          for (const note of resolved.snapshot.notices ?? []) {
            journal.emit({ type: 'notice', turnId: record.id, message: note });
          }
        }
      }
      if (opts.memoryUpdates?.length) {
        record.input.memoryUpdates = [...opts.memoryUpdates];
      }
      const memoryUpdate = formatMemoryUpdateDelta(record.input.memoryUpdates);
      const userContent = buildTurnUserContent(record.question, { sharedContext: shared.text, memoryUpdate });
      if (userContent !== record.question) record.input.userContent = userContent;
    } else {
      shared = { text: '', files: record.input.sharedFiles ?? [], skipped: [] };
    }

    const prepareApiAnswer = (t: ModelTarget, timeoutMs: number): CallRecord => {
      if (opts.retry) {
        const prevCall = opts.retry.record.calls.find((c) => c.scope === 'answer' && c.target.id === t.id);
        if (prevCall) {
          const replayedMessages = restoreMessagesForReplay(opts.cwd, opts.home, prevCall, t, memoryBlobs);
          return journal.prepare(t, 'answer', {
            prompt: prevCall.input.prompt,
            messages: replayedMessages,
            memoryReportMarker: prevCall.input.memoryReportMarker,
            memorySnapshot: prevCall.input.memorySnapshot,
            includesUserMemory: prevCall.input.includesUserMemory,
            skipReportWrap: true,
          }, timeoutMs);
        }
      }
      const allowUser = canReceiveUserMemory(t, opts.config);
      const mem = formatSharedMemoryPrompt(opts.cwd, memorySnapshot, { includeUser: allowUser, home: opts.home, blobs: memoryBlobs });
      const baseSystem = t.adapter.configuration?.type === 'openai' ? t.adapter.configuration.system : undefined;
      const currentUserContent = record.input.userContent ?? record.question;
      const messages = buildApiMessages({
        baseSystem,
        sharedMemory: mem.text || undefined,
        history: record.input.history,
        currentUserContent,
      });
      const prompt = shared.text || record.input.memoryUpdates?.length
        ? buildConversationPrompt(record.input.history, record.question, [formatMemoryUpdateDelta(record.input.memoryUpdates), shared.text].filter(Boolean).join('\n\n'))
        : record.input.prompt;
      const targetSnapshot = mem.items.length ? { version: memorySnapshot!.version, items: mem.items } : undefined;
      return journal.prepare(t, 'answer', {
        prompt,
        messages,
        memorySnapshot: targetSnapshot,
        includesUserMemory: mem.items.some((i) => i.scope === 'user'),
      }, timeoutMs);
    };

    const prepareCliAnswer = (t: ModelTarget, timeoutMs: number): CallRecord => {
      if (opts.retry) {
        const prevCall = opts.retry.record.calls.find((c) => c.scope === 'answer' && c.target.id === t.id);
        if (prevCall) {
          return journal.prepare(t, 'answer', {
            prompt: prevCall.input.prompt,
            memoryReportMarker: prevCall.input.memoryReportMarker,
            skipReportWrap: true,
          }, timeoutMs);
        }
      }
      return journal.prepare(t, 'answer', record.input.prompt, timeoutMs);
    };

    journal.stage('answering', targets);
    const timeoutMs = timeoutMillis(opts.config.timeoutSec ?? 600);
    const calls = new Map(targets.map((t) => [
      t.id,
      t.adapter.capabilities.askPolicy === 'text-only' ? prepareApiAnswer(t, timeoutMs) : prepareCliAnswer(t, timeoutMs),
    ]));
    const prompts = new Map([...calls].map(([id, call]) => [id, call.input.prompt]));
    const messagesByTarget = new Map<string, ChatMessage[]>();
    const reportMarkers = new Map<string, string>();
    for (const [id, call] of calls) {
      const m = journal.messagesFor(call.id);
      if (m) messagesByTarget.set(id, m);
      if (call.input.memoryReportMarker) reportMarkers.set(id, call.input.memoryReportMarker);
    }
    record.results = targets.map((t) => calls.get(t.id)!.result);
    journal.checkpoint();
    journal.assertWritable();
    for (const call of calls.values()) journal.begin(call);
    await fanOut(targets, {
      prompt: record.input.prompt, prompts, messagesByTarget, reportMarkers, cwd: opts.cwd, mode: 'ask', timeoutMs, concurrency: opts.config.concurrency ?? 3,
      signal: journal.ctl.signal, targetSignals: new Map([...controls].map(([id, c]) => [id, c.signal])),
      runIds: new Map([...calls].map(([id, c]) => [id, c.id])),
      onEvent: (id, event) => journal.event(calls.get(id)!, event),
      onResult: (result) => { Object.assign(calls.get(result.targetId)!.result, result); journal.checkpoint(); },
    });
    journal.assertWritable();
    if (journal.ctl.signal.aborted) return;
    const memoryTargets = new Set([...calls.entries()].filter(([, c]) => !!c.input.memorySnapshot?.items.length).map(([id]) => id));
    const answers = anonymize(record.results, record.targets, shared.files, memoryTargets);
    if (!synthesize || answers.length < 2) return;
    const preferredId = opts.config.synthesizer ?? 'claude';
    const preferred = opts.targets.find((t) => t.id === preferredId);
    const answeringIds = new Set(record.results.filter((r) => r.ok).map((r) => r.targetId));
    const okTargets = targets.filter((t) => answeringIds.has(t.id));
    const fallbackTarget = okTargets.find((t) => t.adapter.capabilities.askPolicy !== 'text-only') ?? okTargets[0]!;
    const fallback = !(preferred && available.get(preferred.id));
    const synth = fallback ? fallbackTarget : preferred!;
    const alsoAnswered = answeringIds.has(synth.id);
    if (fallback) {
      journal.emit({
        type: 'notice', turnId: record.id,
        message: `汇总使用 ${synth.label}（${preferred?.label ?? preferredId} 不可用，已回退${alsoAnswered ? '；同时参与了答题' : ''}）`,
      });
    }
    journal.stage('synthesizing', [synth]);
    const labels = Object.fromEntries(answers.map((a) => [a.label, a.provider]));
    const synthCanInspect = synth.adapter.capabilities.askPolicy !== 'text-only';

    // Ensure fallback or separately-configured text-only synthesizer also receives frozen shared memory + shared files.
    if (!synthCanInspect && !memorySnapshot && !opts.retry) {
      if (opts.previous?.input.memorySnapshot) {
        memorySnapshot = structuredClone(opts.previous.input.memorySnapshot);
        record.input.memorySnapshot = memorySnapshot;
      } else {
        const resolved = resolveSharedMemory({ cwd: opts.cwd, home: opts.home }, opts.config);
        if (resolved.snapshot.items.length) {
          saveMemorySnapshots(opts.cwd, resolved, opts.home);
          memorySnapshot = resolved.snapshot;
          memoryBlobs = resolved.blobs;
          record.input.memorySnapshot = memorySnapshot;
        }
      }
    }
    if (!synthCanInspect && !shared.text && !opts.retry && !shared.files.length) {
      shared = resolveSharedFileContext(opts.cwd, record.question);
    }

    const synthPrompt = buildSynthesisPrompt(record.input.prompt, answers, {
      canInspectWorkspace: synthCanInspect,
      sharedContext: !synthCanInspect ? shared.text : undefined,
    });
    let synthInput: string | PreparedInput = synthPrompt;
    if (!synthCanInspect) {
      const allowUser = canReceiveUserMemory(synth, opts.config);
      const mem = formatSharedMemoryPrompt(opts.cwd, memorySnapshot, { includeUser: allowUser, home: opts.home, blobs: memoryBlobs });
      const baseSystem = synth.adapter.configuration?.type === 'openai' ? synth.adapter.configuration.system : undefined;
      const systemParts = [baseSystem?.trim(), mem.text || undefined, buildSynthesisInstructions(false)].filter((s): s is string => !!s);
      const userBody = [
        formatMemoryUpdateDelta(record.input.memoryUpdates),
        buildSynthesisInput(record.input.prompt, answers, { canInspectWorkspace: false, sharedContext: shared.text }),
      ].filter(Boolean).join('\n\n');
      const synthSnapshot = mem.items.length ? { version: memorySnapshot!.version, items: mem.items } : undefined;
      synthInput = {
        prompt: synthPrompt,
        messages: [
          { role: 'system', content: systemParts.join('\n\n') },
          { role: 'user', content: userBody },
        ],
        memorySnapshot: synthSnapshot,
        includesUserMemory: mem.items.some((i) => i.scope === 'user'),
      };
    }

    await journal.one(
      synth,
      'synthesis',
      synthInput,
      timeoutMs,
      {
        labels,
        ...(fallback ? { preferredProvider: preferredId, fallback: true } : {}),
        alsoAnswered,
      },
    );
  }));
  return {
    record, done, cancel: () => journal.ctl.abort(),
    cancelTarget(id) {
      if (record.status !== 'answering') return false;
      const c = controls.get(id);
      const result = record.results.find((r) => r.targetId === id);
      if (!c || result?.status !== 'running') return false;
      c.abort();
      return true;
    },
  };
}

/** A plan is selected from persisted results, never from a UI text buffer. */
export function selectPlan(record: RunRecord, targetId?: string): { source: PlanSource; question: string; text: string } {
  if (record.kind !== 'comparison') throw new Error('请选择问答记录中的方案');
  if (['created', 'deciding', 'answering', 'synthesizing'].includes(record.status)) throw new Error('当前轮次尚未结束');
  const result = targetId ? record.results.find((r) => r.targetId === targetId && r.ok) :
    record.synthesis?.result.ok ? record.synthesis.result : record.results.filter((r) => r.ok).length === 1 ? record.results.find((r) => r.ok) : undefined;
  if (!result?.text.trim()) throw new Error('没有可用方案，请用 --from 或聚焦面板明确选择一个成功回答');
  const isSynthesis = result === record.synthesis?.result;
  const text = isSynthesis ? synthesisFormatter(record)(extractFinalPlan(result.text)) : result.text;
  return {
    source: {
      turnId: record.id, runId: result.runId, targetId: result.targetId,
      scope: isSynthesis ? 'synthesis' : 'answer',
      planText: text,
    },
    question: record.question, text,
  };
}

export function chooseExecutor(targets: ModelTarget[], requested: string | undefined, available: ReadonlyMap<string, boolean>): ModelTarget {
  const candidates = targets.filter((t) => available.get(t.id) && t.adapter.capabilities.exec);
  const target = requested ? candidates.find((t) => t.id === requested) : candidates.find((t) => t.id === 'claude') ?? candidates[0];
  if (!target) throw new Error(requested ? `执行目标 ${requested} 不可用或不支持实施` : '没有可用的执行模型');
  return target;
}

/** Execution is a separate durable record referencing the exact source turn and call. */
export function startExecution(opts: CommonOptions & { source: RunRecord; from?: string; executor: ModelTarget }): WorkflowHandle {
  const plan = selectPlan(opts.source, opts.from);
  if (!opts.executor.adapter.capabilities.exec) throw new Error(`${opts.executor.label} 不支持实施`);
  const record = initialRecord(opts, plan.question);
  record.sessionId = opts.source.sessionId;
  record.parentTurnId = opts.source.id;
  record.input.history = structuredClone(opts.source.input.history);
  record.kind = 'execution';
  record.planSource = plan.source;
  record.targets = [snapshotTarget(opts.executor)];
  record.input.prompt = buildExecPrompt(opts.source.input.prompt, plan.text);
  const journal = new Journal(record, opts);
  const done = Promise.resolve().then(() => journal.finish(async () => {
    journal.stage('answering', [opts.executor]);
    await journal.one(opts.executor, 'exec', record.input.prompt, timeoutMillis(opts.config.execTimeoutSec ?? 3600));
  }));
  return { record, done, cancel: () => journal.ctl.abort(), cancelTarget: () => false };
}
