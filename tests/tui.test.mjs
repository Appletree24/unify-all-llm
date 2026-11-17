import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../dist/tui/app.js';
import { listRunIds, loadRun } from '../dist/core/store.js';
import { aborted, deferred, target, workspace } from './helpers.mjs';

function submit(app, text) {
  app.handleKey({ name: 'paste', text });
  app.handleKey({ name: 'enter' });
}

test('TUI cancellation followed by focused execution uses the visible turn and persists it', async (t) => {
  const cwd = workspace(t);
  const aDone = deferred(), bStarted = deferred();
  let executionPrompt;
  const a = target('a', async function* (req) {
    const text = req.prompt.startsWith('你是一名严谨') ? 'SYNTHESIS'
      : req.prompt.endsWith('SECOND_QUESTION') ? 'SECOND_PLAN' : 'FIRST_PLAN';
    yield { type: 'done', text };
    if (text === 'SECOND_PLAN') aDone.resolve();
  });
  const b = target('b', async function* (req) {
    if (req.prompt.endsWith('SECOND_QUESTION')) {
      yield { type: 'delta', text: 'partial' };
      bStarted.resolve(); await aborted(req.signal);
    } else yield { type: 'done', text: 'OTHER_PLAN' };
  });
  const executor = target('worker', async function* (req) {
    executionPrompt = req.prompt;
    yield { type: 'done', text: 'EXECUTED' };
  }, { askPolicy: 'sandbox-read-only', exec: true });
  const app = new App({ cols: () => 140, rows: () => 40, write() {} }, cwd,
    { providers: ['a', 'b'], synthesizer: 'a', executor: 'worker' }, [a, b, executor]);
  t.after(() => app.dispose());
  await app.init();
  submit(app, 'FIRST_QUESTION');
  await app.waitForIdle();
  submit(app, 'SECOND_QUESTION');
  await Promise.all([aDone.promise, bStarted.promise]);
  await new Promise(setImmediate);
  app.handleKey({ name: 'ctrl+c' });
  await app.waitForIdle();
  app.invalidate();
  const screen = app.snapshot().join('\n');
  assert.match(screen, /SECOND_QUESTION/);
  assert.match(screen, /SECOND_PLAN/);
  assert.match(screen, /已取消/);
  app.handleKey({ name: 'tab' });
  app.handleKey({ name: 'ctrl+e' });
  app.handleKey({ name: 'char', text: 'y' });
  await app.waitForIdle();
  assert.match(executionPrompt, /现在请回答：\nSECOND_QUESTION/);
  assert.match(executionPrompt, /<final_plan>\nSECOND_PLAN\n<\/final_plan>/);
  const records = listRunIds(cwd).map((id) => loadRun(cwd, id));
  assert.equal(records.length, 3);
  const source = records.find((r) => r.kind === 'comparison' && r.question === 'SECOND_QUESTION');
  const execution = records.find((r) => r.kind === 'execution');
  assert.equal(execution.planSource.turnId, source.id);
  assert.equal(source.status, 'cancelled');
});

test('TUI rejects duplicate target selection and /exit remains available', async (t) => {
  const app = new App({ cols: () => 100, rows: () => 24, write() {} }, workspace(t), {},
    [target('a', async function* () { yield { type: 'done', text: 'a' }; })]);
  t.after(() => app.dispose());
  await app.init();
  submit(app, '/models a,a');
  app.invalidate();
  assert.match(app.snapshot().join('\n'), /不能重复选择/);
  let quit = false;
  app.onQuit = () => { quit = true; };
  submit(app, '/exit');
  assert.equal(quit, true);
});
