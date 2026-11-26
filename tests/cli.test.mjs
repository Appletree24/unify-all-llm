import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadRun, listRunIds } from '../dist/core/store.js';
import { workspace } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const model = new URL('fixtures/model-cli.mjs', import.meta.url).href;

function environment(t) {
  const cwd = workspace(t);
  const bin = join(cwd, 'bin');
  const home = join(cwd, 'home');
  mkdirSync(bin);
  mkdirSync(join(home, '.unify'), { recursive: true });
  for (const name of ['claude', 'codex', 'gemini', 'agy']) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${name}.mjs`), `import ${JSON.stringify(model)};\n`);
      writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
    } else {
      const path = join(bin, name);
      writeFileSync(path, `#!${process.execPath}\nimport ${JSON.stringify(model)};\n`);
      chmodSync(path, 0o755);
    }
  }
  writeFileSync(join(home, '.unify', 'config.json'), '{"disableClaude":true}');
  writeFileSync(join(cwd, 'unify.config.json'), JSON.stringify({
    providers: ['fast', 'deep'], synthesizer: 'fast',
    targets: { fast: { provider: 'codex', model: 'fast' }, deep: { provider: 'codex', model: 'deep' } },
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  const searchPath = process.platform === 'win32' ? [bin, dirname(process.execPath)] : [bin, dirname(process.execPath), '/usr/bin', '/bin'];
  return { cwd, env: { ...env, HOME: home, USERPROFILE: home, PATH: searchPath.join(delimiter), UNIFY_TEST_LOG: join(cwd, 'calls.jsonl') } };
}

async function invoke(args, opts, onOutput) {
  const child = spawn(process.execPath, [cli, ...args], { ...opts, timeout: 10000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (s) => { stdout += s; onOutput?.(stdout, child); });
  child.stderr.on('data', (s) => { stderr += s; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}

test('CLI opts into automatic routing through the existing ask command', async (t) => {
  const opts = environment(t);
  const command = text => ({ type: 'command', command: process.execPath, args: ['-e', `console.log(${JSON.stringify(text)})`] });
  writeFileSync(join(opts.env.HOME, '.unify', 'config.json'), JSON.stringify({
    disableClaude: true, custom: { fast: command('first answer'), deep: command('independent answer') },
  }));
  writeFileSync(join(opts.cwd, 'unify.config.json'), JSON.stringify({ providers: ['fast', 'deep'], synthesizer: 'fast' }));
  const result = await invoke(['ask', '--mode', 'auto', '把这段话压成一句', '--json'], opts);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.type === 'call').map(e => e.scope), ['answer']);
  assert.equal(loadRun(opts.cwd).routing.kind, 'direct');
  const named = await invoke(['ask', '--mode', 'auto', '只让 deep 回答，解释 fast 的含义', '--json'], opts);
  assert.equal(named.code, 0, named.stderr);
  assert.deepEqual(loadRun(opts.cwd).calls.map(c => c.target.id), ['deep']);
});

test('Codex max and ultra follow the inherited model catalog and reach the actual turn', async t => {
  const opts = environment(t);
  opts.env.CODEX_HOME = join(opts.env.HOME, '.codex');
  opts.env.UNIFY_TEST_SCENARIO = 'codex-efforts';
  writeFileSync(join(opts.cwd, 'unify.config.json'), JSON.stringify({ providers: ['codex'] }));
  const ask = (model, effort) => invoke(['ask', '--model', model, '--effort', effort, '--json', '请回答'], opts);
  for (const [inherited, speaker, level, expected] of [
    ['pro', 'auto', 'ultra', 'pro'], ['pro', 'codex', 'max', 'pro'], [null, 'auto', 'max', 'small'],
  ]) {
    if (inherited) opts.env.UNIFY_TEST_CODEX_MODEL = inherited;
    else delete opts.env.UNIFY_TEST_CODEX_MODEL;
    const result = await ask(speaker, level);
    assert.equal(result.code, 0, result.stderr);
    const run = loadRun(opts.cwd);
    assert.equal(run.results[0].text, level);
    assert.equal(run.calls[0].target.model, expected);
    assert.equal(run.routing.answers[0].level, level);
  }
  const unsupported = await ask('codex', 'ultra');
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr + unsupported.stdout, /思考强度 ultra/);
  assert.equal(loadRun(opts.cwd).calls.length, 0);
  opts.env.UNIFY_TEST_CODEX_MODEL = 'unlisted';
  assert.equal((await ask('auto', 'ultra')).code, 1);
  const manual = await ask('codex', 'ultra');
  assert.equal(manual.code, 0, manual.stderr);
  assert.equal(loadRun(opts.cwd).results[0].text, 'ultra');
});

test('CLI advisor verifies supplied logs before revising and show restores the findings', async t => {
  const opts = environment(t);
  const calls = [];
  const quote = 'timeout attempt=1 retries=0';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, messages } = JSON.parse(body);
    const prompt = messages.at(-1).content;
    calls.push(model);
    const reply = model === 'judge' ? JSON.stringify({ verdict: 'disputed', finding: '日志显示重试次数为零。', quotes: [quote] })
      : prompt.startsWith('请结合已核对的证据') ? '更正：这次没有重试。' : '这次重试了三次。\n需独立核对：重试次数是多少？';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(opts.env.HOME, '.unify', 'config.json'), JSON.stringify({ custom: {
    writer: { type: 'openai', model: 'writer', baseUrl }, judge: { type: 'openai', model: 'judge', baseUrl },
  } }));
  writeFileSync(join(opts.cwd, 'unify.config.json'), JSON.stringify({ providers: ['writer'] }));
  const result = await invoke(['ask', '--model', 'writer', '--advisor', 'judge', '--json', '问这次重试了几次。日志：' + quote], opts);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls, ['writer', 'judge', 'writer']);
  const run = loadRun(opts.cwd);
  assert.equal(run.advisor.status, 'revised');
  const shown = await invoke(['show', run.id], opts);
  assert.match(shown.stdout, /更正：这次没有重试/);
  assert.match(shown.stdout, /顾问复核 · 首答已修订 · judge/);
  assert.match(shown.stdout, /timeout attempt=1 retries=0/);
});

