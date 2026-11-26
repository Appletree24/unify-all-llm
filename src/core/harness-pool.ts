import { openJsonl, type JsonlSession } from './proc.js';
import type { ProviderAdapter, RunRequest } from './types.js';

type Worker = { session: JsonlSession; initialized?: Record<string, any>; timer?: NodeJS.Timeout };

/** Each running call owns its worker exclusively. Only a completed protocol turn can return it. */
export class HarnessPool {
  private readonly idle = new Map<string, Worker>();
  private readonly workers = new Set<Worker>();
  private readonly closing = new Set<Promise<void>>();
  readonly available = new WeakMap<ProviderAdapter, number>();
  private disposed = false;

  constructor(private idleMs = 300_000, private capacity = 3) {}

  take(key: string | undefined, start: () => JsonlSession): { worker: Worker; reused: boolean } {
    if (this.disposed) throw new Error('项目已关闭');
    const idle = key && this.idle.get(key);
    if (idle && key) {
      this.idle.delete(key);
      clearTimeout(idle.timer);
      if (idle.session.alive) return { worker: idle, reused: true };
      void this.close(idle);
    }
    const worker = { session: start() };
    this.workers.add(worker);
    return { worker, reused: false };
  }

  release(worker: Worker, key?: string): Promise<void> | void {
    if (this.disposed || !key || !worker.session.alive) return this.close(worker);
    const previous = this.idle.get(key);
    if (previous) this.evict(key, previous);
    this.idle.set(key, worker);
    worker.timer = setTimeout(() => this.evict(key, worker), this.idleMs);
    worker.timer.unref();
    if (this.idle.size > this.capacity) this.evict(...this.idle.entries().next().value!);
  }

  private evict(key: string, worker: Worker) {
    this.idle.delete(key);
    void this.close(worker);
  }

  private close(worker: Worker) {
    clearTimeout(worker.timer);
    if (!this.workers.delete(worker)) return;
    const done = worker.session.close();
    this.closing.add(done);
    void done.finally(() => this.closing.delete(done));
    return done;
  }

  async dispose() {
    this.disposed = true;
    this.idle.clear();
    for (const worker of this.workers) this.close(worker);
    await Promise.all(this.closing);
  }
}

/** Borrow an iterator for one turn without returning (and closing) the underlying stdout iterator. */
export function openHarness(req: RunRequest, bin: { cmd: string; prefixArgs?: string[]; nativeExecutable?: boolean },
  args: string[], protocol: string, resumeKey?: string) {
  const pool = req.harnesses;
  const key = (identity: string) => JSON.stringify([req.cwd, req.sessionId, bin.cmd, bin.prefixArgs, bin.nativeExecutable, req.mode, protocol, identity]);
  const start = () => openJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], { cwd: req.cwd, nativeExecutable: bin.nativeExecutable });
  req.signal?.throwIfAborted();
  const { worker, reused } = pool?.take(resumeKey === undefined ? undefined : key(resumeKey), start)
    ?? { worker: { session: start() } as Worker, reused: false };
  const { session } = worker;
  let released = false;
  const abort = () => { void session.close(); };
  req.signal?.addEventListener('abort', abort, { once: true });
  return {
    reused, worker, send: session.send,
    events: { [Symbol.asyncIterator]: () => ({ next: () => session.events.next() }) },
    async release(identity?: string) {
      if (released) return;
      released = true;
      req.signal?.removeEventListener('abort', abort);
      if (pool) await pool.release(worker, req.signal?.aborted || identity === undefined ? undefined : key(identity));
      else await session.close();
    },
  };
}
