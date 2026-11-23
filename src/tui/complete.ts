import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Suggestion {
  /** Text that replaces the token being completed. */
  value: string;
  label: string;
  detail?: string;
}

export interface Completion {
  kind: 'command' | 'argument' | 'file';
  /** Code point range of the token in the editor. */
  start: number;
  end: number;
  items: Suggestion[];
}

export interface CommandSpec {
  name: string;
  detail: string;
  /** How the argument is completed; 'required' commands are never run bare. */
  arg?: 'targets' | 'target' | 'executor';
  required?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  { name: 'models', detail: '选择之后提问的目标，如 /models codex,deepseek', arg: 'targets' },
  { name: 'settings', detail: '设置模型、思考强度、官方 API 和运行偏好' },
  { name: 'synth', detail: '设置汇总目标', arg: 'target', required: true },
  { name: 'branch', detail: '查看本地分支；/branch 分支名 切换' },
  { name: 'bench', detail: '将当前轮次留作评测题，可附一句预期行为' },
  { name: 'quota', detail: '监控各模型的套餐余量和重置时间' },
  { name: 'exec', detail: '按汇总或唯一成功回答实施，可指定执行目标', arg: 'executor' },
  { name: 'use', detail: '下轮追问沿用指定目标的回答（不带参数恢复默认）', arg: 'target' },
  { name: 'retry', detail: '重试失败的目标，或指定目标重新回答', arg: 'targets' },
  { name: 'cancel', detail: '取消本轮，或只取消某个目标', arg: 'target' },
  { name: 'new', detail: '开始新对话' },
  { name: 'copy', detail: '复制当前回答' },
  { name: 'memory', detail: '查看和管理各工具的记忆；/memory web 打开网页界面' },
  { name: 'mouse', detail: '开关鼠标滚轮（关闭后可直接拖选文本）' },
  { name: 'help', detail: '快捷键与命令' },
  { name: 'exit', detail: '退出' },
  { name: 'quit', detail: '退出' },
];

export interface TargetInfo { id: string; label: string; exec: boolean }

const MAX_FILES = 20_000;
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', '.git', '.unify']);

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 6) visit(path, depth + 1); }
      else if (e.isFile()) out.push(path);
    }
  };
  visit('', 0);
  return out;
}

/** Files that `@` can mention: what git tracks or would track, else a bounded walk. */
export function listFiles(cwd: string): string[] {
  try {
    const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean).slice(0, MAX_FILES);
  } catch { /* not a repository, or no git */ }
  return walk(cwd);
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

export function matchFiles(files: string[], query: string, limit = 30): string[] {
  const q = query.toLowerCase();
  const scored: [number, string][] = [];
  for (const f of files) {
    const path = f.toLowerCase();
    const base = path.slice(path.lastIndexOf('/') + 1);
    const score = !q ? 0 : base.startsWith(q) ? 0 : path.startsWith(q) ? 1 : base.includes(q) ? 2 : path.includes(q) ? 3 : subsequence(q, path) ? 4 : -1;
    if (score >= 0) scored.push([score, f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1)).slice(0, limit).map((s) => s[1]);
}

/** What can be completed at the caret, if anything. */
export function complete(chars: string[], caret: number, targets: TargetInfo[], files: () => string[]): Completion | undefined {
  const before = chars.slice(0, caret).join('');
  if (chars[0] === '/' && !before.includes('\n')) {
    const cmd = /^\/(\S*)$/.exec(before);
    if (cmd) {
      const items = COMMANDS.filter((c) => c.name.startsWith(cmd[1].toLowerCase())).map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, detail: c.detail }));
      // Complete the whole command word, including what is right of the caret.
      let end = caret;
      while (end < chars.length && !/\s/.test(chars[end])) end++;
      return items.length ? { kind: 'command', start: 0, end, items } : undefined;
    }
    const arg = /^\/(\S+)\s+(.*)$/.exec(before);
    const spec = arg && COMMANDS.find((c) => c.name === arg[1]);
    if (!arg || !spec?.arg) return undefined;
    const parts = arg[2].split(/[,\s]+/);
    const token = parts.pop() ?? '';
    if (spec.arg !== 'targets' && parts.length) return undefined;
    const items = targets
      .filter((t) => t.id.startsWith(token) && !parts.includes(t.id) && (spec.arg !== 'executor' || t.exec))
      .map((t) => ({ value: t.id, label: t.id, detail: t.label === t.id ? undefined : t.label }));
    return items.length ? { kind: 'argument', start: caret - Array.from(token).length, end: caret, items } : undefined;
  }
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!mention) return undefined;
  const items = matchFiles(files(), mention[1]).map((f) => ({ value: `@${f} `, label: f }));
  return items.length ? { kind: 'file', start: caret - Array.from(mention[1]).length - 1, end: caret, items } : undefined;
}
