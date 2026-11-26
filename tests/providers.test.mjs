import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { customAdapter } from '../dist/providers/custom.js';
import { runOne } from '../dist/core/orchestrator.js';
import { defaultTargetIds } from '../dist/core/targets.js';
import { geminiPro } from '../dist/providers/antigravity.js';
import { sseData } from '../dist/providers/sse.js';
import { modelSettings } from '../dist/providers/agy-models.js';
import { effortChoices, httpEffort } from '../dist/providers/effort.js';
import { answerEffortLabels, routingNotice } from '../dist/core/routing.js';
import { resolveAnswerEffort } from '../dist/core/answer-effort.js';
import { options, workspace } from './helpers.mjs';

test('none is hidden from strength pickers while explicit configurations retain their wire behavior', () => {
  const baseUrl = 'https://api.deepseek.com';
  const model = 'deepseek-flash';
  const target = { id: 'deepseek', model, adapter: customAdapter('deepseek', { type: 'openai', model, baseUrl }) };
  assert.equal(Object.hasOwn(answerEffortLabels, 'none'), false);
  const settings = modelSettings({ models: [model], model, reasoningEffort: 'none', efforts: effortChoices(target) });
  assert.deepEqual(settings.efforts.map(e => e.value), ['default', 'low', 'high', 'max']);
  assert.equal(settings.effortValue, 'none');
  assert.equal(settings.storedEffort, '已关闭额外推理');
  const explicit = resolveAnswerEffort(target, 'none', undefined, []);
  assert.deepEqual(httpEffort(baseUrl, explicit.target.reasoningEffort), { thinking: { type: 'disabled' } });
  assert.match(routingNotice({ kind: 'direct', reason: '', answers: [explicit.choice] }), /已关闭额外推理/);
  assert.deepEqual(httpEffort(baseUrl, resolveAnswerEffort(target, 'default', undefined, []).target.reasoningEffort), {});
});

test('SSE decodes split UTF-8, CRLF, comments, multiline and trailing data', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]');
  const body = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } });
  const events = [];
  for await (const event of sseData(body)) events.push(event);
  assert.deepEqual(events, ['{"text":\n"你好"}', '[DONE]']);
});

