import test from 'node:test';
import assert from 'node:assert/strict';
import { fanOut, runOne } from '../dist/core/orchestrator.js';
import { aborted, deferred, options, target, workspace } from './helpers.mjs';

test('only an explicit success plus clean transport completion succeeds', async (t) => {
  const cwd = workspace(t);
  const cases = [
    ['success', async function* () { yield { type: 'delta', text: 'part' }; yield { type: 'done', text: 'final' }; }, 'succeeded', 'final'],
    ['truncated', async function* () { yield { type: 'delta', text: 'part' }; }, 'failed', 'part'],
    ['empty', async function* () {}, 'failed', ''],
    ['late failure', async function* () { yield { type: 'done', text: 'part' }; throw new Error('exit 2'); }, 'failed', 'part'],
    ['duplicate terminal', async function* () { yield { type: 'done', text: 'part' }; yield { type: 'done', text: 'again' }; }, 'failed', 'part'],
    ['upstream failure', async function* () { yield { type: 'delta', text: 'part' }; yield { type: 'error', message: 'upstream' }; }, 'failed', 'part'],
  ];
  for (const [name, generator, expected, text] of cases) await t.test(name, async () => {
    const events = [];
    const result = await runOne(target('a', generator), options(cwd, { onEvent: (_id, e) => events.push(e) }));
    assert.equal(result.status, expected);
    assert.equal(result.ok, expected === 'succeeded');
    assert.equal(result.text, text);
    const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].type, result.ok ? 'done' : 'error');
  });
});

test('observer failures are separate from model outcomes', async (t) => {
  const result = await runOne(target('a', async function* () {
    yield { type: 'delta', text: 'ok' }; yield { type: 'done', text: 'ok' };
  }), options(workspace(t), { onEvent: () => { throw new Error('display unavailable'); } }));
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 2);
});

test('cancellation, timeout and non-cooperating generators have bounded completion', async (t) => {
  const cwd = workspace(t);
  const ctl = new AbortController();
  ctl.abort();
  let started = 0;
  const a = target('a', async function* (req) { started++; await aborted(req.signal); });
  assert.equal((await runOne(a, options(cwd, { signal: ctl.signal }))).status, 'cancelled');
  assert.equal(started, 0);
  assert.equal((await runOne(a, options(cwd, { timeoutMs: 20 }))).status, 'timed_out');
  const stuck = target('stuck', async function* () { await new Promise(() => {}); });
  const before = Date.now();
  assert.equal((await runOne(stuck, options(cwd, { timeoutMs: 20, cleanupMs: 20 }))).status, 'timed_out');
  assert.ok(Date.now() - before < 1500);
});

test('bounded workers preserve order and isolate failures', async (t) => {
  let active = 0;
  let peak = 0;
  const gate = deferred();
  const twoStarted = deferred();
  const targets = ['a', 'b', 'c', 'd'].map((id) => target(id, async function* () {
    active++;
    peak = Math.max(active, peak);
    if (active === 2) twoStarted.resolve();
    await gate.promise;
    active--;
    if (id === 'c') throw new Error('c failed');
    yield { type: 'done', text: id };
  }));
  const work = fanOut(targets, { ...options(workspace(t)), concurrency: 2 });
  await twoStarted.promise;
  assert.equal(peak, 2);
  gate.resolve();
  const results = await work;
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => r.targetId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(results.map((r) => r.ok), [true, true, false, true]);
  assert.equal(new Set(results.map((r) => r.runId)).size, 4);
});

test('queued cancellation does not start the queued provider', async (t) => {
  const ctl = new AbortController();
  const started = deferred();
  let queued = false;
  const work = fanOut([
    target('a', async function* (req) { started.resolve(); await aborted(req.signal); }),
    target('b', async function* () { queued = true; yield { type: 'done', text: 'b' }; }),
  ], { ...options(workspace(t), { signal: ctl.signal }), concurrency: 1 });
  await started.promise;
  ctl.abort();
  assert.deepEqual((await work).map((r) => r.status), ['cancelled', 'cancelled']);
  assert.equal(queued, false);
});
