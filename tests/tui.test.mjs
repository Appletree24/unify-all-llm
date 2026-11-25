import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '../dist/tui/app.js';
import { textWidth } from '../dist/tui/screen.js';
import { listRunIds, loadRun, loadRunRecap } from '../dist/core/store.js';
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

test('TUI removes overlapping setting commands, configures them via /settings, and keeps /exit available', async (t) => {
  const { buildRegistry } = await import('../dist/providers/index.js');
  const cwd = workspace(t);
  const home = workspace(t);
  const savedHome = process.env[homeEnv];
  const savedPath = Object.entries(process.env).filter(([k]) => k.toLowerCase() === 'path');
  process.env[homeEnv] = home;
  for (const [k] of savedPath) process.env[k] = '';
  t.after(() => {
    if (savedHome === undefined) delete process.env[homeEnv]; else process.env[homeEnv] = savedHome;
    for (const [k, v] of savedPath) process.env[k] = v;
  });

  const registry = buildRegistry({});
  const codex = { ...registry.codex, adapter: { ...registry.codex.adapter, detect: async () => ({ installed: true }) } };
  const deepseek = { ...registry.deepseek, adapter: { ...registry.deepseek.adapter, detect: async () => ({ installed: true }) } };
  const mouseEvents = [];
  const app = new App({
    cols: () => 100, rows: () => 24, write() {}, setMouse: (on) => mouseEvents.push(on),
  }, cwd, {}, [codex, deepseek]);
  t.after(() => app.dispose());
  await app.init();

  for (const removed of ['/models codex,deepseek', '/synth deepseek', '/mouse']) {
    submit(app, removed);
    assert.match(screen(app), /未知命令/);
  }

  const press = (...names) => names.forEach((name) => app.handleKey({ name }));
  submit(app, '/settings');
  press('down', 'down', 'down', 'down', 'down', 'enter'); // 鼠标滚动
  assert.deepEqual(mouseEvents, [false]);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'unify.config.json'), 'utf8')).mouse, false);

  press('up', 'up', 'up', 'enter', 'enter'); // 回答、汇总与执行 -> 默认回答目标
  submit(app, 'codex,codex');
  assert.match(screen(app), /目标不能重复/);
  press('ctrl+u');
  submit(app, 'codex,deepseek');
  assert.match(screen(app), /已保存/);

  press('down', 'enter', 'down', 'down', 'down', 'down', 'enter'); // 汇总模型 -> deepseek
  press('esc', 'esc');
  const persisted = JSON.parse(readFileSync(join(cwd, 'unify.config.json'), 'utf8'));
  assert.deepEqual(persisted.providers, ['codex', 'deepseek']);
  assert.equal(persisted.synthesizer, 'deepseek');
  assert.match(screen(app), /codex \+ deepseek → deepseek/);

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

function clickText(app, label, offset = 0) {
  const rows = screen(app).split('\n');
  const y = rows.findIndex(row => row.includes(label));
  assert.ok(y >= 0, `Missing text ${label}`);
  const x = textWidth(rows[y].slice(0, rows[y].indexOf(label))) + offset;
  app.handleKey({ name: 'mousedown', x, y });
  app.handleKey({ name: 'mouseup', x, y });
}

