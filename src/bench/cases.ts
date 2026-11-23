import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { listRunIds, loadRun, type RunRecord } from '../core/store.js';

import { atomicWrite } from '../core/atomic-write.js';
import { caseId, deleteCase, getCase, publishedIds, readCatalog, type Collection } from './catalog.js';
import { filename, ids, insert, read, withWriteLock } from './storage.js';
export { caseId, getCase, publishedIds, storeValidated } from './catalog.js';
export type { Collection, Publication } from './catalog.js';
import { caseSchema, type BenchCase, type BenchKind } from './schema.js';
export { caseSchema, repoSchema, reviewSchema, taskSchema, type BenchCase, type BenchKind, type BenchTask, type Repository } from './schema.js';

const nonempty = z.string().min(1);
const sourceSchema = z.object({ turn: nonempty, call: z.string().optional() });
const candidateSchema = z.object({ version: z.literal(1), id: nonempty, source: sourceSchema, title: nonempty, note: z.string() });
export type Candidate = z.infer<typeof candidateSchema>;
export type BenchIndex = { collections: Collection[]; candidates: Candidate[]; drafts: { id: string; title: string }[]; cases: { id: string; title: string; kind: BenchKind }[] };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const inbox = (cwd: string) => join(cwd, '.unify', 'bench', 'inbox');
export const draftsDir = (cwd: string) => join(cwd, '.unify', 'bench', 'drafts');
export function sourceAnswer(run: RunRecord, call?: string) {
  const results = [...run.results, ...(run.synthesis ? [run.synthesis.result] : [])];
  if (!call) return results.map(r => r.text || r.error || '').filter(Boolean).join('\n\n');
  const match = results.find(r => r.runId === call);
  if (!match) throw new Error('这条回答不属于所选轮次');
  return match.text || match.error || '';
}
export function capture(cwd: string, turn: string | undefined, call?: string, note = ''): Candidate {
  const run = loadRun(cwd, turn);
  turn = run.id;
  sourceAnswer(run, call);
  // A different observation about the same answer is a separate candidate.
  const id = digest(JSON.stringify([turn, call ?? '', note.trim()])).slice(0, 24);
  const candidate = candidateSchema.parse({ version: 1, id, title: run.question.slice(0, 100), source: { turn, call }, note: note.trim() });
  insert(inbox(cwd), id, candidate);
  return candidate;
}
export function getCandidate(cwd: string, id: string) {
  return candidateSchema.parse(read(filename(inbox(cwd), id)));
}
export function listBench(cwd: string): BenchIndex {
  const catalog = readCatalog(cwd);
  return { collections: catalog.collections, candidates: ids(inbox(cwd)).map(id => getCandidate(cwd, id)),
    drafts: ids(draftsDir(cwd)).map(id => {
      try { return { id, title: getDraft(cwd, id).task.title }; }
      catch { return { id, title: '草稿格式有误 · ' + id }; }
    }),
    cases: publishedIds(cwd, catalog).map(id => { const c = getCase(cwd, id); return { id, title: c.task.title, kind: c.review.grader.kind }; }) };
}
export function saveDraft(cwd: string, data: BenchCase, previous?: { id: string; data: BenchCase }) {
  const value = caseSchema.parse(data);
  const dir = draftsDir(cwd);
  return withWriteLock(dir, () => {
    if (previous) {
      const path = filename(dir, previous.id);
      if (!existsSync(path) || caseId(getDraft(cwd, previous.id)) !== caseId(previous.data)) throw new Error('草稿已被修改或删除，请重新打开');
      atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
      return previous.id;
    }
    let id = caseId(value);
    if (existsSync(filename(dir, id)) && caseId(getDraft(cwd, id)) !== id) id = digest(randomUUID()).slice(0, 24);
    insert(dir, id, value);
    return id;
  });
}

export function deleteEntry(cwd: string, kind: 'case' | 'draft' | 'candidate', id: string) {
  if (kind === 'case') return deleteCase(cwd, id);
  if (kind !== 'draft' && kind !== 'candidate') throw new Error('无效的条目类型');
  const dir = kind === 'draft' ? draftsDir(cwd) : inbox(cwd);
  withWriteLock(dir, () => unlinkSync(filename(dir, id)));
}

export function getDraft(cwd: string, id: string) {
  return caseSchema.parse(read(filename(draftsDir(cwd), id)));
}

export function candidateEvidence(cwd: string, id: string) {
  const item = getCandidate(cwd, id);
  const run = loadRun(cwd, item.source.turn);
  let followUp = '';
  for (const nextId of listRunIds(cwd).filter(t => t > run.id)) {
    const next = loadRun(cwd, nextId);
    if (next.kind === 'comparison' && !next.retryOf && next.sessionId === run.sessionId && next.parentTurnId === run.id) {
      followUp = next.question;
      break;
    }
  }
  return { question: run.question, answer: sourceAnswer(run, item.source.call), followUp };
}
