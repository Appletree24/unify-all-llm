import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const isWin = process.platform === 'win32';

// On Windows the CLIs are npm .cmd shims, so we must go through the shell.
// Arguments are therefore restricted to a safe charset; anything free-form
// (the prompt) travels over stdin instead.
const SAFE_ARG = /^[\w@.,:=\/\\-]+$/;

export interface ProcOptions {
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // already gone
  }
}

/** Start a CLI with the prompt on stdin. `finish` rejects on a bad exit; `cleanup` always runs. */
function start(cmd: string, args: string[], opts: ProcOptions) {
  for (const a of [cmd, ...args]) {
    if (!SAFE_ARG.test(a)) throw new Error(`不安全的命令行参数: ${a}`);
  }
  const child: ChildProcessWithoutNullStreams = spawn(cmd, args, {
    cwd: opts.cwd,
    shell: isWin,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  exited.catch(() => {});

  const kill = () => killTree(child.pid);
  if (opts.signal?.aborted) kill();
  else opts.signal?.addEventListener('abort', kill, { once: true });

  child.stdin.on('error', () => {});
  child.stdin.end(opts.stdin ?? '', 'utf8');

  return {
    child,
    async finish(): Promise<void> {
      const code = await exited;
      if (opts.signal?.aborted) throw new Error('已取消或超时');
      if (code !== 0) throw new Error(`${cmd} 退出码 ${code}: ${stderr.trim().slice(-800)}`);
    },
    cleanup(): void {
      opts.signal?.removeEventListener('abort', kill);
      if (child.exitCode === null) kill();
    },
  };
}

/** Spawn a CLI and yield every JSON object it prints on stdout, one per line. */
export async function* runJsonl(cmd: string, args: string[], opts: ProcOptions): AsyncGenerator<any> {
  const p = start(cmd, args, opts);
  try {
    const rl = createInterface({ input: p.child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      yield obj;
    }
    await p.finish();
  } finally {
    p.cleanup();
  }
}

/** Spawn a CLI and yield its stdout as plain text chunks. */
export async function* runText(cmd: string, args: string[], opts: ProcOptions): AsyncGenerator<string> {
  const p = start(cmd, args, opts);
  try {
    p.child.stdout.setEncoding('utf8');
    for await (const chunk of p.child.stdout) yield chunk as string;
    await p.finish();
  } finally {
    p.cleanup();
  }
}

function capture(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (![cmd, ...args].every((a) => SAFE_ARG.test(a))) return resolve(undefined);
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { shell: isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve(undefined);
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : undefined);
    });
  });
}

/** Run `<cmd> --version`; resolves undefined when the command is missing. */
export const probeVersion = (cmd: string) => capture(cmd, ['--version']);

/** Whether a command is on PATH, without running it. */
export const commandExists = async (cmd: string) => (await capture(isWin ? 'where' : 'which', [cmd])) !== undefined;
