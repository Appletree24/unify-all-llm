import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type { Commit } from './types.js';

function git(dir: string, args: string[]): string | undefined {
  try {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return r.status === 0 ? r.stdout : undefined;
  } catch { return undefined; }
}

export interface Blame {
  /** Index = line number - 1. undefined marks a line not yet committed. */
  lines: (Commit | undefined)[];
  history: Commit[];
}

/** Per-line authorship of a tracked file; undefined when the file is not under version control. */
export function blame(path: string): Blame | undefined {
  const dir = dirname(path);
  const file = basename(path);
  const out = git(dir, ['blame', '--porcelain', '--', file]);
  if (out === undefined) return undefined;
  const commits = new Map<string, Commit>();
  const lines: (Commit | undefined)[] = [];
  let current: Commit | undefined;
  for (const line of out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (head) {
      current = commits.get(head[1]) ?? { hash: head[1], author: '', time: 0, summary: '' };
      commits.set(head[1], current);
      lines[Number(head[2]) - 1] = /^0+$/.test(head[1]) ? undefined : current;
    } else if (current && line.startsWith('author ')) current.author = line.slice(7);
    else if (current && line.startsWith('author-time ')) current.time = Number(line.slice(12)) * 1000;
    else if (current && line.startsWith('summary ')) current.summary = line.slice(8);
  }
  const log = git(dir, ['log', '-8', '--format=%H%x1f%an%x1f%at%x1f%s', '--', file]) ?? '';
  const history = log.split('\n').filter(Boolean).map((l) => {
    const [hash, author, time, summary] = l.split('\x1f');
    return { hash, author, time: Number(time) * 1000, summary };
  });
  return { lines, history };
}