test('CLI answer policy selects a compatible model and sends the requested HTTP effort', async t => {
  const opts = environment(t);
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(opts.env.HOME, '.unify', 'config.json'), JSON.stringify({ custom: {
    plain: { type: 'openai', baseUrl, model: 'plain' },
    smart: { type: 'openai', baseUrl, model: 'smart', supportedEfforts: ['low', 'high'] },
  } }));
  writeFileSync(join(opts.cwd, 'unify.config.json'), JSON.stringify({ providers: ['plain', 'smart'], answerModel: 'plain' }));
  const high = await invoke(['ask', '--model', 'auto', '--effort', 'auto', '本轮用 high', '--json'], opts);
  assert.equal(high.code, 0, high.stderr);
  const native = await invoke(['ask', '--model', 'smart', '--effort', 'auto', '用一句话回答', '--json'], opts);
  assert.equal(native.code, 0, native.stderr);
  assert.deepEqual(requests.map(r => [r.model, r.reasoning_effort]), [['smart', 'high'], ['smart', undefined]]);
  assert.ok(!Object.hasOwn(requests[1], 'reasoning_effort'));
});

test('CLI JSONL separates target, provider and call identities; continue and retry read records', async (t) => {
  const opts = environment(t);
  const path = join(opts.cwd, 'unify.config.json');
  const config = JSON.parse(readFileSync(path));
  config.targets.fast.reasoningEffort = 'low';
  config.reasoningEffort = { deep: 'high' };
  writeFileSync(path, JSON.stringify(config));
  const result = await invoke(['ask', 'FIRST', '--json'], opts);
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(events.every((e) => e.schemaVersion === 2 && e.turnId));
  const calls = events.filter((e) => e.type === 'call' && e.scope === 'answer');
  assert.deepEqual(calls.map((e) => e.target.id), ['fast', 'deep']);
  assert.ok(calls.every((e) => e.target.provider === 'codex'));
  assert.notEqual(calls[0].callId, calls[1].callId);
  assert.equal(events.at(-1).status, 'completed');
  assert.equal((await invoke(['ask', '-c', 'SECOND', '--json', '--no-synth'], opts)).code, 0);
  const current = loadRun(opts.cwd);
  assert.match(current.input.prompt, /FIRST/);
  assert.match(current.input.prompt, /SECOND/);
  assert.deepEqual(current.targets.map(t => t.reasoningEffort), ['low', 'high']);
  config.reasoningEffort.deep = 'medium';
  writeFileSync(path, JSON.stringify(config));
  const retry = await invoke(['retry', current.id, '--target', 'deep', '--json'], opts);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(loadRun(opts.cwd).retryOf, current.id);
  const log = readFileSync(opts.env.UNIFY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const invocations = log.filter(l => l.args.includes('exec'));
  assert.ok(invocations.filter(l => l.args.includes('fast')).every(l => l.args.includes('model_reasoning_effort=low')));
  assert.ok(invocations.at(-1).args.includes('model_reasoning_effort=high'));
  assert.equal(loadRun(opts.cwd).results[0].reasoningEffort, 'high');
  assert.ok(log.every((l) => l.name !== 'claude'), 'disabled Claude must never execute, including --version');
});

test('fixture CLI adapters require their terminal and a successful process exit', { skip: process.platform === 'win32' }, async (t) => {
  for (const provider of ['codex', 'gemini', 'claude']) for (const scenario of ['normal', 'truncate', 'late-failure']) {
    const opts = environment(t);
    // A generated fake executable is used here; no installed model CLI is invoked.
    writeFileSync(join(opts.env.HOME, '.unify', 'config.json'), '{}');
    writeFileSync(join(opts.cwd, 'unify.config.json'), JSON.stringify({ providers: [provider] }));
    opts.env.UNIFY_TEST_SCENARIO = scenario;
    const result = await invoke(['ask', 'fixture', '--json'], opts);
    assert.equal(result.code, scenario === 'normal' ? 0 : 1, `${provider}/${scenario}: ${result.stderr}`);
    const record = loadRun(opts.cwd);
    assert.equal(record.results[0].status, scenario === 'normal' ? 'succeeded' : 'failed');
    if (provider === 'gemini') {
      const log = readFileSync(opts.env.UNIFY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(log.some((l) => l.args.includes('plan')));
    }
  }
});

test('Gemini Pro chats through agy and follows up using the selected Unify conversation', { skip: process.platform === 'win32' }, async (t) => {
  const opts = environment(t);
  const ask = ['ask', '--models', 'gemini-pro', '--json'];
  const first = await invoke([...ask, 'CHAT_ONE'], opts);
  assert.equal(first.code, 0, first.stderr);
  const second = await invoke([...ask, '-c', 'CHAT_TWO'], opts);
  assert.equal(second.code, 0, second.stderr);
  const [result] = loadRun(opts.cwd).results;
  assert.equal(result.text, 'remembered');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 5 });
  const calls = readFileSync(opts.env.UNIFY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((c) => c.name === 'agy' && !c.args.includes('--version'));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, ['--mode', 'plan', '--disable-slash-commands', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--model', result.model]);
  }
  for (const [scenario, message] of [['signed-out', 'authentication required'], ['truncate', '缺少协议终态']]) {
    opts.env.UNIFY_TEST_SCENARIO = scenario;
    assert.equal((await invoke([...ask, 'Q'], opts)).code, 1);
    assert.ok(loadRun(opts.cwd).results[0].error.includes(message));
  }
});

test('Codex reconnects can succeed and failures preserve the CLI diagnostic', { skip: process.platform === 'win32' }, async (t) => {
  const opts = environment(t);
  for (const [scenario, diagnostic] of [
    ['reconnected', undefined],
    ['turn-failed', 'fixture upstream failure'],
    ['error-exit', 'fixture connection error'],
  ]) {
    opts.env.UNIFY_TEST_SCENARIO = scenario;
    const reply = await invoke(['ask', 'fixture', '--models', 'fast', '--no-synth', '--json'], opts);
    assert.equal(reply.code, diagnostic ? 1 : 0, reply.stderr);
    const [result] = loadRun(opts.cwd).results;
    if (diagnostic) assert.ok(result.error.includes(diagnostic), result.error);
    else assert.equal(result.text, 'answer-fast');
  }
});

test('CLI execution is durable and failed configuration never launches a model', { skip: process.platform === 'win32' }, async (t) => {
  const opts = environment(t);
  assert.equal((await invoke(['ask', 'implement', '--json'], opts)).code, 0);
  const source = loadRun(opts.cwd);
  const result = await invoke(['exec', source.id, '--with', 'fast', '--yes'], opts);
  assert.equal(result.code, 0, result.stderr);
  const execution = loadRun(opts.cwd);
  assert.equal(execution.kind, 'execution');
  assert.equal(execution.planSource.turnId, source.id);
  assert.equal(listRunIds(opts.cwd).length, 2);
  const before = readFileSync(opts.env.UNIFY_TEST_LOG, 'utf8');
  const bad = await invoke(['ask', 'Q', '--timeout', 'Infinity'], opts);
  assert.equal(bad.code, 1);
  assert.equal(readFileSync(opts.env.UNIFY_TEST_LOG, 'utf8'), before);
});

test('CLI SIGINT keeps stdout valid JSONL and saves partial results before exit', { skip: process.platform === 'win32' }, async (t) => {
  const opts = environment(t);
  opts.env.UNIFY_TEST_SCENARIO = 'wait';
  let cancelled = false;
  const result = await invoke(['ask', 'Q', '--json', '--models', 'fast'], opts, (output, child) => {
    if (!cancelled && output.includes('"type":"delta"')) { cancelled = true; child.kill('SIGINT'); }
  });
  assert.equal(result.code, 130, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).status, 'cancelled');
  const record = loadRun(opts.cwd);
  assert.equal(record.results[0].status, 'cancelled');
  assert.equal(record.results[0].text, 'answer-fast');
});

