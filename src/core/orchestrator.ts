import type { ProviderAdapter, ProviderEvent, RunMode, RunResult } from './types.js';

export interface RunOptions {
  prompt: string;
  cwd: string;
  mode: RunMode;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (provider: string, ev: ProviderEvent) => void;
}

/** Run one provider to completion. Never throws: failures come back as ok=false. */
export async function runOne(adapter: ProviderAdapter, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) ctl.abort();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);

  const res: RunResult = { provider: adapter.id, ok: false, text: '', reasoning: '', durationMs: 0 };
  let streamed = '';
  let finished = false;
  const emit = (ev: ProviderEvent) => opts.onEvent?.(adapter.id, ev);

  try {
    for await (const ev of adapter.run({
      prompt: opts.prompt,
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      signal: ctl.signal,
    })) {
      if (ev.type === 'delta') streamed += ev.text;
      else if (ev.type === 'reasoning') res.reasoning += ev.text;
      else if (ev.type === 'done') {
        res.ok = true;
        res.text = ev.text || streamed;
        res.usage = ev.usage;
        finished = true;
      } else if (ev.type === 'error') {
        res.error = ev.message;
        res.text = streamed;
        finished = true;
      }
      emit(ev);
    }
    if (!finished) {
      // Stream ended without a terminal event: accept whatever text arrived.
      if (streamed.trim()) {
        res.ok = true;
        res.text = streamed;
        emit({ type: 'done', text: streamed });
      } else {
        res.error = '进程结束但没有输出';
        emit({ type: 'error', message: res.error });
      }
    }
  } catch (err) {
    if (!finished) {
      res.ok = false;
      res.text = streamed;
      res.error = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message: res.error });
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    res.durationMs = Date.now() - started;
  }
  return res;
}

/** Send the same prompt to every adapter concurrently. */
export function fanOut(
  adapters: ProviderAdapter[],
  opts: Omit<RunOptions, 'model'> & { models?: Record<string, string> },
): Promise<RunResult[]> {
  return Promise.all(adapters.map((a) => runOne(a, { ...opts, model: opts.models?.[a.id] })));
}