test('TUI keeps Gemini Pro approvals inside its pane and preserves a follow-up draft', { timeout: 5000 }, async (t) => {
  let ready = deferred(), requestApproval = deferred();
  let cols = 100, rows = 22;
  const peerStreamed = deferred(), requestPeerApproval = deferred(), peerReady = deferred(), peerDecision = deferred();
  let firstPeerCall = true;
  const other = target('alpha', async function* (req) {
    yield { type: 'delta', text: 'ALPHA OUTPUT' };
    if (firstPeerCall) {
      firstPeerCall = false;
      peerStreamed.resolve();
      await Promise.race([requestPeerApproval.promise, aborted(req.signal)]);
      if (req.signal.aborted) return;
      const response = req.interact({ kind: 'approval', title: 'Alpha 请求权限确认', detail: 'read alpha.txt' });
      peerReady.resolve();
      peerDecision.resolve(await response);
    }
    yield { type: 'done', text: 'ALPHA OUTPUT' };
  }, { askPolicy: 'read-tools', exec: false });
  const gemini = target('gemini-pro', async function* (req) {
    yield { type: 'delta', text: 'GEMINI PROGRESS' };
    await requestApproval.promise;
    const response = req.interact({
      kind: 'approval', title: 'Gemini Pro 请求权限确认', tool: 'run_command', detail: 'node -p 1+1',
      options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
    });
    ready.resolve();
    const decision = await response;
    yield { type: 'done', text: decision.cancelled ? 'CANCELLED' : `DECISION ${decision.optionId}` };
  }, { askPolicy: 'provider-plan', exec: false });
  gemini.label = 'Gemini Pro';
  const app = new App({ cols: () => cols, rows: () => rows, write() {} }, workspace(t),
    { providers: [other.id, gemini.id], synthesizer: other.id }, [other, gemini]);
  t.after(() => app.dispose());
  await app.init();

  submit(app, 'First request');
  await peerStreamed.promise;
  requestApproval.resolve();
  await ready.promise;
  const initial = app.snapshot();
  const outputRow = initial.findIndex(line => line.includes('GEMINI PROGRESS'));
  const approvalRow = initial.findIndex(line => line.includes('node -p 1+1'));
  assert.ok(outputRow >= 0 && approvalRow > outputRow);
  assert.ok(initial[approvalRow].indexOf('node -p 1+1') >= cols / 2);
  assert.match(initial.join('\n'), /ALPHA OUTPUT[\s\S]*Gemini Pro 请求权限确认[\s\S]*1\. Allow\s+2\. Deny[\s\S]*Enter 提交/);

  requestPeerApproval.resolve();
  await peerReady.promise;
  assert.match(screen(app), /read alpha\.txt[\s\S]*node -p 1\+1[\s\S]*Ctrl\+G 下一项/);
  app.handleKey({ name: 'ctrl+g' });
  type(app, '2');
  app.handleKey({ name: 'enter' });
  assert.deepEqual(await peerDecision.promise, { optionId: 'decline' });
  type(app, '1');
  app.handleKey({ name: 'enter' });
  await app.waitForIdle();
  assert.match(screen(app), /DECISION allow/);

  ready = deferred();
  requestApproval = deferred();
  submit(app, 'Second request');
  type(app, 'follow-up draft');
  requestApproval.resolve();
  await ready.promise;
  assert.match(screen(app), /Gemini Pro 请求权限确认[\s\S]*Ctrl\+G 回答[\s\S]*follow-up draft/);
  app.handleKey({ name: 'ctrl+g' });
  assert.match(screen(app), /Gemini Pro 请求权限确认[\s\S]*输入选项编号[\s\S]*follow-up draft/);
  app.handleKey({ name: 'tab' });
  type(app, ' kept');
  assert.match(screen(app), /Ctrl\+G 回答[\s\S]*follow-up draft kept/);

  cols = 45;
  rows = 12;
  app.handleKey({ name: 'ctrl+g' });
  assert.match(screen(app), /Gemini Pro[\s\S]*GEMINI PROGRESS[\s\S]*node -p 1\+1[\s\S]*follow-up draft kept/);
  app.handleKey({ name: 'pgdn' });
  assert.match(screen(app), /1\. Allow\s+2\. Deny/);
  app.handleKey({ name: 'esc' });
  await app.waitForIdle();
  cols = 100;
  rows = 22;
  assert.match(screen(app), /CANCELLED[\s\S]*follow-up draft kept/);
});

test('TUI lists local branches, switches through /branch, and preserves conflicting edits', async (t) => {
  const cwd = workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trimEnd();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Unify Test');
  git('config', 'user.email', 'unify@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '.unify-test-hooks');

  const file = join(cwd, 'tracked.txt');
  writeFileSync(file, 'main\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'main');
  git('switch', '-qc', 'feature/git');
  writeFileSync(file, 'feature\n');
  git('commit', '-qam', 'feature');
  git('switch', '-q', 'main');
  git('update-ref', 'refs/remotes/origin/remote-only', 'HEAD');

  const app = new App({ cols: () => 140, rows: () => 30, write() {} }, cwd, {}, []);
  t.after(() => app.dispose());
  await app.init();
  const waitForScreen = async (pattern) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const contents = screen(app);
      if (pattern.test(contents)) return contents;
      await delay(20);
    }
    assert.match(screen(app), pattern);
  };
  submit(app, '/branch');
  const listing = await waitForScreen(/\* main/);
  assert.match(listing, /feature\/git/);
  assert.doesNotMatch(listing, /remote-only/);
  app.handleKey({ name: 'esc' });

  submit(app, '/branch feature/git');
  await waitForScreen(/\(feature\/git\)/);
  assert.equal(readFileSync(file, 'utf8').trim(), 'feature');
  writeFileSync(file, 'local edit\n');
  submit(app, '/branch main');
  await waitForScreen(/overwritten by checkout|local changes/i);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'feature/git');
  assert.equal(readFileSync(file, 'utf8'), 'local edit\n');
});

