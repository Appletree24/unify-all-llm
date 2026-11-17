import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { customAdapter } from '../dist/providers/custom.js';
import { runOne } from '../dist/core/orchestrator.js';
import { sseData } from '../dist/providers/sse.js';
import { options, workspace } from './helpers.mjs';

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
    res.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"想"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"content":"答"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
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
