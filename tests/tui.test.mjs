import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../dist/tui/app.js';
import { listRunIds, loadRun } from '../dist/core/store.js';
import { QUOTA_REFRESH_MS } from '../dist/quota/index.js';
import { aborted, deferred, target, workspace } from './helpers.mjs';

const homeEnv = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

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
  submit(app, '/memory web');
  while (!/记忆管理界面/.test(app.snapshot().join('\n'))) { await new Promise((r) => setTimeout(r, 10)); app.invalidate(); }
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(app.snapshot().join('\n'))[0];
  assert.match(await (await fetch(url)).text(), /Unify 记忆/);
  let quit = false;
  app.onQuit = () => { quit = true; };
  submit(app, '/exit');
  assert.equal(quit, true);
});

const type = (app, text) => app.handleKey({ name: 'char', text });
const screen = (app) => { app.invalidate(); return app.snapshot().join('\n'); };

function quotaClock(t) {
  const timers = new Map();
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    timers.set(fn, ms);
    return fn;
  });
  t.mock.method(globalThis, 'clearInterval', (fn) => timers.delete(fn));
  return () => {
    for (const [fn, ms] of timers) if (ms === QUOTA_REFRESH_MS) fn();
  };
}

test('welcome rows and answer panes show each model’s quota and update without opening /quota', async (t) => {
  const poll = quotaClock(t);
  let percentage = 74, balance = 0;
  const a = target('alpha', async function* () { yield { type: 'done', text: 'answer one' }; });
  const b = target('beta', async function* () { yield { type: 'done', text: 'answer two' }; });
  const unavailable = target('unavailable', async function* () { assert.fail('Unavailable model was called'); });
  unavailable.adapter.detect = async () => ({ installed: false });
  a.adapter.readQuota = async () => ({ status: 'ok', limits: [
    { label: '5 小时', remaining: percentage, unit: '%', resetsAt: '2027-01-01T00:00:00Z' },
  ] });
  b.adapter.readQuota = async () => ({ status: 'ok', limits: [{ label: '账户余额', remaining: balance, unit: 'CNY' }] });
  let cols = 140;
  const app = new App({ cols: () => cols, rows: () => 36, write() {} }, workspace(t), { providers: ['alpha', 'beta'] }, [a, b, unavailable]);
  t.after(() => app.dispose());
  await app.init();
  await new Promise(setImmediate);
  const welcome = screen(app);
  assert.match(welcome, /ALPHA[^\n]*74%/);
  assert.match(welcome, /BETA[^\n]*0 CNY/);
  assert.doesNotMatch(welcome, /UNAVAILABLE|未安装|缺少密钥/);
  submit(app, 'compare');
  await app.waitForIdle();
  await new Promise(setImmediate);
  const answers = screen(app);
  assert.match(answers, /ALPHA[^\n]*BETA/);
  assert.match(answers, /answer one[^\n]*answer two/);
  assert.match(answers, /74%[^\n]*重置[^\n]*(?:╮╭|││|╯╰)[^\n]*0 CNY/);
  percentage = 57;
  balance = 2.5;
  poll();
  await new Promise(setImmediate);
  assert.match(screen(app), /57%[^\n]*(?:╮╭|││|╯╰)[^\n]*2\.5 CNY/);
  cols = 44;
  app.handleKey({ name: 'tab' });
  app.handleKey({ name: 'tab' });
  app.handleKey({ name: 'enter' }); // zoom the second answer
  const zoomed = screen(app);
  assert.match(zoomed, /answer two/);
  assert.match(zoomed, /2\.5 CNY/);
  assert.doesNotMatch(zoomed, /57%/);
});

test('TUI quota view shares live readings with the main screen and cancels an unfinished refresh on exit', async (t) => {
  const poll = quotaClock(t);
  let reads = 0, lastSignal;
  const connected = target('connected', async function* () { assert.fail('quota must not run inference'); });
  connected.adapter.readQuota = async ({ signal }) => {
    lastSignal = signal;
    reads++;
    if (reads === 3) await aborted(signal);
    return { status: 'ok', limits: [{ label: '5 小时', unit: '%', remaining: 50 - reads }] };
  };
  const targets = [connected, { ...connected, id: 'other', model: 'large', label: '模型二' },
    target('offline', async function* () { assert.fail('quota must not run inference'); })];
  const app = new App({ cols: () => 90, rows: () => 18, write() {} }, workspace(t), { providers: ['connected'] }, targets);
  t.after(() => app.dispose());
  await app.init();
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  submit(app, '/quota');
  await new Promise(setImmediate);
  const view = screen(app);
  assert.match(view, /套餐余量/);
  assert.match(view, /模型二 \(other\).*connected \/ large/);
  assert.match(view, /49%/);
  assert.match(view, /OFFLINE[\s\S]*不可用/);
  poll();
  await new Promise(setImmediate);
  assert.match(screen(app), /48%/);
  type(app, 'r');
  poll();
  type(app, 'r');
  assert.equal(reads, 3);
  app.handleKey({ name: 'esc' });
  assert.equal(lastSignal.aborted, false);
  assert.match(screen(app), /✦ unify/);
  await app.dispose();
  assert.equal(lastSignal.aborted, true);
  await new Promise(setImmediate);
  poll();
  assert.equal(reads, 3);
});