for (const [platform, copyKey] of [['darwin', '\x1b[99;9u'], ['win32', '\x03']]) test(`TUI drags to select, copies on ${platform}, and opens file references`, async (t) => {
  const { KeyParser } = await import('../dist/tui/keys.js');
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'jump.ts'), 'first\nsecond\nTARGET LINE\nfourth\n');
  writeFileSync(join(cwd, 'notes file.ts'), 'first\nMARKDOWN LINK TARGET\nthird\n');
  const a = target('a', async function* () {
    yield { type: 'done', text: '你好 selected\n\x60jump.ts:3\x60\n[打开文档](<notes file.ts#L2>)' };
  });
  const b = target('b', async function* () { yield { type: 'done', text: 'OTHER OUTPUT' }; });
  const writes = [];
  const copied = [];
  const app = new App({
    cols: () => 112, rows: () => 30, platform, write: (value) => writes.push(value), setClipboard: (value) => copied.push(value),
  }, cwd, { providers: ['a', 'b'], synthesizer: 'b' }, [a, b]);
  t.after(() => app.dispose());
  await app.init();
  submit(app, 'Find the source');
  await app.waitForIdle();
  type(app, 'unsent draft');
  const before = screen(app).split('\n');
  const start = before.findIndex(line => line.includes('你好 selected'));
  const path = before.findIndex(line => line.includes('jump.ts:3'));
  const link = before.findIndex(line => line.includes('打开文档'));
  assert.ok(start >= 0 && path > start && link > path);
  const parser = new KeyParser();
  const mouse = (button, x, y, final = 'M') => {
    for (const key of parser.feed('\x1b[<' + [button, x + 1, y + 1].join(';') + final)) app.handleKey(key);
  };
  const click = (x, y) => { mouse(0, x, y); mouse(0, x, y, 'm'); };

  mouse(0, 3, start); // The second cell of the first wide character.
  mouse(32, 80, path);
  mouse(0, 80, path, 'm');
  assert.match(screen(app), /unsent draft/);
  assert.ok(writes.some(chunk => /\x1b\[(?:[0-9;]+;)?7m/.test(chunk)));
  for (const key of parser.feed(copyKey)) app.handleKey(key);
  assert.deepEqual(copied, ['你好 selected\njump.ts:3']);
  app.handleKey({ name: 'tab' });
  for (const key of parser.feed(copyKey)) app.handleKey(key);
  assert.match(copied[1], /^你好 selected\n`jump\.ts:3`/);

  click(3, path);
  assert.match(screen(app), /jump\.ts:3[\s\S]*› 3 │ TARGET LINE/);
  app.handleKey({ name: 'esc' });
  assert.match(screen(app), /unsent draft/);
  click(3, link);
  assert.match(screen(app), /notes file\.ts:2[\s\S]*› 2 │ MARKDOWN LINK TARGET/);
});