test('OpenAI stream accepts explicit completion and preserves failure output', async (t) => {
  const cwd = workspace(t);
  const first = 'data: {"choices":[{"index":0,"delta":{"content":"部分"}}]}\n\n';
  const cases = [
    ['done', '[DONE]', 'succeeded'],
    ['finish', '{"choices":[{"finish_reason":"stop","delta":{}}]}', 'succeeded'],
    ['length', '{"choices":[{"finish_reason":"length","delta":{}}]}', 'failed'],
    ['error', '{"error":{"message":"rate limit"}}', 'failed'],
    ['truncated', '', 'failed'],
    ['malformed', '{no}', 'failed'],
  ];
  const server = createServer((req, res) => {
    req.resume();
    const name = req.url.split('/')[1];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(first);
    const data = cases.find((c) => c[0] === name)[1];
    if (data) res.write(`data: ${data}\n\n`);
    if (name !== 'done') res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [name, , status] of cases) await t.test(name, async () => {
    const adapter = customAdapter('http', { type: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/${name}`, model: 'fixture' });
    const result = await runOne({ id: 'http', label: 'HTTP', adapter }, options(cwd));
    assert.equal(result.status, status);
    assert.equal(result.text, '部分');
  });
});

test('built-in DeepSeek target authenticates from the environment and streams reasoning', async (t) => {
  const { deepseekAdapter } = await import('../dist/providers/deepseek.js');
  const { buildRegistry } = await import('../dist/providers/index.js');
  const cwd = workspace(t);
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"想","content":null}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"content":"答","reasoning_content":null,"reasoning":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const saved = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    server.closeAllConnections(); server.close();
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved;
  });
  const adapter = deepseekAdapter(`http://127.0.0.1:${server.address().port}`);
  const target = { id: 'deepseek', label: 'DeepSeek', adapter, model: 'deepseek-v4-pro' };

  delete process.env.DEEPSEEK_API_KEY;
  assert.equal((await adapter.detect()).installed, false);
  const missing = await runOne(target, options(cwd));
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /DEEPSEEK_API_KEY/);
  assert.equal(seen.length, 0);

  process.env.DEEPSEEK_API_KEY = 'sk-test';
  assert.equal((await adapter.detect()).installed, true);
  const result = await runOne(target, options(cwd));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, '答');
  assert.equal(result.reasoning, '想');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 1 });
  assert.deepEqual(seen.map((r) => [r.url, r.auth, r.body.model]), [['/chat/completions', 'Bearer sk-test', 'deepseek-v4-pro']]);
  assert.equal((await runOne(target, options(cwd, { mode: 'exec' }))).status, 'failed');

  const registry = buildRegistry({ targets: { pro: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, providers: ['deepseek', 'pro'] });
  assert.equal(registry.deepseek.adapter.configuration.baseUrl, 'https://api.deepseek.com');
  assert.equal(registry.pro.adapter, registry.deepseek.adapter);
  assert.throws(() => buildRegistry({ executor: 'deepseek' }), /不支持实施/);
  const gateway = buildRegistry({ custom: { deepseek: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } } });
  assert.equal(gateway.deepseek.adapter.configuration.baseUrl, 'http://127.0.0.1:9/v1');
  assert.throws(() => buildRegistry({ custom: { codex: { type: 'command', command: 'x' } } }), /重名/);
});

test('Codex manual effort choices honor the catalog and exec forwards max and ultra', async t => {
  const { buildRegistry } = await import('../dist/providers/index.js');
  const { effortChoices } = await import('../dist/providers/effort.js');
  const { createCodexAdapter } = await import('../dist/providers/codex.js');
  const cwd = workspace(t);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = cwd;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  writeFileSync(join(cwd, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'limited', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] },
  ] }));
  const limited = buildRegistry({ models: { codex: 'limited' } }).codex;
  assert.deepEqual(effortChoices(limited), ['high', 'max']);
  assert.throws(() => buildRegistry({ models: { codex: 'limited' }, reasoningEffort: { codex: 'ultra' } }), /不支持思考强度 ultra/);
  const fixture = join(cwd, 'exec.mjs');
  writeFileSync(fixture, `const setting = process.argv.find(arg => arg.startsWith('model_reasoning_effort='));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: setting } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));`);
  const adapter = createCodexAdapter({ cmd: process.execPath, prefixArgs: [fixture], nativeExecutable: true });
  for (const level of ['max', 'ultra']) {
    const target = buildRegistry({ reasoningEffort: { codex: level } }).codex;
    assert.ok(effortChoices(target).includes(level));
    const result = await runOne({ ...target, adapter }, options(cwd));
    assert.equal(result.text, 'model_reasoning_effort=' + level);
  }
});

test('HTTP targets encode effort for their transport and leave provider defaults untouched', async t => {
  const { officialAdapter, officialApis } = await import('../dist/providers/official.js');
  const { buildRegistry } = await import('../dist/providers/index.js');
  const { effortChoices } = await import('../dist/providers/effort.js');
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
  });
  const cwd = workspace(t);
  for (const [id, model, reasoningEffort, expected] of [
    ['deepseek', 'deepseek-flash', undefined, {}],
    ['deepseek', 'deepseek-flash', 'none', { thinking: { type: 'disabled' } }],
    ['gemini-api', 'gemini-3.6-flash', 'medium', { reasoning_effort: 'medium' }],
    ['openai', 'o3', 'high', { reasoning_effort: 'high' }],
    ['anthropic', 'claude-haiku-4-5', 'low', { thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 5120 }],
  ]) {
    const adapter = officialAdapter(officialApis.find(p => p.id === id), { model, apiKey: 'fixture' });
    const target = { id, model, label: id, adapter, reasoningEffort };
    if (reasoningEffort) assert.ok(effortChoices(target).includes(reasoningEffort));
    assert.equal((await runOne(target, options(cwd))).status, 'succeeded');
    assert.deepEqual(bodies.pop(), { model, stream: true, messages: [{ role: 'user', content: 'question' }], ...expected });
  }
  assert.throws(() => buildRegistry({ reasoningEffort: { gemini: 'high' } }), /不支持思考强度/);
  assert.throws(() => buildRegistry({ reasoningEffort: { nonexistent: 'low' } }), /未知目标/);
});
test('subscription chat is selectable without adding it to existing automatic comparisons', () => {
  const target = { id: geminiPro.id, adapter: geminiPro };
  assert.deepEqual(defaultTargetIds({}, [target]), []);
  assert.deepEqual(defaultTargetIds({ providers: [target.id] }, [target]), [target.id]);
});
