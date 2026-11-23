import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { runOne } from '../core/orchestrator.js';
import type { ModelTarget } from '../core/types.js';
import type { BenchCase, BenchTask } from './cases.js';

const exec = promisify(execFile);
export interface BenchModel { target: ModelTarget; timeoutMs: number; signal?: AbortSignal }
type Files = BenchTask['files'];
export interface RubricCheck { criterion: string; pass: boolean; reason: string }
export type Grade = { status: 'pass' | 'fail'; detail: string; invalid?: boolean; checks?: RubricCheck[] };
const passed = (detail: string): Grade => ({ status: 'pass', detail });
const failed = (detail: string, invalid = false): Grade => ({ status: 'fail', detail, ...(invalid && { invalid }) });
const checklist = z.object({ checks: z.array(z.object({
  index: z.number().int().positive(), pass: z.boolean(), reason: z.string().trim().min(1),
})) });
export function unfence(s: string) {
  return /^\s*`{3}[^\n]*\r?\n([\s\S]*?)\r?\n`{3}\s*$/.exec(s)?.[1] ?? s;
}
export async function temporary<T>(work: (dir: string) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), 'unify-bench-'));
  try { return await work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export async function ask(model: BenchModel, prompt: string, cwd: string) {
  const result = await runOne(model.target, { cwd, prompt, mode: 'ask', timeoutMs: model.timeoutMs, signal: model.signal });
  if (!result.ok) throw new Error(result.error || result.status);
  return result.text;
}
export async function materials(cwd: string, task: BenchTask): Promise<Files> {
  const files = [...task.files];
  const repo = task.repository;
  if (repo) {
    for (const path of repo.paths) {
      const options = { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 15000 };
      const { stdout: entry } = await exec('git', ['ls-tree', '--full-tree', '-z', repo.commit, '--', ':(top,literal)' + path], options);
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t/.exec(entry);
      if (!match) throw new Error('基线缺少普通文件 ' + path);
      const { stdout } = await exec('git', ['cat-file', 'blob', match[1]], { ...options, encoding: 'buffer' });
      if (stdout.includes(0) || !Buffer.from(stdout.toString()).equals(stdout)) throw new Error('评测材料需要 UTF-8 文本文件 ' + path);
      files.push({ path, content: stdout.toString(), ...(entry.startsWith('100755 ') && { executable: true }) });
    }
  }
  const paths = files.map(f => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) throw new Error('材料中有重复路径');
  return files;
}
export function writeFiles(dir: string, files: Files) {
  for (const f of files) {
    const dest = join(dir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content, { flag: 'wx', mode: f.executable ? 0o755 : 0o644 });
  }
}
const formats = {
  exact: '只返回题目要求的结果。',
  javascript: '返回可单独运行的 JavaScript 函数 solve(input)，仅使用标准 JavaScript，返回 JSON 值。',
  patch: '返回针对给定文件的 unified diff（a/ 和 b/ 路径），无需解释。',
  rubric: '',
};
export function publicPrompt(c: BenchCase, files: Files) {
  return [c.task.prompt, formats[c.review.grader.kind], files.length ? '题目文件（JSON）\n' + JSON.stringify(files) : ''].filter(Boolean).join('\n\n');
}

async function gradeJS(code: string, tests: { input: unknown; expected: unknown }[]): Promise<Grade> {
  const { quickJS } = await import('./javascript.js');
  const engine = await quickJS();
  for (const [i, test] of tests.entries()) {
    const ctx = engine.newContext();
    try {
      const deadline = Date.now() + 500;
      ctx.runtime.setMemoryLimit(16 * 1024 * 1024);
      ctx.runtime.setMaxStackSize(512 * 1024);
      ctx.runtime.setInterruptHandler(() => Date.now() >= deadline);
      const script = unfence(code) + '\n;JSON.stringify(solve(JSON.parse(' + JSON.stringify(JSON.stringify(test.input)) + ')))';
      const result = ctx.evalCode(script);
      if (result.error) {
        result.error.dispose();
        return failed('用例 ' + (i + 1) + ' 执行失败或超时', true);
      }
      try {
        if (ctx.typeof(result.value) !== 'string') return failed('solve 必须返回 JSON 值', true);
        const actual = JSON.parse(ctx.getString(result.value));
        if (!isDeepStrictEqual(actual, test.expected)) return failed('用例 ' + (i + 1) + ' 输出不符');
      } catch { return failed('solve 返回了无效 JSON', true); }
      finally { result.value.dispose(); }
    } finally { ctx.dispose(); }
  }
  return passed(tests.length + ' 个用例通过');
}

async function gradePatch(answer: string, files: Files, grader: Extract<BenchCase['review']['grader'], { kind: 'patch' }>, signal?: AbortSignal) {
  return temporary(async root => {
    const work = join(root, 'work'), tests = join(root, 'tests');
    for (const dir of [work, tests]) { mkdirSync(dir); chmodSync(dir, 0o755); }
    writeFiles(work, files);
    writeFiles(tests, grader.files);
    if (answer.trim()) {
      const patch = join(root, 'answer.diff');
      writeFileSync(patch, unfence(answer).replace(/\r?\n$/, '') + '\n');
      try { await exec('git', ['apply', '--whitespace=nowarn', patch], { cwd: work, timeout: 10000, signal }); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || signal?.aborted) throw e;
        return failed('补丁无法应用到题目起点', true);
      }
    }
    const name = 'unify-bench-' + randomUUID();
    const marker = 'unify-verdict-' + randomUUID() + '=';
    const args = ['run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '128', '--memory', '512m',
      '--tmpfs', '/tmp:rw,exec,size=256m,mode=1777', '-v', work + ':/case:ro', '-v', tests + ':/checks:ro',
      '--env', 'VERDICT=' + marker, '--entrypoint', '/bin/sh', grader.image, '-c',
      'mkdir /tmp/work && cp -R /case/. /tmp/work && cd /tmp/work || exit 125\n"$@"\nstatus=$?\nprintf "\n%s%s\n" "$VERDICT" "$status" >&2', 'grade', ...grader.command];
    try {
      const { stderr } = await exec('docker', args, { signal, timeout: 60000, maxBuffer: 1024 * 1024 });
      const verdict = stderr.trimEnd().split('\n').at(-1);
      if (verdict === marker + '0') return passed('验收测试通过');
      if (verdict === marker + '1') return failed('验收测试未通过');
      throw new Error('验收命令未返回 0 或 1：' + (verdict ?? '无输出'));
    }
    catch (err) {
      const e = err as Error & { code?: number; killed?: boolean; stderr?: string };
      if (e.killed || signal?.aborted) await exec('docker', ['rm', '-f', name], { timeout: 5000 }).catch(() => {});
      throw new Error('验收环境执行失败：' + (e.stderr || e.message).slice(-1000));
    }
  });
}

