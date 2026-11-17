import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CustomProviderConfig } from '../providers/custom.js';
import type { RunResult } from './types.js';

export interface Config {
  /** Providers to ask. Default: every installed one. */
  providers?: string[];
  synthesizer?: string;
  executor?: string;
  models?: Record<string, string>;
  timeoutSec?: number;
  /** Extra models, keyed by id: an OpenAI-compatible endpoint or a stdin/stdout command. */
  custom?: Record<string, CustomProviderConfig>;
  /** Model that routes each question before the fan-out (see core/decider.ts). Off when unset. */
  decider?: string;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  question: string;
  results: RunResult[];
  synthesis?: { provider: string; labels: Record<string, string>; result: RunResult };
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`无法解析 ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Project config (./unify.config.json) overrides user config (~/.unify/config.json),
 * except `custom`: that can run commands and send prompts to arbitrary servers, so it
 * is only honored from the user config and never from a repository you happen to be in.
 */
export function loadConfig(cwd: string): Config {
  const user = readJson<Config>(join(homedir(), '.unify', 'config.json')) ?? {};
  const project = readJson<Config>(join(cwd, 'unify.config.json')) ?? {};
  return { ...user, ...project, models: { ...user.models, ...project.models }, custom: user.custom };
}

const runsDir = (cwd: string) => join(cwd, '.unify', 'runs');

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Writes run.json plus one readable .md per answer. Returns the run directory. */
export function saveRun(cwd: string, run: RunRecord): string {
  const dir = join(runsDir(cwd), run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
  writeFileSync(join(dir, 'question.md'), run.question, 'utf8');
  for (const r of run.results) {
    writeFileSync(join(dir, `${r.provider}.md`), r.ok ? r.text : `**失败**: ${r.error ?? ''}\n\n${r.text}`, 'utf8');
  }
  if (run.synthesis?.result.ok) {
    writeFileSync(join(dir, 'synthesis.md'), run.synthesis.result.text, 'utf8');
  }
  return dir;
}

export function listRunIds(cwd: string): string[] {
  const dir = runsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Load a run by id, or the latest when id is omitted. */
export function loadRun(cwd: string, id?: string): RunRecord {
  const target = id ?? listRunIds(cwd).at(-1);
  if (!target) throw new Error('当前目录下还没有任何记录，先运行 unify ask');
  if (!/^[\w-]+$/.test(target)) throw new Error(`无效的记录 id: ${target}`);
  const run = readJson<RunRecord>(join(runsDir(cwd), target, 'run.json'));
  if (!run) throw new Error(`找不到记录 ${target}`);
  return run;
}