/** The composer's text: what sits between the last two horizontal rules. */
const composer = (app) => {
  app.invalidate();
  const lines = app.snapshot();
  const rules = lines.flatMap((l, i) => (/^─+$/.test(l) ? [i] : []));
  return lines.slice(rules.at(-2) + 1, rules.at(-1)).join('\n');
};

test('key parser understands kitty, modifyOtherKeys and word-motion chords', async () => {
  const { KeyParser } = await import('../dist/tui/keys.js');
  const names = (s) => new KeyParser().feed(s).map((k) => k.name);
  assert.deepEqual(names('\x1b[13;2u\x1b[27;2;13~\x1b[13u'), ['altenter', 'altenter', 'enter']);
  assert.deepEqual(names('\x1b[27u\x1b[99;5u\x1b[9;2u\x1b[127;3u'), ['esc', 'ctrl+c', 'shifttab', 'wordback']);
  assert.deepEqual(names('\x1b[1;5D\x1b[1;3C\x1bb\x1bf\x1b\x7f\x1b[3;5~\x1b[D'), ['wordleft', 'wordright', 'wordleft', 'wordright', 'wordback', 'worddel', 'left']);
  assert.deepEqual(new KeyParser().feed('\x1b[200~a\x1b[13;2ub\x1b[201~'), [{ name: 'paste', text: 'a\x1b[13;2ub' }]);
});

test('editor follows readline conventions across lines and words', async () => {
  const { Editor } = await import('../dist/tui/editor.js');
  const ed = new Editor();
  ed.insert('first line\nsecond 行 x');
  ed.deleteWordBack();
  assert.equal(ed.text, 'first line\nsecond 行 ');
  ed.home(); ed.killToEnd();
  assert.equal(ed.text, 'first line\n');
  assert.equal(ed.vertical(1), false);
  assert.equal(ed.vertical(-1), true);
  assert.equal(ed.caret, 0);
  ed.wordRight(); ed.wordRight(); ed.killToStart();
  assert.equal(ed.text, '\n');
  ed.killToEnd();
  assert.equal(ed.text, '');
});

test('TUI completes commands, targets and files from the composer', async (t) => {
  const cwd = workspace(t);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(`${cwd}/src`);
  writeFileSync(`${cwd}/src/orchestrator.ts`, '');
  writeFileSync(`${cwd}/notes.md`, '');
  const prompts = [];
  const mk = (id) => target(id, async function* (req) { prompts.push(req.prompt); yield { type: 'done', text: id }; });
  const app = new App({ cols: () => 100, rows: () => 30, write() {} }, cwd, { providers: ['alpha'] }, [mk('alpha'), mk('beta')]);
  t.after(() => app.dispose());
  await app.init();

  let quit = false;
  app.onQuit = () => { quit = true; };
  type(app, '/exit');
  assert.match(screen(app), /› \/exit/);
  app.handleKey({ name: 'enter' });
  assert.equal(quit, true);

  type(app, '/');
  assert.match(screen(app), /› \/models/);
  assert.match(screen(app), /\/synth/);
  type(app, 'sy');
  assert.doesNotMatch(screen(app), /\/models/);
  app.handleKey({ name: 'enter' }); // /synth needs its argument: completes, does not run
  assert.equal(composer(app), '❯ /synth');
  assert.match(screen(app), /› alpha/);
  app.handleKey({ name: 'down' });
  app.handleKey({ name: 'enter' });
  app.handleKey({ name: 'enter' });
  assert.match(screen(app), /汇总模型: beta/);

  type(app, '/mod');
  app.handleKey({ name: 'tab' });
  type(app, 'alpha,b');
  app.handleKey({ name: 'tab' });
  app.handleKey({ name: 'enter' });
  assert.match(screen(app), /之后的问题将发给: alpha, beta/);

  type(app, '看看 @orch');
  assert.match(screen(app), /› src\/orchestrator\.ts/);
  app.handleKey({ name: 'esc' });
  assert.doesNotMatch(screen(app), /› src\/orchestrator\.ts/);
  app.handleKey({ name: 'backspace' });
  app.handleKey({ name: 'tab' });
  type(app, '的并发');
  app.handleKey({ name: 'enter' });
  await app.waitForIdle();
  assert.ok(prompts.some((p) => p.endsWith('看看 @src/orchestrator.ts 的并发')));

  app.handleKey({ name: 'up' }); // history, without reopening a popup that would trap the arrows
  assert.equal(composer(app), '❯ 看看 @src/orchestrator.ts 的并发');
  app.handleKey({ name: 'up' });
  assert.equal(composer(app), '❯ /models alpha,beta');
  app.handleKey({ name: 'down' });
  app.handleKey({ name: 'down' });
  assert.match(composer(app), /^❯ 继续追问/);
});

