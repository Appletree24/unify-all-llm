import type { HarnessPool } from './harness-pool.js';
import { randomUUID } from 'node:crypto';
import { collectMemoryReport } from '../memory/report.js';
import type { NativeConversation } from './native-conversation.js';
import { monitorCache, type CacheContext } from './cache-monitor.js';
import { appendToolUse, type ChatMessage, type InteractionHandler, type InteractionRequest, type InteractionResponse, type ModelTarget, type ProviderEvent, type RunMode, type RunResult } from './types.js';

export interface RunOptions {
  harnesses?: HarnessPool;
  sessionId?: string;
  prompt: string;
  messages?: ChatMessage[];
  memoryReportMarker?: string;
  conversation?: NativeConversation;
  cache?: CacheContext;
  cwd: string;
  mode: RunMode;
  timeoutMs: number;
  cleanupMs?: number;
  runId?: string;
  signal?: AbortSignal;
  interact?: InteractionHandler;
  onEvent?: (targetId: string, ev: ProviderEvent) => void;
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err);

/** One authoritative terminal event, after protocol completion and transport cleanup. */
export async function runOne(target: ModelTarget, opts: RunOptions): Promise<RunResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 2_147_483_647) throw new Error('timeoutMs 超出有效范围');
  const started = Date.now();
  const ctl = new AbortController();
  const res: RunResult = {
    runId: opts.runId ?? randomUUID(), targetId: target.id, provider: target.adapter.id, model: target.model, reasoningEffort: target.reasoningEffort,
    status: 'running', ok: false, text: '', reasoning: '', durationMs: 0,
  };
  let stopped = false;
  let monitor: ReturnType<typeof monitorCache> | undefined;
  let terminal: Extract<ProviderEvent, { type: 'done' | 'error' }> | undefined;
  let notifyAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { notifyAbort = resolve; });
  const cancel = (status: 'cancelled' | 'timed_out') => {
    if (ctl.signal.aborted) return;
    res.status = status;
    res.error = status === 'cancelled' ? '已取消' : '请求超时';
    ctl.abort();
    notifyAbort();
  };
  const onAbort = () => cancel('cancelled');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  let remainingMs = opts.timeoutMs;
  let timerStarted = Date.now();
  let timer: NodeJS.Timeout | undefined = setTimeout(() => cancel('timed_out'), remainingMs);
  let waitingUsers = 0;
  const pauseTimer = () => {
    if (waitingUsers++ === 0 && timer) {
      clearTimeout(timer);
      timer = undefined;
      remainingMs = Math.max(1000, remainingMs - (Date.now() - timerStarted));
    }
  };
  const resumeTimer = () => {
    if (waitingUsers > 0 && --waitingUsers === 0 && !stopped && !ctl.signal.aborted) {
      timerStarted = Date.now();
      timer = setTimeout(() => cancel('timed_out'), remainingMs);
    }
  };
  const interact: InteractionHandler | undefined = opts.interact
    ? async (request: InteractionRequest): Promise<InteractionResponse> => {
      if (ctl.signal.aborted) return { cancelled: true };
      pauseTimer();
      try {
        return await opts.interact!(request);
      } finally {
        resumeTimer();
      }
    }
    : undefined;
  const emit = (ev: ProviderEvent) => {
    try { opts.onEvent?.(target.id, ev); }
    catch (err) { (res.observerErrors ??= []).push(message(err)); }
  };
  const task = (async () => {
    try {
      if (ctl.signal.aborted) return;
      if (opts.mode === 'exec' && !target.adapter.capabilities.exec) throw new Error(`${target.label} 不支持实施`);
      const request = {
        prompt: opts.prompt, harnesses: opts.harnesses, sessionId: opts.sessionId,
        conversation: opts.conversation?.request,
        ...(opts.messages ? { messages: opts.messages } : {}),
        cwd: opts.cwd, mode: opts.mode, model: target.model, reasoningEffort: target.reasoningEffort, signal: ctl.signal,
        ...(interact ? { interact } : {}),
      };
      monitor = monitorCache(target, request, res, opts.cache);
      const events = target.adapter.run({ ...request, onPublicReplay: monitor.publicReplay });
      for await (const ev of collectMemoryReport(events, res.runId, opts.prompt, opts.memoryReportMarker)) {
        if (stopped || ctl.signal.aborted) break;
        if (terminal) throw new Error('模型在终态后继续发送事件');
        if (ev.type === 'done' || ev.type === 'error') {
          terminal = ev;
          if (ev.type === 'done') {
            res.text = ev.text || res.text;
            res.usage = ev.usage;
            if (ev.memoryReferences?.length) res.memoryReferences = ev.memoryReferences;
          }
        } else {
          if (ev.type === 'delta') res.text += ev.text;
          if (ev.type === 'reasoning') res.reasoning += ev.text;
          if (ev.type === 'tool') appendToolUse(res, ev);
          emit(ev);
        }
      }
      if (stopped || ctl.signal.aborted) return;
      if (!terminal) throw new Error('模型输出被截断：缺少协议终态');
      if (terminal.type === 'error') throw new Error(terminal.message);
      if (opts.mode === 'ask' && !res.text.trim()) throw new Error('模型已结束，但没有返回回答正文');
      res.status = 'succeeded';
      res.ok = true;
      if (opts.mode === 'ask' && terminal.nativeSession) opts.conversation?.save(terminal.nativeSession);
    } catch (err) {
      if (stopped || ctl.signal.aborted) return;
      res.status = 'failed';
      res.error = message(err);
    }
  })();
  try {
    await Promise.race([task, aborted]);
    if (ctl.signal.aborted) {
      let cleanupTimer: NodeJS.Timeout | undefined;
      await Promise.race([task, new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, opts.cleanupMs ?? 2500); })]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  res.durationMs = Date.now() - started;
  monitor?.finish();
  emit(res.ok ? { type: 'done', text: res.text, usage: res.usage, ...(res.memoryReferences && { memoryReferences: res.memoryReferences }) } : {
    type: 'error', message: res.error ?? '模型执行失败',
    status: res.status === 'cancelled' || res.status === 'timed_out' ? res.status : 'failed',
  });
  return res;
}