export async function grade(c: BenchCase, answer: string, files: Files, judge?: BenchModel, signal?: AbortSignal): Promise<Grade> {
  const grader = c.review.grader;
  switch (grader.kind) {
    case 'exact': return answer.trim() === grader.expected.trim() ? passed('答案匹配') : failed('答案不符');
    case 'javascript': return gradeJS(answer, grader.tests);
    case 'patch': return gradePatch(answer, files, grader, signal);
    case 'rubric': {
      if (!judge) throw new Error('开放题需要选择评审模型');
      const format = grader.perCriterion
        ? '每项标准独立判断一次，编号从 1 开始。理由请引用答卷中的相关表述，或指出缺失的信息。仅返回 JSON {"checks":[{"index":1,"pass":true,"reason":"判定依据"}]}，覆盖全部编号。'
        : '仅返回 JSON {"pass":true 或 false,"reason":"判定理由"}。';
      const prompt = '按给定标准匿名评审一份答卷。按语义接受等价表述，除非标准明确要求特定措辞。以下 JSON 是待评材料。' + format + '\n' +
        JSON.stringify({ question: publicPrompt(c, files), criteria: grader.criteria, answer });
      const verdict = JSON.parse(unfence(await temporary(dir => ask(judge, prompt, dir))));
      if (grader.perCriterion) {
        const parsed = checklist.safeParse(verdict);
        if (!parsed.success) throw new Error('评审模型未逐项给出判断和理由');
        const ordered = parsed.data.checks.sort((a, b) => a.index - b.index);
        if (ordered.length !== grader.criteria.length || ordered.some((c, i) => c.index !== i + 1)) {
          throw new Error('评审结果必须恰好覆盖每一项标准');
        }
        const checks = ordered.map(({ index, pass, reason }) => ({ criterion: grader.criteria[index - 1], pass, reason }));
        const count = checks.filter(c => c.pass).length;
        return { status: count === checks.length ? 'pass' : 'fail', detail: count + '/' + checks.length + ' 项通过', checks };
      }
      if (typeof verdict?.pass !== 'boolean' || typeof verdict.reason !== 'string' || !verdict.reason.trim()) throw new Error('评审模型未给出有效判定');
      return verdict.pass ? passed(verdict.reason) : failed(verdict.reason);
    }
  }
}