test('settings test the selected target on demand and show the actual chat outcome', async (t) => {
  const cwd = workspace(t);
  const release = deferred();
  const requests = [];
  const alias = { ...target('pro', async function* (req) {
    requests.push(req);
    if (requests.length === 1) {
      await release.promise;
      yield { type: 'delta', text: 'partial' };
      yield { type: 'error', message: 'account not eligible in this region' };
    } else {
      yield { type: 'done', text: 'OK' };
    }
  }), model: 'configured-model', reasoningEffort: 'high' };
  const other = target('other', async function* () { assert.fail('wrong target'); });
  const app = new App({ cols: () => 92, rows: () => 24, write() {} }, cwd, { providers: ['other'] }, [other, alias]);
  t.after(() => app.dispose());
  await app.init();
  const press = name => app.handleKey({ name });
  submit(app, '/settings');
  for (const key of ['down', 'enter', 'down', 'enter', 'down', 'down']) press(key);
  assert.match(screen(app), /› 测试可用性/);
  assert.equal(requests.length, 0);
  app.handleKey({ name: 'click', x: 5, y: 4 });
  press('enter');
  assert.match(screen(app), /测试中/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, 'ask');
  assert.equal(requests[0].model, 'configured-model');
  assert.equal(requests[0].reasoningEffort, 'high');
  release.resolve();
  await new Promise(setImmediate);
  assert.match(screen(app), /测试失败[\s\S]*account not eligible/);
  press('enter');
  await new Promise(setImmediate);
  assert.match(screen(app), /测试通过/);
  assert.equal(requests.length, 2);
  assert.deepEqual(listRunIds(cwd), []);
});