/** Bounded workers retain selection order and do not start cancelled queued targets. */
export async function fanOut(
  targets: ModelTarget[],
  opts: RunOptions & {
    concurrency: number;
    prompts?: ReadonlyMap<string, string>;
    messagesByTarget?: ReadonlyMap<string, ChatMessage[]>;
    reportMarkers?: ReadonlyMap<string, string>;
    interactionsByTarget?: ReadonlyMap<string, InteractionHandler>;
    conversations?: ReadonlyMap<string, NativeConversation>;
    cacheByTarget?: ReadonlyMap<string, CacheContext>;
    targetSignals?: ReadonlyMap<string, AbortSignal>;
    runIds?: ReadonlyMap<string, string>;
    onResult?: (result: RunResult) => void;
  },
): Promise<RunResult[]> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('concurrency 必须是正整数');
  if (new Set(targets.map((t) => t.id)).size !== targets.length) throw new Error('不能重复选择同一目标');
  const results: RunResult[] = new Array(targets.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const i = cursor++;
      const target = targets[i];
      const ctl = new AbortController();
      const signals = [opts.signal, opts.targetSignals?.get(target.id)].filter((s): s is AbortSignal => !!s);
      const abort = () => ctl.abort();
      for (const s of signals) {
        s.addEventListener('abort', abort, { once: true });
        if (s.aborted) abort();
      }
      try {
        results[i] = await runOne(target, {
          ...opts,
          prompt: opts.prompts?.get(target.id) ?? opts.prompt,
          conversation: opts.conversations?.get(target.id),
          cache: opts.cacheByTarget?.get(target.id) ?? opts.cache,
          messages: opts.messagesByTarget?.get(target.id) ?? opts.messages,
          memoryReportMarker: opts.reportMarkers?.get(target.id) ?? opts.memoryReportMarker,
          interact: opts.interactionsByTarget?.get(target.id) ?? opts.interact,
          runId: opts.runIds?.get(target.id),
          signal: ctl.signal,
        });
        opts.onResult?.(results[i]);
      } finally {
        for (const s of signals) s.removeEventListener('abort', abort);
      }
    }
  }));
  return results;
}