test('quota --watch samples each provider once, isolates failures and exits on interrupt', { skip: process.platform === 'win32' }, async (t) => {
  const opts = environment(t);
  const helper = join(opts.cwd, 'quota.cjs');
  const result = { limits: [{ label: '每月请求', remaining: 0, total: 100, unit: '次' }] };
  writeFileSync(helper, `require('node:fs').appendFileSync(process.env.UNIFY_TEST_LOG, process.argv[2] + '\\n');
    if (process.argv[2] === 'gemini') { console.error('private stderr'); process.exit(1); }
    console.log(JSON.stringify(${JSON.stringify(result)}));`);
  const command = (id) => ({ command: process.execPath, args: [helper, id] });
  writeFileSync(join(opts.env.HOME, '.unify', 'config.json'), JSON.stringify({
    disableClaude: true,
    custom: { deepseek: { type: 'command', command: 'uninstalled-gateway' } },
    quotaCommands: { codex: command('codex'), claude: command('disabled'), gemini: command('gemini') },
  }));
  writeFileSync(join(opts.cwd, 'unify.config.json'), JSON.stringify({
    targets: { fast: { provider: 'codex', model: 'mini' } },
    quotaCommands: { deepseek: command('untrusted') },
  }));
  const run = await invoke(['quota', '--watch', '--json'], opts, (output, child) => {
    if (output.endsWith('\n')) child.kill('SIGINT');
  });
  assert.equal(run.code, 130, run.stderr);
  const rows = Object.fromEntries(JSON.parse(run.stdout).map(row => [row.targetId, row]));
  assert.deepEqual(rows.fast.reading, { status: 'ok', ...result });
  assert.deepEqual(rows.codex.reading, rows.fast.reading);
  assert.equal(rows.fast.provider, 'codex');
  assert.equal(rows.fast.model, 'mini');
  assert.match(rows.claude.reading.message, /disableClaude/);
  assert.equal(rows.gemini.reading.status, 'error');
  assert.match(rows.deepseek.reading.message, /quotaCommands.deepseek/);
  assert.doesNotMatch(run.stdout + run.stderr, /private stderr/);
  assert.deepEqual(readFileSync(opts.env.UNIFY_TEST_LOG, 'utf8').trim().split('\n').sort(), ['codex', 'gemini']);
  assert.deepEqual(listRunIds(opts.cwd), []);
});
