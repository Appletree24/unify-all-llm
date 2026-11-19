import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

const isWin = process.platform === 'win32';
const SAFE_ARG = /^[\w@.,:=/\\-]+$/;
const TERM_GRACE_MS = 400;
const CLOSE_LIMIT_MS = 1800;

export interface ProcOptions {
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
}

/** POSIX children own a process group; cancellation includes inherited-pipe descendants. */
function start(cmd: string, args: string[], opts: ProcOptions, interactive = false) {
  opts.signal?.throwIfAborted();
  if (isWin && ![cmd, ...args].every((a) => SAFE_ARG.test(a))) throw new Error('Windows shell 参数包含不支持的字符');
  const child = spawn(cmd, args, { cwd: opts.cwd, shell: isWin, detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let closed = false;
  let failure: Error | undefined;
  let code: number | null = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-4000); });
  const exited = new Promise<void>((resolve) => {
    child.once('error', (err) => { failure = err; });
    child.once('close', (value) => { code = value; closed = true; resolve(); });
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) failure ??= err instanceof Error ? err : new Error(String(err));
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    if (isWin) {
      if (child.pid && !closed) await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        const timeout = setTimeout(() => { killer.kill(); resolve(); }, CLOSE_LIMIT_MS);
        killer.once('error', () => { clearTimeout(timeout); child.kill(); resolve(); });
        killer.once('close', () => { clearTimeout(timeout); resolve(); });
      });
    } else {
      signalGroup('SIGTERM');
      // The leader may close before a descendant does; still kill the entire group.
      await new Promise<void>((resolve) => setTimeout(resolve, TERM_GRACE_MS));
      signalGroup('SIGKILL');
    }
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise<void>((resolve) => { timeout = setTimeout(resolve, CLOSE_LIMIT_MS); })]);
    if (timeout) clearTimeout(timeout);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  })();
  const abort = () => { void stop(); };
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  child.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE' && !opts.signal?.aborted) failure ??= err;
  });
  if (!interactive) child.stdin.end(opts.stdin ?? '', 'utf8');
  return {
    child,
    async finish() {
      await exited;
      opts.signal?.throwIfAborted();
      if (failure) throw failure;
      if (code !== 0) throw new Error(`${cmd} 退出码 ${code}: ${stderr.trim().slice(-800)}`);
    },
    async cleanup() {
      opts.signal?.removeEventListener('abort', abort);
      if (stopping) await stopping;
      else if (!closed) await stop();
      // A successful leader must not leave background descendants behind either.
      else if (!isWin) signalGroup('SIGKILL');
    },
  };
}

async function* readJsonl(p: ReturnType<typeof start>): AsyncGenerator<Record<string, any>> {
  const rl = createInterface({ input: p.child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      // Provider payloads evolve independently; each adapter narrows the fields it consumes.
      yield z.record(z.string(), z.any()).parse(JSON.parse(line));
    }
    await p.finish();
  } finally {
    rl.close();
    await p.cleanup();
  }
}

/** Malformed JSONL is a protocol failure, never silently discarded output. */
export async function* runJsonl(cmd: string, args: string[], opts: ProcOptions): AsyncGenerator<Record<string, any>> {
  yield* readJsonl(start(cmd, args, opts));
}

/** Keep stdin open for a control request. The first matching reply ends the exchange. */
export async function requestJsonl<T>(
  cmd: string, args: string[], opts: ProcOptions, request: object,
  reply: (message: Record<string, any>, send: (value: object) => void) => T | undefined,
): Promise<T> {
  const proc = start(cmd, args, opts, true);
  const send = (value: object) => { proc.child.stdin.write(JSON.stringify(value) + '\n'); };
  send(request);
  for await (const message of readJsonl(proc)) {
    const result = reply(message, send);
    if (result !== undefined) return result;
  }
  throw new Error(`${cmd} 未返回查询结果`);
}

/** Plain commands succeed only after stdout EOF and a zero exit code. */
export async function* runText(cmd: string, args: string[], opts: ProcOptions): AsyncGenerator<string> {
  const p = start(cmd, args, opts);
  try {
    p.child.stdout.setEncoding('utf8');
    for await (const chunk of p.child.stdout) yield String(chunk);
    await p.finish();
  } finally {
    await p.cleanup();
  }
}

async function capture(cmd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    let out = '';
    for await (const chunk of runText(cmd, args, { cwd: process.cwd(), signal: ctl.signal })) out = (out + chunk).slice(-4000);
    return out.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined; // Detection is advisory; execution reports transport failures.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const probeVersion = (cmd: string, signal?: AbortSignal) => capture(cmd, ['--version'], signal);
export const commandExists = async (cmd: string, signal?: AbortSignal) => (await capture(isWin ? 'where' : 'which', [cmd], signal)) !== undefined;