test('official API setup masks credentials, selects DeepSeek immediately, and survives restart', async (t) => {
  const { existsSync, statSync } = await import('node:fs');
  const { buildRegistry } = await import('../dist/providers/index.js');
  const cwd = workspace(t);
  const home = workspace(t);
  const saved = { [homeEnv]: process.env[homeEnv], DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  process.env[homeEnv] = home;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const calls = [];
  const key = 'sk-fixture-only';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/user/balance')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '2.50' }] });
    }
    calls.push({ url, auth: options.headers.authorization, body: JSON.parse(options.body) });
    return new Response('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const cfg = { targets: { pro: { provider: 'deepseek', model: 'deepseek-v4-pro' } } };
  const { writeFileSync, readFileSync } = await import('node:fs');
  writeFileSync(cwd + '/unify.config.json', JSON.stringify(cfg));
  const registry = buildRegistry(cfg);
  let terminal = '';
  const app = new App({ cols: () => 90, rows: () => 24, write(s) { terminal += s; } }, cwd, cfg, [registry.deepseek, registry.pro]);
  t.after(() => app.dispose());
  await app.init();
  const press = name => app.handleKey({ name });

  submit(app, '/settings');
  app.handleKey({ name: 'enter' });
  assert.match(screen(app), /DeepSeek[\s\S]*OpenAI[\s\S]*Anthropic[\s\S]*Gemini API/);
  press('enter');
  assert.match(screen(app), /deepseek-flash/);
  press('enter');
  press('enter');
  assert.match(screen(app), /请输入 API Key/);
  type(app, key);
  assert.match(screen(app), /••••/);
  press('esc');
  press('esc');
  assert.equal(existsSync(home + '/.unify/api/deepseek.json'), false);

  submit(app, '/settings');
  app.handleKey({ name: 'enter' });
  press('enter');
  press('down');
  press('enter');
  submit(app, key);
  assert.match(screen(app), /已选用 DeepSeek · deepseek-v4-pro/);
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  if (process.platform !== 'win32') assert.equal(statSync(home + '/.unify/api/deepseek.json').mode & 0o777, 0o600);
  submit(app, '/settings');
  press('down');
  press('enter'); // model targets
  press('enter'); // deepseek
  press('enter'); // model picker
  assert.match(screen(app), /继承配置[\s\S]*deepseek-v4-pro[\s\S]*deepseek-flash/);
  app.handleKey({ name: 'paste', text: 'unlisted-model' });
  assert.doesNotMatch(screen(app), /unlisted-model/);
  for (const name of ['down', 'down', 'enter']) press(name);
  assert.equal(JSON.parse(readFileSync(cwd + '/unify.config.json')).models.deepseek, 'deepseek-flash');
  press('down');
  press('enter'); // effort levels
  assert.match(screen(app), /默认（由模型决定）[\s\S]*none[\s\S]*low[\s\S]*high[\s\S]*max/);
  for (const name of ['down', 'down', 'down', 'enter', 'esc', 'esc', 'esc']) press(name);
  const persisted = JSON.parse(readFileSync(cwd + '/unify.config.json'));
  assert.deepEqual(persisted.reasoningEffort, { deepseek: 'high' });
  assert.equal(buildRegistry(persisted).pro.reasoningEffort, undefined);
  submit(app, 'hello');
  await app.waitForIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].auth, 'Bearer ' + key);
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  assert.match(screen(app), /你好/);
  const record = loadRun(cwd, listRunIds(cwd)[0]);
  assert.equal(record.status, 'completed');
  press('up');
  press('up');
  assert.equal(composer(app), '❯ /settings');
  assert.ok(!JSON.stringify(record).includes(key) && !terminal.includes(key));
  assert.equal((await buildRegistry(cfg).pro.adapter.detect()).installed, true);
});

test('official API setup enables a separate OpenAI target using an environment key', async t => {
  const { buildRegistry } = await import('../dist/providers/index.js');
  const { readFileSync } = await import('node:fs');
  const home = workspace(t);
  const savedHome = process.env[homeEnv], savedKey = process.env.OPENAI_API_KEY;
  process.env[homeEnv] = home;
  process.env.OPENAI_API_KEY = 'env-key';
  t.after(() => {
    if (savedHome === undefined) delete process.env[homeEnv]; else process.env[homeEnv] = savedHome;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  });
  const app = new App({ cols: () => 90, rows: () => 24, write() {} }, workspace(t), {}, []);
  t.after(() => app.dispose());
  await app.init();
  submit(app, '/settings');
  app.handleKey({ name: 'enter' });
  for (const name of ['down', 'enter', 'enter', 'enter']) app.handleKey({ name });
  assert.match(screen(app), /已选用 OpenAI/);
  const config = JSON.parse(readFileSync(home + '/.unify/api/openai.json'));
  assert.deepEqual(config, { model: 'gpt-4.1-mini' });
  const registry = buildRegistry({});
  assert.equal(registry.openai.adapter.configuration.baseUrl, 'https://api.openai.com/v1');
  assert.equal(registry.openai.adapter.capabilities.exec, false);
  assert.equal(registry.codex.adapter.capabilities.exec, true);
  const custom = { type: 'openai', baseUrl: 'http://localhost/v1', model: 'custom' };
  assert.equal(buildRegistry({ custom: { openai: custom } }).openai.adapter.configuration.baseUrl, custom.baseUrl);
  assert.equal(buildRegistry({ targets: { openai: { provider: 'codex' } } }).openai.adapter.id, 'codex');
});

