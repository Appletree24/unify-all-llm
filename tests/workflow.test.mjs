import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startComparison, startExecution, selectPlan, chooseExecutor } from '../dist/core/workflow.js';
import { listRunIds, loadRun, newRunId } from '../dist/core/store.js';
import { parseConfig } from '../dist/core/config.js';
import { buildRegistry } from '../dist/providers/index.js';
import { aborted, deferred, target, workspace } from './helpers.mjs';

test('unique records, full public history, decision and synthesis input snapshots', async (t) => {
  const cwd = workspace(t);
  const requests = [];
  const answer = (id) => target(id, async function* (req) { requests.push([id, req.prompt]); yield { type: 'done', text: `${id}-answer` }; });
  const decider = target('router', async function* (req) {
    requests.push(['router', req.prompt]); yield { type: 'done', text: '{"providers":["a","b"],"synthesize":true}' };
  });
  const targets = [answer('a'), answer('b'), decider];
  const config = { providers: ['a', 'b'], decider: 'router', synthesizer: 'a' };
  let previous;
  for (const question of ['FIRST', 'SECOND', 'THIRD']) {
    previous = await startComparison({ cwd, question, config, targets, previous }).done;
    assert.equal(previous.status, 'completed');
    assert.equal(loadRun(cwd, previous.id).results.length, 2);
  }
  assert.equal(listRunIds(cwd).length, 3);
  assert.equal(previous.input.history.length, 2);
  for (const call of previous.calls) {
    assert.match(call.input.prompt, /FIRST/);
    assert.match(call.input.prompt, /SECOND/);
    assert.match(call.input.prompt, /THIRD/);
  }
  assert.deepEqual(previous.results.map((r) => r.text), ['a-answer', 'b-answer']);
  assert.equal(new Set(Array.from({ length: 1000 }, newRunId)).size, 1000);
});

test('cancelled comparisons persist successful and partial answers and bind execution to that turn', async (t) => {
  const cwd = workspace(t);
  const started = deferred();
  const aDone = deferred();
  const a = target('a', async function* () { yield { type: 'done', text: 'NEW_PLAN' }; aDone.resolve(); });
  const b = target('b', async function* (req) { yield { type: 'delta', text: 'unfinished' }; started.resolve(); await aborted(req.signal); });
  const handle = startComparison({ cwd, question: 'NEW_QUESTION', config: {}, targets: [a, b] });
  await Promise.all([started.promise, aDone.promise]);
  await new Promise(setImmediate);
  handle.cancel();
  const run = await handle.done;
  const stored = loadRun(cwd, run.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.results[0].status, 'succeeded');
  assert.equal(stored.results[1].status, 'cancelled');
  assert.equal(stored.results[1].text, 'unfinished');
  const plan = selectPlan(stored, 'a');
  assert.equal(plan.question, 'NEW_QUESTION');
  assert.equal(plan.text, 'NEW_PLAN');
  let execInput;
  const executor = target('worker', async function* (req) { execInput = req; yield { type: 'done', text: 'implemented' }; }, { askPolicy: 'sandbox-read-only', exec: true });
  const execution = await startExecution({ cwd, config: {}, targets: [executor], source: stored, from: 'a', executor }).done;
  assert.equal(execution.planSource.turnId, stored.id);
  assert.equal(execution.planSource.runId, stored.results[0].runId);
  assert.match(execInput.prompt, /NEW_QUESTION/);
  assert.match(execInput.prompt, /NEW_PLAN/);
  assert.equal(loadRun(cwd, execution.id).kind, 'execution');
});

test('single-target cancellation and retry preserve the original input and records', async (t) => {
  const cwd = workspace(t);
  const bStarted = deferred();
  let attempt = 0;
  let aRuns = 0;
  const a = target('a', async function* () { aRuns++; yield { type: 'done', text: 'a' }; });
  const b = target('b', async function* (req) {
    if (++attempt === 1) { bStarted.resolve(); await aborted(req.signal); }
    else yield { type: 'done', text: 'retried' };
  });
  const handle = startComparison({ cwd, question: 'Q', config: {}, targets: [a, b] });
  await bStarted.promise;
  assert.equal(handle.cancelTarget('b'), true);
  const run = await handle.done;
  assert.equal(run.status, 'partial');
  const retry = await startComparison({ cwd, config: {}, targets: [a, b], question: 'ignored', retry: { record: run, targetIds: ['b'] } }).done;
  assert.equal(aRuns, 1);
  assert.equal(retry.results[0].text, 'retried');
  assert.equal(retry.input.prompt, run.input.prompt);
  assert.equal(retry.retryOf, run.id);
  assert.equal(loadRun(cwd, run.id).results[1].status, 'cancelled');
});

test('decision cancellation is saved and never starts answering', async (t) => {
  const cwd = workspace(t);
  const ready = deferred();
  let answered = false;
  const answer = async function* () { answered = true; yield { type: 'done', text: 'a' }; };
  const router = target('router', async function* (req) { ready.resolve(); await aborted(req.signal); });
  const h = startComparison({ cwd, question: 'Q', config: { providers: ['a', 'b'], decider: 'router' }, targets: [target('a', answer), target('b', answer), router] });
  await ready.promise;
  h.cancel();
  const record = await h.done;
  assert.equal(record.status, 'cancelled');
  assert.equal(loadRun(cwd, record.id).calls[0].result.status, 'cancelled');
  assert.equal(answered, false);
});

