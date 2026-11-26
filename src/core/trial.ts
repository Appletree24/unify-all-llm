import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { withWriteLock } from '../bench/storage.js';
import { atomicWrite } from './atomic-write.js';
import { runOne } from './orchestrator.js';
import { runText } from './proc.js';
import type { RunRecord } from './store.js';
import { buildExecPrompt } from './synth.js';
import type { ModelTarget } from './types.js';
import { selectPlan } from './workflow.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[], env = process.env) =>
  (await exec('git', args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trimEnd();
const variant = z.object({ from: z.string(), state: z.enum(['pending', 'running', 'passed', 'failed', 'error']),
  files: z.array(z.string()), log: z.string(), hash: z.string().optional() });
const manifest = z.object({ id: z.uuid(), turn: z.string(), executor: z.string(), base: z.string(), check: z.string(),
  variants: z.array(variant).length(2), finished: z.boolean(), applied: z.number().int().min(1).max(2).optional() });
type Trial = z.infer<typeof manifest>;
const dirFor = (cwd: string, id: string) => join(cwd, '.unify', 'trials', z.uuid().parse(id));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const message = (err: unknown) => err instanceof Error ? err.message : String(err);
// Keep project journals out of both the baseline and the candidate patches.
const sources = ['.', ':(exclude,glob)**/.unify/**'];
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

async function snapshot(root: string, index: string) {
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  await git(root, ['read-tree', head], env);
  await git(root, ['add', '-A', '--', ...sources], env);
  const tree = await git(root, ['write-tree'], env);
  if (tree === await git(root, ['rev-parse', head + '^{tree}'])) return head;
  return git(root, ['-c', 'user.name=Unify', '-c', 'user.email=trial@localhost', 'commit-tree', tree, '-p', head, '-m', 'Unify trial baseline'], env);
}

async function verify(cwd: string, command: string, signal: AbortSignal, timeoutMs: number, row: Trial['variants'][number]) {
  const win = process.platform === 'win32';
  const script = '.unify-trial-' + randomUUID() + '.cmd';
  if (win) writeFileSync(join(cwd, script), '@echo off\r\n' + command + '\r\nexit /b %errorlevel%\r\n', { flag: 'wx' });
  let output = '';
  try {
    const options = { cwd, nativeExecutable: true, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) };
    for await (const chunk of runText(win ? 'cmd.exe' : 'sh', win ? ['/d', '/c', script] : ['-c', command], options)) {
      output = (output + chunk).slice(-12000);
    }
    row.state = 'passed';
  } catch (err) {
    row.state = signal.aborted ? 'error' : 'failed';
    output += '\n' + message(err);
  }
  row.log = output.trim();
}

export async function runTrial(cwd: string, source: RunRecord, from: string[], executor: ModelTarget, check: string,
  timeoutMs: number, signal: AbortSignal, progress?: (id: string) => void) {
  if (from.length !== 2 || new Set(from).size !== 2 || !check.trim()) throw new Error('试跑需要两个不同的回答目标和一条验证命令');
  if (!executor.adapter.capabilities.exec) throw new Error('请选择支持实施的模型');
  const plans = from.map(target => selectPlan(source, target));
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  const prefix = relative(root, cwd);
  const temp = mkdtempSync(join(tmpdir(), 'unify-trial-'));
  const index = join(temp, 'snapshot.index');
  try {
    const base = await snapshot(root, index);
    const id = randomUUID(), dir = dirFor(cwd, id);
    const trial: Trial = { id, turn: source.id, base, executor: executor.id, check, finished: false, variants: from.map(target =>
      ({ from: target, state: 'pending', files: [], log: '' })) };
    mkdirSync(dir, { recursive: true });
    const save = () => atomicWrite(join(dir, 'trial.json'), JSON.stringify(trial, null, 2));
    save();
    progress?.(id);
    async function candidate(plan: typeof plans[number], i: number) {
      const row = trial.variants[i], work = join(temp, String(i + 1));
      let registered = false;
      try {
        signal.throwIfAborted();
        await git(root, ['worktree', 'add', '--detach', work, base]);
        registered = true;
        row.state = 'running';
        save();
        const workCwd = join(work, prefix);
        const result = await runOne(executor, { mode: 'exec', cwd: workCwd, timeoutMs, signal,
          prompt: buildExecPrompt(source.input.prompt, plan.text) });
        if (!result.ok) throw new Error(result.error || result.status);
        signal.throwIfAborted();
        await git(work, ['add', '-A', '--', ...sources]);
        const args = ['diff', '--cached', ...diffFlags, base];
        row.files = (await git(work, [...args, '--name-only', '-z', '--', ...sources])).split('\0').filter(Boolean);
        const patch = join(dir, (i + 1) + '.patch');
        await git(work, [...args, '--binary', '--full-index', '--output=' + patch, '--', ...sources]);
        row.hash = hash(readFileSync(patch));
        await verify(workCwd, check, signal, timeoutMs, row);
      } catch (err) { row.state = 'error'; row.log = message(err); }
      finally {
        if (registered) {
          try { await git(root, ['worktree', 'remove', '--force', work]); }
          catch (err) { row.log += '\n工作树保留于 ' + work + '：' + message(err); }
        }
        save();
      }
    }
    const completed = await Promise.allSettled(plans.map(candidate));
    for (const item of completed) if (item.status === 'rejected') throw item.reason;
    trial.finished = true;
    save();
    return trial;
  } finally {
    if (existsSync(index)) unlinkSync(index);
    try { rmdirSync(temp); } catch { /* A worktree that could not be removed is retained for recovery. */ }
  }
}

export function loadTrial(cwd: string, id: string): Trial {
  return manifest.parse(JSON.parse(readFileSync(join(dirFor(cwd, id), 'trial.json'), 'utf8')));
}

function candidatePatch(cwd: string, id: string, slot: number) {
  if (slot !== 1 && slot !== 2) throw new Error('方案编号应为 1 或 2');
  const trial = loadTrial(cwd, id), row = trial.variants[slot - 1];
  if (!row.hash) throw new Error('该方案没有可用补丁');
  const patch = readFileSync(join(dirFor(cwd, id), slot + '.patch'));
  if (hash(patch) !== row.hash) throw new Error('补丁已改变，请重新试跑');
  return { trial, row, patch };
}

export function trialDiff(cwd: string, id: string, slot: number) {
  return candidatePatch(cwd, id, slot).patch.toString('utf8');
}

export function applyTrial(cwd: string, id: string, slot: number) {
  const dir = dirFor(cwd, id);
  loadTrial(cwd, id);
  withWriteLock(dir, () => {
    const { trial, row, patch } = candidatePatch(cwd, id, slot);
    if (trial.applied === slot) return;
    if (trial.applied) throw new Error('本次试跑已采纳另一方案');
    if (!trial.finished) throw new Error('请先等待试跑完成');
    if (row.state === 'error' || !patch.length) throw new Error('该方案没有可采纳的改动');
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true }).trimEnd();
    // Default git apply checks the entire patch before writing any file, leaving the index untouched.
    execFileSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], { cwd: root, input: patch, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    trial.applied = slot;
    atomicWrite(join(dir, 'trial.json'), JSON.stringify(trial, null, 2));
  });
}

export function trialSummary(t: Trial) {
  const names = { pending: '等待', running: '运行中', passed: '通过', failed: '验证失败', error: '运行错误' };
  return ['试跑 ' + t.id + ' · 实施 ' + t.executor, '验证命令 ' + t.check,
    ...t.variants.map((r,i) => [String(i+1) + '. ' + r.from + ' · ' + names[r.state], r.files.join(', ') || '无文件改动',
      r.log, t.applied === i+1 ? '已采纳' : ''].filter(Boolean).join('\n'))].join('\n\n');
}