test('TUI synthesis citations open the originating answer during streaming and after resuming', { timeout: 5000 }, async (t) => {
  const cwd = workspace(t);
  const streamed = deferred(), finish = deferred();
  const gemini = { ...target('gemini', async function* () {
    const first = ['GEMINI START', ...Array.from({ length: 24 }, (_, i) => `Context ${i}`)].join('\n');
    yield { type: 'done', text: `${first}\n\n- Second passage\n- GEMINI CITED PASSAGE` };
  }), model: 'gemini-4-neon-medium' };
  const codex = { ...target('codex', async function* () { yield { type: 'done', text: 'CODEX CITED PASSAGE' }; }), label: 'Codex' };
  const judge = target('judge', async function* ({ prompt, signal }) {
    const geminiRef = /<answer id="([^"]+)"[^>]*>\nGEMINI START/.exec(prompt)[1];
    const codexRef = /<answer id="([^"]+)"[^>]*>\nCODEX CITED PASSAGE/.exec(prompt)[1];
    const start = `参见 **${geminiRef.slice(0, -1)}#`;
    const end = `3]** ${codexRef.slice(0, -1)}#1]。`;
    yield { type: 'delta', text: start };
    yield { type: 'delta', text: end };
    streamed.resolve();
    await Promise.race([finish.promise, aborted(signal)]);
    yield { type: 'done', text: start + end };
  });
  const makeApp = async () => {
    const app = new App({ cols: () => 120, rows: () => 22, write() {} }, cwd,
      { providers: ['gemini', 'codex'], synthesizer: 'judge' }, [gemini, codex, judge]);
    t.after(() => app.dispose());
    await app.init();
    return app;
  };
  const live = await makeApp();
  submit(live, 'Compare');
  await streamed.promise;
  type(live, 'follow-up draft');
  clickText(live, 'gemini-4-neon-medium（第3段）');
  assert.match(screen(live), /gemini-4-neon-medium · 第3段原文[\s\S]*› • GEMINI CITED PASSAGE/);
  assert.doesNotMatch(screen(live), /GEMINI START/);
  live.handleKey({ name: 'esc' });
  assert.match(screen(live), /gemini-4-neon-medium（第3段） Codex（第1段）[\s\S]*follow-up draft/);
  finish.resolve();
  await live.waitForIdle();

  const restored = await makeApp();
  const { sessionId } = loadRun(cwd, listRunIds(cwd)[0]);
  submit(restored, `/resume ${sessionId}`);
  const summary = screen(restored);
  clickText(restored, 'Codex（第1段）', textWidth('Codex（') + 1);
  assert.match(screen(restored), /Codex · 第1段原文[\s\S]*› CODEX CITED PASSAGE/);
  restored.handleKey({ name: 'esc' });
  assert.equal(screen(restored), summary);
});

test('TUI opens a cited file from the named repository branch and returns to the cited answer', async (t) => {
  const cwd = workspace(t);
  const repo = join(cwd, 'commonapi');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Unify Test');
  git('config', 'user.email', 'unify@example.invalid');
  git('config', 'core.hooksPath', '.unify-test-hooks');
  git('commit', '--allow-empty', '-qm', 'main');
  git('switch', '-qc', 'feat/ss_plugin');
  mkdirSync(join(repo, 'short_article', 'audit'), { recursive: true });
  writeFileSync(join(repo, 'short_article', 'audit', 'state.go'), 'package audit\nconst BranchSource = 1\n');
  git('add', 'short_article/audit/state.go');
  git('commit', '-qm', 'feature');
  git('switch', '-q', 'main');

  const a = target('a', async function* () {
    yield { type: 'done', text: '常量定义：`commonapi`（`feat/ss_plugin` 分支）`short_article/audit/state.go:2`，另见 `missing.go`。\n\n另一个版本：`commonapi`（`other` 分支）`short_article/audit/state.go`。' };
  });
  const b = target('b', async function* () { yield { type: 'done', text: 'OTHER ANSWER' }; });
  const judge = target('judge', async function* ({ prompt }) {
    const ref = /<answer id="([^"]+)"[^>]*>\n常量定义/.exec(prompt)[1];
    yield { type: 'done', text: `常量来源：\x60commonapi/short_article/audit/state.go:2\x60 ${ref.slice(0, -1)}#1]` };
  });
  const app = new App({ cols: () => 120, rows: () => 28, write() {} }, cwd,
    { providers: ['a', 'b'], synthesizer: 'judge' }, [a, b, judge]);
  t.after(() => app.dispose());
  await app.init();
  submit(app, 'Find the constant');
  await app.waitForIdle();

  const summary = screen(app);
  const preview = /commonapi@feat\/ss_plugin · short_article\/audit\/state\.go:2[\s\S]*› 2 │ const BranchSource = 1/;
  clickText(app, 'commonapi/short_article/audit/state.go:2');
  assert.match(screen(app), preview);
  app.handleKey({ name: 'esc' });
  assert.equal(screen(app), summary);

  clickText(app, 'A（第1段）');
  const answer = screen(app);
  clickText(app, 'short_article/audit/state.go:2');
  assert.match(screen(app), preview);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  app.handleKey({ name: 'esc' });
  assert.equal(screen(app), answer);
  clickText(app, 'missing.go');
  assert.match(screen(app), /无法预览 missing\.go · 找不到文件/);
  app.handleKey({ name: 'esc' });
  assert.equal(screen(app), summary);

  submit(app, 'Find another constant');
  await app.waitForIdle();
  const latest = screen(app);
  app.handleKey({ name: 'left' });
  const historical = screen(app);
  assert.match(historical, /第 1 轮 \(1\/2\)[\s\S]*Find the constant[\s\S]*常量定义[\s\S]*OTHER ANSWER[\s\S]*汇总/);
  clickText(app, 'commonapi/short_article/audit/state.go:2');
  assert.match(screen(app), preview);
  app.handleKey({ name: 'esc' });
  assert.equal(screen(app), historical);
  clickText(app, 'A（第1段）');
  assert.match(screen(app), /第1段原文[\s\S]*常量定义/);
  app.handleKey({ name: 'esc' });
  assert.equal(screen(app), historical);
  app.handleKey({ name: 'right' });
  assert.equal(screen(app), latest);
});