test('invalid decisions fall back; display failures do not affect outcomes', async (t) => {
  const cwd = workspace(t);
  const answer = async function* () { yield { type: 'done', text: 'answer' }; };
  const run = await startComparison({
    cwd, question: 'Q', config: { providers: ['a', 'b'], decider: 'router' },
    targets: [target('a', answer), target('b', answer), target('router', async function* () { throw new Error('down'); })],
    onEvent: () => { throw new Error('broken renderer'); },
  }).done;
  assert.equal(run.status, 'completed');
  assert.equal(run.results.length, 2);
  assert.ok(run.observerErrors.length > 0);
});

test('orphaned records expose interruption without rewriting history', async (t) => {
  const cwd = workspace(t);
  const run = await startComparison({ cwd, config: {}, question: 'Q', targets: [target('a', async function* () { yield { type: 'done', text: 'answer' }; })] }).done;
  const path = join(cwd, '.unify', 'runs', run.id, 'run.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.status = 'answering'; raw.owner = undefined;
  raw.results[0].status = 'running'; raw.results[0].ok = false;
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(loadRun(cwd, run.id).results[0].status, 'interrupted');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'answering');
});

test('config validates references, duplicates, capabilities and independent model targets', () => {
  for (const config of [{ timeoutSec: Infinity }, { concurrency: 0 }, { disableClaude: 'true' }, { providers: ['a', 'a'] }, { typo: 1 }]) assert.throws(() => parseConfig(config));
  assert.throws(() => buildRegistry({ providers: ['missing'] }));
  assert.throws(() => buildRegistry({ custom: { api: { type: 'openai', baseUrl: 'https://example.com/v1', model: 'x' } }, executor: 'api' }));
  const reg = buildRegistry({ disableClaude: true, targets: { fast: { provider: 'codex', model: 'm1' }, deep: { provider: 'codex', model: 'm2' } } });
  assert.equal(reg.fast.adapter, reg.deep.adapter);
  assert.equal(reg.fast.model, 'm1');
  assert.equal(reg.deep.model, 'm2');
  assert.throws(() => chooseExecutor(Object.values(reg), 'missing', new Map()));
});

test('storage failure stops queued work and prevents synthesis', async (t) => {
  const cwd = workspace(t);
  let laterStarted = false, broken = false;
  const h = startComparison({
    cwd, question: 'Q', config: { concurrency: 1 },
    targets: [
      target('a', async function* () { yield { type: 'delta', text: 'partial' }; yield { type: 'done', text: 'a' }; }),
      target('b', async function* () { laterStarted = true; yield { type: 'done', text: 'b' }; }),
    ],
    onEvent(event) {
      if (event.type === 'provider' && event.event.type === 'delta' && !broken) {
        broken = true;
        const path = join(cwd, '.unify', 'runs', event.turnId, 'run.json');
        rmSync(path);
        mkdirSync(path);
      }
    },
  });
  await assert.rejects(h.done);
  assert.equal(laterStarted, false);
  assert.equal(h.record.status, 'failed');
  assert.equal(h.record.synthesis, undefined);
});

test('synthesis cancellation retains anonymous mapping, partial output, and completed answers', async (t) => {
  const cwd = workspace(t), ready = deferred();
  const a = target('a', async function* (req) {
    if (req.prompt.startsWith('你是一名严谨')) {
      yield { type: 'delta', text: 'partial synthesis' };
      ready.resolve(); await aborted(req.signal);
    } else yield { type: 'done', text: 'a' };
  });
  const b = target('b', async function* () { yield { type: 'done', text: 'b' }; });
  const h = startComparison({ cwd, question: 'Q', config: { synthesizer: 'a' }, targets: [a, b] });
  await ready.promise;
  const live = loadRun(cwd, h.record.id);
  assert.equal(live.status, 'synthesizing');
  assert.deepEqual(Object.values(live.synthesis.labels).sort(), ['a', 'b']);
  h.cancel();
  const run = await h.done;
  assert.equal(run.synthesis.result.status, 'cancelled');
  assert.equal(run.synthesis.result.text, 'partial synthesis');
  assert.ok(run.results.every((r) => r.ok));
});

test('availability detection receives cancellation before any model invocation', async (t) => {
  const ready = deferred();
  const a = target('a', async function* () { assert.fail('model must not start'); });
  a.adapter.detect = async (signal) => { ready.resolve(); await aborted(signal); return { installed: false }; };
  const h = startComparison({ cwd: workspace(t), config: {}, question: 'Q', targets: [a] });
  await ready.promise; h.cancel();
  assert.equal((await h.done).status, 'cancelled');
});

test('legacy records remain readable and executable without rewriting the original', (t) => {
  const cwd = workspace(t), id = '20261117-110000';
  const dir = join(cwd, '.unify', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const contents = JSON.stringify({ id, createdAt: '2026-11-17T11:00:00Z', question: 'old question', results: [
    { provider: 'codex', ok: true, text: 'old plan', reasoning: '', durationMs: 1 },
  ] });
  writeFileSync(join(dir, 'run.json'), contents);
  assert.equal(selectPlan(loadRun(cwd, id)).text, 'old plan');
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), contents);
});

test('custom target configuration survives persistence and supports an unchanged retry', async (t) => {
  const cwd = workspace(t);
  const config = { custom: { local: { type: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fake', system: 'system' } }, providers: ['local'] };
  const targets = [buildRegistry(config).local];
  targets[0].adapter.run = async function* () { yield { type: 'done', text: 'fixture' }; };
  const run = await startComparison({ cwd, config, targets, question: 'Q' }).done;
  const stored = loadRun(cwd, run.id);
  assert.equal(stored.calls[0].target.configuration.system, 'system');
  const retry = await startComparison({ cwd, config, targets, question: '', retry: { record: stored, targetIds: ['local'] } }).done;
  assert.equal(retry.status, 'completed');
});
