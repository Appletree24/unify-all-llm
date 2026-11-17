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