test('TUI queues follow-ups while busy, Esc interrupts, and Ctrl+C needs two presses to quit', async (t) => {
  const cwd = workspace(t);
  const gate = deferred(), started = deferred();
  const seen = [];
  const a = target('a', async function* (req) {
    const q = req.prompt.split('\n').pop();
    seen.push(q);
    if (q === 'ONE') { started.resolve(); await gate.promise; }
    if (q === 'HANG') { started2.resolve(); await aborted(req.signal); return; }
    yield { type: 'done', text: `re:${q}`, usage: { inputTokens: 1200, outputTokens: 34 } };
  });
  const started2 = deferred();
  const app = new App({ cols: () => 100, rows: () => 30, write() {} }, cwd, {}, [a]);
  t.after(() => app.dispose());
  await app.init();
  let quit = 0;
  app.onQuit = () => { quit++; };

  submit(app, 'ONE');
  await started.promise;
  submit(app, 'TWO');
  assert.match(screen(app), /已排队\s+TWO/);
  assert.match(screen(app), /Esc 中断 · 1 条排队/);
  gate.resolve();
  while (!seen.includes('TWO')) await new Promise(setImmediate);
  await app.waitForIdle();
  await new Promise(setImmediate);
  assert.match(screen(app), /re:TWO/);
  assert.match(screen(app), /↑2\.4k ↓68 · 第 2 轮/);

  submit(app, 'HANG');
  await started2.promise;
  submit(app, 'LATER');
  app.handleKey({ name: 'esc' });
  await app.waitForIdle();
  await new Promise(setImmediate);
  assert.deepEqual(seen, ['ONE', 'TWO', 'HANG']);
  assert.equal(composer(app), '❯ LATER');
  assert.match(screen(app), /排队的消息已放回输入框/);

  app.handleKey({ name: 'ctrl+c' }); // clears the composer
  app.handleKey({ name: 'ctrl+c' });
  assert.equal(quit, 0);
  assert.match(screen(app), /再按一次 Ctrl\+C 退出/);
  app.handleKey({ name: 'ctrl+c' });
  assert.equal(quit, 1);
});

test('TUI memory view browses layers, edits a memory in place and undoes it', async (t) => {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const base = workspace(t);
  const home = `${base}/home`, cwd = `${base}/proj`;
  mkdirSync(`${home}/.claude`, { recursive: true });
  mkdirSync(`${home}/.codex`, { recursive: true });
  mkdirSync(cwd);
  writeFileSync(`${home}/.claude/CLAUDE.md`, '# 偏好\n\n- 回答使用中文\n- 改动前先说明计划\n');
  writeFileSync(`${cwd}/CLAUDE.md`, '- 测试用 npm test\n');
  writeFileSync(`${home}/.codex/AGENTS.md`, '- 先读测试\n');
  const app = new App({ cols: () => 110, rows: () => 30, write() {} }, cwd, {}, [target('a', async function* () { yield { type: 'done', text: 'a' }; })],
    { cwd, home, env: {}, platform: 'linux' });
  t.after(() => app.dispose());
  await app.init();
  const press = (...names) => names.forEach((name) => app.handleKey(name.length === 1 ? { name: 'char', text: name } : { name }));
  submit(app, '/memory');
  let view = screen(app);
  assert.match(view, /1 Claude Code\s+2 Codex\s+3 Gemini CLI\s+4 Pi/);
  assert.match(view, /2 用户记忆\s+启动 · 人工/);
  assert.match(view, /› {3}● ~\/\.claude\/CLAUDE\.md\s+2 │/);
  assert.match(view, /偏好\n.*回答使用中文\n.*文件修改于/);

  press('enter', 'down', 'e');
  assert.match(screen(app), /编辑 ~\/\.claude\/CLAUDE\.md 第 4 行/);
  app.handleKey({ name: 'paste', text: '，并等我确认' });
  press('enter');
  assert.equal(readFileSync(`${home}/.claude/CLAUDE.md`, 'utf8'), '# 偏好\n\n- 回答使用中文\n- 改动前先说明计划，并等我确认\n');
  assert.match(screen(app), /已保存，按 u 撤销/);

  press('c');
  assert.match(screen(app), /复制到[\s\S]*Codex · 全局指令 · ~\/\.codex\/AGENTS\.md/);
  press('down', 'down', 'down', 'enter'); // project → local → auto memory index → Codex global
  assert.equal(readFileSync(`${home}/.codex/AGENTS.md`, 'utf8'), '- 先读测试\n\n## 偏好\n\n- 改动前先说明计划，并等我确认\n'); // the section travels with it

  press('u', 'y');
  assert.equal(readFileSync(`${home}/.codex/AGENTS.md`, 'utf8'), '- 先读测试\n');
  press('tab');
  assert.match(screen(app), /› {3}● ~\/\.codex\/AGENTS\.md\s+1 │/);
  press('x');
  assert.match(screen(app), /Codex 启动时的记忆上下文[\s\S]*<!-- 全局指令 · ~\/\.codex\/AGENTS\.md -->\n - 先读测试/);
  press('esc', 'q');
  assert.match(screen(app), /✦ unify/);
});