test('TUI recaps each completed turn in the background and reloads the latest recap', { timeout: 5000 }, async (t) => {
  const cwd = workspace(t);
  const started = deferred(), release = deferred();
  const recapInputs = [];
  const answer = target('answer', async function* ({ prompt }) {
    assert.doesNotMatch(prompt, /回顾已生成/);
    yield { type: 'done', text: prompt.endsWith('FIRST_TASK') ? 'FIRST_ANSWER' : 'SECOND_ANSWER' };
  });
  const summarizer = target('summary', async function* ({ prompt, signal }) {
    const input = JSON.parse(prompt.split('\n').at(-1));
    recapInputs.push(input);
    if (recapInputs.length === 1) {
      started.resolve();
      await Promise.race([release.promise, aborted(signal)]);
    }
    yield { type: 'done', text: `回顾已生成 ${recapInputs.length}`, usage: { inputTokens: 10, outputTokens: 4 } };
  });
  const worker = target('worker', async function* () {
    yield { type: 'done', text: 'IMPLEMENTED' };
  }, { askPolicy: 'sandbox-read-only', exec: true });
  const cfg = { providers: ['answer'], synthesizer: 'summary', executor: 'worker' };
  const makeApp = async () => {
    const app = new App({ cols: () => 120, rows: () => 28, write() {} }, cwd, cfg, [answer, summarizer, worker]);
    t.after(() => app.dispose());
    await app.init();
    return app;
  };
  const app = await makeApp();
  submit(app, 'FIRST_TASK');
  await started.promise;
  assert.match(screen(app), /回顾 · 正在生成/);
  submit(app, 'SECOND_TASK');
  await app.waitForIdle();
  assert.match(screen(app), /SECOND_ANSWER/);
  assert.equal(listRunIds(cwd).length, 2);
  assert.equal(recapInputs.length, 1);

  submit(app, '/exec');
  type(app, 'y');
  await app.waitForIdle();
  const ids = listRunIds(cwd);
  assert.deepEqual(ids.map(id => loadRun(cwd, id).kind), ['comparison', 'comparison', 'execution']);
  release.resolve();
  for (let i = 0; i < 100 && !loadRunRecap(cwd, ids[2]); i++) await delay(10);
  assert.deepEqual(ids.map(id => loadRunRecap(cwd, id)), ['回顾已生成 1', '回顾已生成 2', '回顾已生成 3']);
  assert.equal(recapInputs[0].recent[0].answer, 'FIRST_ANSWER');
  assert.deepEqual(recapInputs[1].recent.map(item => item.answer), ['FIRST_ANSWER', 'SECOND_ANSWER']);
  assert.equal(recapInputs[2].executionStatus, 'completed');
  assert.match(recapInputs[2].recent.at(-1).answer, /IMPLEMENTED/);
  assert.match(screen(app), /回顾 · 回顾已生成 3/);
  assert.match(screen(app), /↑30 ↓12/);

  const restored = await makeApp();
  submit(restored, `/resume ${loadRun(cwd, ids[0]).sessionId}`);
  assert.match(screen(restored), /回顾 · 回顾已生成 3/);
  assert.equal(recapInputs.length, 3);

  type(restored, 'AC');
  restored.handleKey({ name: 'left' });
  type(restored, 'B');
  restored.handleKey({ name: 'right' });
  type(restored, 'D');
  assert.equal(composer(restored), '❯ ABCD');
  restored.handleKey({ name: 'ctrl+u' });
  restored.handleKey({ name: 'left' });
  assert.match(screen(restored), /第 2 轮 \(2\/3\)[\s\S]*SECOND_ANSWER[\s\S]*回顾已生成 2/);
  restored.handleKey({ name: 'left' });
  assert.match(screen(restored), /第 1 轮 \(1\/3\)[\s\S]*FIRST_TASK[\s\S]*FIRST_ANSWER[\s\S]*回顾已生成 1/);
  restored.handleKey({ name: 'right' });
  assert.match(screen(restored), /第 2 轮 \(2\/3\)[\s\S]*SECOND_ANSWER[\s\S]*回顾已生成 2/);
  restored.handleKey({ name: 'right' });
  assert.match(screen(restored), /SECOND_TASK[\s\S]*IMPLEMENTED[\s\S]*回顾 · 回顾已生成 3/);
  restored.handleKey({ name: 'left' });
  restored.handleKey({ name: 'left' });
  restored.handleKey({ name: 'esc' });
  assert.match(screen(restored), /SECOND_TASK[\s\S]*回顾 · 回顾已生成 3/);
  assert.equal(recapInputs.length, 3);

  submit(restored, 'THIRD_TASK');
  await restored.waitForIdle();
  const followUp = loadRun(cwd, listRunIds(cwd).at(-1));
  assert.equal(followUp.parentTurnId, ids[2]);
  assert.match(followUp.input.history.at(-1).answer, /IMPLEMENTED/);
  restored.handleKey({ name: 'left' });
  assert.match(screen(restored), /第 2 轮 · 实施[\s\S]*IMPLEMENTED[\s\S]*回顾已生成 3/);
});

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
  assert.deepEqual(names('\x1b[99;9u\x1b[99;73u\x1b[27;9;99~\x1b[120;9u\x1b[1;9D\x03'), ['cmd+c', 'cmd+c', 'cmd+c', 'ctrl+c']);
  assert.deepEqual(names('\x1b[1;5D\x1b[1;3C\x1bb\x1bf\x1b\x7f\x1b[3;5~\x1b[D'), ['wordleft', 'wordright', 'wordleft', 'wordright', 'wordback', 'worddel', 'left']);
  assert.deepEqual(new KeyParser().feed('\x1b[200~a\x1b[13;2ub\x1b[201~'), [{ name: 'paste', text: 'a\x1b[13;2ub' }]);
  const parser = new KeyParser();
  assert.deepEqual(parser.feed('\x1b[<0;3;4M\x1b[<32;5'), [{ name: 'mousedown', x: 2, y: 3 }]);
  assert.deepEqual(parser.feed(';6M\x1b[<0;5;6m\x1b[<65;5;6M'), [
    { name: 'mousedrag', x: 4, y: 5 }, { name: 'mouseup', x: 4, y: 5 }, { name: 'wheeldown', x: 4, y: 5 },
  ]);
  assert.deepEqual(parser.feed('\x1b[99;'), []);
  assert.deepEqual(parser.feed('9u'), [{ name: 'cmd+c' }]);
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
  assert.match(screen(app), /› \/settings/);
  assert.doesNotMatch(screen(app), /\/(models|synth|mouse)\b/);
  type(app, 'rev');
  assert.doesNotMatch(screen(app), /› \/settings/);
  assert.doesNotMatch(screen(app), /\/graph/);
  app.handleKey({ name: 'enter' }); // /revise needs its argument: completes, does not run
  assert.equal(composer(app), '❯ /revise');
  app.handleKey({ name: 'ctrl+u' });

  type(app, '/ret');
  app.handleKey({ name: 'tab' });
  type(app, 'alpha,b');
  assert.match(screen(app), /› beta/);
  app.handleKey({ name: 'tab' });
  app.handleKey({ name: 'enter' });
  assert.match(screen(app), /没有可重试的记录/);

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
  assert.equal(composer(app), '❯ /retry alpha,beta');
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
  clickText(app, '› 测试可用性');
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
  const recap = target('recap', async function* () { yield { type: 'done', text: '回顾就绪' }; });
  const app = new App({ cols: () => 100, rows: () => 30, write() {} }, cwd,
    { providers: ['a'], synthesizer: 'recap' }, [a, recap]);
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
