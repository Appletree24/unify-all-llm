import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { listRunIds, loadRun, type RunRecord } from '../core/store.js';

import { caseSchema, type BenchCase, type BenchKind } from './schema.js';
export { caseSchema, repoSchema, reviewSchema, taskSchema, type BenchCase, type BenchKind, type BenchTask, type Repository } from './schema.js';

const nonempty = z.string().min(1);
const sourceSchema = z.object({ turn: nonempty, call: z.string().optional() });
const candidateSchema = z.object({ version: z.literal(1), id: nonempty, source: sourceSchema, title: nonempty, note: z.string() });
export type Candidate = z.infer<typeof candidateSchema>;
export type BenchIndex = { candidates: Candidate[]; drafts: { id: string; title: string }[]; cases: { id: string; title: string; kind: BenchKind }[] };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const caseId = (c: BenchCase) => digest(JSON.stringify(caseSchema.parse(c))).slice(0, 24);
const inbox = (cwd: string) => join(cwd, '.unify', 'bench', 'inbox');
export const draftsDir = (cwd: string) => join(cwd, '.unify', 'bench', 'drafts');
const library = (cwd: string) => join(cwd, 'unify-bench');
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
function filename(dir: string, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('无效的评测 ID');
  return join(dir, id + '.json');
}
function ids(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^[a-f0-9]{24}\.json$/.test(f)).sort().map(f => f.slice(0, -5));
}

// Publish complete, immutable files; concurrent captures and publications are idempotent.
function insert(dir: string, id: string, data: unknown) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, randomUUID() + '.tmp');
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { linkSync(tmp, filename(dir, id)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  finally { unlinkSync(tmp); }
}
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
export function getCase(cwd: string, id: string) {
  const data = caseSchema.parse(read(filename(library(cwd), id)));
  if (caseId(data) !== id) throw new Error('题目内容已改变，请重新校验并发布新版本');
  return data;
}
export function publishedIds(cwd: string) {
  return ids(library(cwd));
}
export function listBench(cwd: string): BenchIndex {
  return { candidates: ids(inbox(cwd)).map(id => getCandidate(cwd, id)),
    drafts: ids(draftsDir(cwd)).map(id => {
      try { return { id, title: getDraft(cwd, id).task.title }; }
      catch { return { id, title: '草稿格式有误 · ' + id }; }
    }),
    cases: ids(library(cwd)).map(id => { const c = getCase(cwd, id); return { id, title: c.task.title, kind: c.review.grader.kind }; }) };
}
export function storeValidated(cwd: string, c: BenchCase) {
  const id = caseId(c);
  insert(library(cwd), id, caseSchema.parse(c));
  getCase(cwd, id);
  return id;
}

export function saveDraft(cwd: string, data: BenchCase) {
  const id = caseId(data);
  insert(draftsDir(cwd), id, caseSchema.parse(data));
  return id;
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
