import { join } from 'node:path';
import { readJson } from './config.js';
import { listRunIds, loadRun, type RunRecord } from './store.js';
import { SESSION_TITLE_LIMIT } from './types.js';

export function sessionSettingsPath(cwd: string, first: RunRecord): string {
  return join(cwd, '.unify', 'runs', first.id, 'desktop-session.json');
}

export function readSessionSettings(cwd: string, first: RunRecord) {
  try {
    const data = readJson(sessionSettingsPath(cwd, first)) as { title?: unknown; pinned?: unknown } | undefined;
    return { title: typeof data?.title === 'string' ? data.title : undefined, pinned: data?.pinned === true };
  } catch { return { title: undefined, pinned: false }; }
}

export function readSessionRuns(cwd: string, sessionId?: string): RunRecord[] {
  const runs: RunRecord[] = [];
  for (const id of listRunIds(cwd)) {
    try {
      const run = loadRun(cwd, id);
      if (!sessionId || run.sessionId === sessionId) runs.push(run);
    } catch { /* A missing or unreadable turn does not hide other sessions. */ }
  }
  return runs;
}

export const runningStatus = (status: RunRecord['status']) =>
  status === 'created' || status === 'deciding' || status === 'answering' || status === 'synthesizing';

/** Input is in run-id order, as returned by listRunIds. */
export function summarizeSessions(cwd: string, runs: RunRecord[]) {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const group = groups.get(run.sessionId);
    if (group) group.push(run);
    else groups.set(run.sessionId, [run]);
  }
  return Array.from(groups, ([id, group]) => {
    const first = group[0];
    const last = group[group.length - 1];
    const { title, pinned } = readSessionSettings(cwd, first);
    return {
      id, title: title ?? first.question.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_LIMIT), pinned,
      createdAt: first.createdAt, updatedAt: last.updatedAt, turns: group.filter(r => r.kind === 'comparison').length,
      status: group.find(r => runningStatus(r.status))?.status ?? last.status, hasExec: group.some(r => r.kind === 'execution'),
    };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}
