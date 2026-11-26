import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessPool } from '../dist/core/harness-pool.js';
import { runOne } from '../dist/core/orchestrator.js';
import { startComparison } from '../dist/core/workflow.js';
import { createCodexAdapter } from '../dist/providers/codex.js';
import { createClaudeAdapter } from '../dist/providers/claude.js';
import { createAntigravityAdapter } from '../dist/providers/antigravity.js';
import { workspace, target } from './helpers.mjs';

function fixture(t, provider, factory) {
  const cwd = workspace(t);
  const harnesses = new HarnessPool();
  t.after(() => harnesses.dispose());
  const binary = { cmd: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/warm-harness.mjs', import.meta.url)), provider], nativeExecutable: true };
  const adapter = factory(binary);
  let detects = 0;
  adapter.detect = async () => { detects++; return { installed: true }; };
  const target = { id: adapter.id, label: adapter.id, adapter };
  const read = () => readFileSync(join(cwd, 'harness.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const ask = (question, previous) => startComparison({ cwd, home: cwd, harnesses, targets: [target], question, previous,
    config: { providers: [target.id], routing: 'single', advisor: 'off', timeoutSec: 4 }, interactive: true }).done;
  return { cwd, target, harnesses, ask, read, detects: () => detects };
}

for (const [provider, factory] of [['codex', createCodexAdapter], ['claude', createClaudeAdapter], ['gemini', createAntigravityAdapter]]) {
  test(provider + ' uses one process and one availability probe for three user turns', async t => {
    const f = fixture(t, provider, factory);
    let last;
    const elapsed = [];
    for (const question of ['FIRST', 'SECOND', 'THIRD']) {
      last = await f.ask(question, last);
      assert.equal(last.results[0].ok, true, question + ': ' + last.results[0].error);
      elapsed.push(last.results[0].durationMs);
    }
    t.diagnostic('Local fixture, milliseconds per turn: ' + elapsed.join(', '));
    const events = f.read(), starts = events.filter(e => e.started);
    assert.equal(starts.length, 1);
    assert.equal(f.detects(), 1);
    assert.equal(events.filter(e => e.method === 'initialize').length, provider === 'claude' ? 0 : 1);
    const prompts = events.filter(e => e.prompt);
    assert.equal(prompts.length, 3);
    assert.match(prompts[2].prompt, /THIRD/);
    assert.doesNotMatch(prompts[2].prompt, /FIRST|SECOND/);
    assert.equal(new Set(prompts.map(e => e.sessionId)).size, 1);
    if (provider === 'claude') {
      const first = await f.ask('NEW-ROOT');
      await f.ask('BRANCH-A', first);
      const second = await f.ask('BRANCH-B', first);
      assert.equal(second.results[0].ok, true);
      const fork = f.read().filter(e => e.started).at(-1);
      assert.ok(fork.args.includes('--fork-session'));
      assert.equal(fork.args[fork.args.indexOf('--resume-session-at') + 1], 'msg-1');
    }
    await f.harnesses.dispose();
    for (const { pid } of f.read().filter(e => e.started)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('parallel Codex turns own separate workers, cancellation and crashes cannot replay a submitted prompt', async t => {
  const f = fixture(t, 'codex', createCodexAdapter);
  const options = { cwd: f.cwd, mode: 'ask', harnesses: f.harnesses, sessionId: 'one', timeoutMs: 4000 };
  const call = (prompt, signal) => runOne(f.target, { ...options, prompt, signal });
  const initial = await call('INITIAL');
  assert.equal(initial.ok, true, initial.error);
  const ctl = new AbortController();
  const pending = call('HANG', ctl.signal);
  const deadline = Date.now() + 3000;
  while (!f.read().some(e => e.prompt === 'HANG') && Date.now() < deadline) await delay(5);
  assert.ok(f.read().some(e => e.prompt === 'HANG'));
  const peer = await call('PARALLEL');
  assert.equal(peer.ok, true, peer.error);
  ctl.abort(); assert.equal((await pending).status, 'cancelled');
  assert.equal((await call('AFTER')).ok, true);
  const log = f.read();
  assert.notEqual(log.find(e => e.prompt === 'HANG').pid, log.find(e => e.prompt === 'PARALLEL').pid);
  assert.equal(log.find(e => e.prompt === 'AFTER').pid, log.find(e => e.prompt === 'PARALLEL').pid);
  assert.equal((await call('CRASH')).ok, false);
  assert.equal((await call('RECOVER')).ok, true);
  assert.equal(f.read().filter(e => e.prompt === 'CRASH').length, 1);
});

test('a Codex revision reuses its process with a fresh thread and the next answer sees the correction', async t => {
  const f = fixture(t, 'codex', createCodexAdapter);
  const reviewer = target('reviewer', async function* () {
    yield { type: 'done', text: JSON.stringify({ verdict: 'disputed', finding: '没有重试', quotes: ['retries=0'] }) };
  });
  const ask = (question, previous) => startComparison({ cwd: f.cwd, home: f.cwd, harnesses: f.harnesses,
    targets: [f.target, reviewer], interactive: true, question, previous,
    config: { routing: 'auto', providers: ['codex'], advisor: 'reviewer', timeoutSec: 4 } }).done;
  const first = await ask('PROVE 核对重试次数。日志：retries=0');
  assert.equal(first.advisor.status, 'revised');
  const next = await ask('CONTINUE', first);
  assert.equal(next.results[0].ok, true, next.results[0].error);
  const log = f.read(), prompts = log.filter(e => e.prompt);
  assert.equal(log.filter(e => e.started).length, 1);
  assert.equal(prompts.length, 3);
  assert.equal(new Set(prompts.map(e => e.sessionId)).size, 3);
  assert.match(prompts[2].prompt, /更正：这次没有重试/);
});

test('repeated ultra turns reuse the CLI model catalog', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'codex', createCodexAdapter);
  const script = new URL('./fixtures/warm-harness.mjs', import.meta.url).href;
  writeFileSync(join(f.cwd, 'codex'), '#!/usr/bin/env node\nimport(' + JSON.stringify(script) + ');\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = f.cwd + delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  let previous;
  for (const question of ['FIRST', 'SECOND']) {
    previous = await startComparison({ cwd: f.cwd, home: f.cwd, harnesses: f.harnesses, question, previous,
      config: { answerModel: 'codex', answerEffort: 'ultra', advisor: 'off', timeoutSec: 4 }, targets: [f.target] }).done;
    assert.equal(previous.results[0].ok, true, previous.results[0].error);
    assert.equal(previous.results[0].reasoningEffort, 'ultra');
  }
  assert.equal(f.read().filter(e => e.method === 'model/list').length, 1);
  assert.equal(f.read().filter(e => e.provider === 'codex' && e.started).length, 1);
});
