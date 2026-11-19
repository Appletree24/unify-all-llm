import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDeepseekQuota } from '../dist/quota/deepseek.js';
import { readGeminiQuota } from '../dist/quota/gemini.js';
import { workspace } from './helpers.mjs';

function env(t, values) {
  for (const [name, next] of Object.entries(values)) {
    const old = process.env[name];
    const set = v => v === undefined ? delete process.env[name] : process.env[name] = v;
    set(next);
    t.after(() => set(old));
  }
}

function geminiSetup(t) {
  const root = workspace(t);
  const dir = join(root, '.gemini');
  const ctx = { cwd: join(root, 'project'), signal: new AbortController().signal };
  mkdirSync(dir);
  mkdirSync(join(ctx.cwd, '.gemini'), { recursive: true });
  env(t, {
    GEMINI_CLI_HOME: root, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(root, 'system.json'),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(root, 'defaults.json'), CODE_ASSIST_ENDPOINT: undefined,
    CODE_ASSIST_API_VERSION: undefined, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: undefined,
    GEMINI_CLI_AUTH_OVERRIDE: undefined, GOOGLE_GENAI_USE_GCA: undefined, GOOGLE_CLOUD_ACCESS_TOKEN: undefined,
    GOOGLE_CLOUD_PROJECT: undefined, GOOGLE_CLOUD_PROJECT_ID: undefined,
  });
  writeFileSync(join(dir, 'settings.json'), '{"security":{"auth":{"selectedType":"oauth-personal"}}} // OAuth\n');
  writeFileSync(join(dir, 'oauth_creds.json'), JSON.stringify({ access_token: 'test-token', expiry_date: Date.now() + 60000 }));
  return { dir, ctx };
}

test('DeepSeek uses the balance endpoint and keeps each currency, including a zero balance', async t => {
  env(t, { DEEPSEEK_API_KEY: 'test-key' });
  const ctx = { cwd: '.', signal: new AbortController().signal };
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ balance_infos: [
    { currency: 'CNY', total_balance: '10.5101', granted_balance: '2.0' },
    { currency: 'USD', total_balance: '0.00' },
  ] }));
  assert.deepEqual(await readDeepseekQuota(ctx), { status: 'ok', limits: [
    { label: '账户余额', remaining: 10.5101, unit: 'CNY' }, { label: '账户余额', remaining: 0, unit: 'USD' },
  ] });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://api.deepseek.com/user/balance');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(options.signal, ctx.signal);
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal((await readDeepseekQuota(ctx)).status, 'unavailable');
  assert.equal(fetch.mock.callCount(), 1);
});

test('DeepSeek treats unusable amounts as a failed query', async t => {
  env(t, { DEEPSEEK_API_KEY: 'test-key' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ balance_infos: [{ currency: 'USD', total_balance: '' }] }));
  assert.equal((await readDeepseekQuota({ signal: new AbortController().signal })).status, 'error');
});

test('Gemini uses the managed project and reads fractions, amounts and per-model reset times', async t => {
  const { ctx } = geminiSetup(t);
  const resetTime = '2026-11-20T12:00:00Z';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.Authorization, 'Bearer test-token');
    assert.equal(opts.signal, ctx.signal);
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    if (url === 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      return Response.json({ cloudaicompanionProject: 'managed-test' });
    }
    assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
    assert.deepEqual(JSON.parse(opts.body), { project: 'managed-test' });
    return Response.json({ buckets: [
      { modelId: 'pro', tokenType: 'REQUESTS', remainingFraction: 0, resetTime },
      { modelId: 'flash', remainingFraction: 0.29 },
      { modelId: 'flash-lite', tokenType: 'REQUESTS', remainingAmount: '10' },
      { modelId: 'unknown' },
    ] });
  });
  assert.deepEqual(await readGeminiQuota(ctx), { status: 'ok', limits: [
    { label: 'pro · REQUESTS', remaining: 0, unit: '%', resetsAt: resetTime },
    { label: 'flash', remaining: 29, unit: '%' }, { label: 'flash-lite', remaining: 10, unit: 'REQUESTS' },
  ] });
  assert.equal(calls.length, 2);
});

test('Gemini never uses an old account token for an API-key project, Vertex system policy or expired login', async t => {
  const { ctx, dir } = geminiSetup(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected fetch'); });
  const localSettings = join(ctx.cwd, '.gemini', 'settings.json');
  writeFileSync(localSettings, '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
  assert.equal((await readGeminiQuota(ctx)).status, 'unavailable');
  writeFileSync(localSettings, '{}');
  writeFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, '{"security":{"auth":{"enforcedType":"vertex-ai"}}}');
  assert.equal((await readGeminiQuota(ctx)).status, 'unavailable');
  writeFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, '{}');
  writeFileSync(join(dir, 'oauth_creds.json'), '{"access_token":"expired","expiry_date":1}');
  assert.match((await readGeminiQuota(ctx)).message, /刷新/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('Gemini uses the explicit GCA access token and releases rejected HTTP responses', async t => {
  const { ctx } = geminiSetup(t);
  env(t, { GOOGLE_GENAI_USE_GCA: 'true', GOOGLE_CLOUD_ACCESS_TOKEN: 'explicit-token' });
  let released = false;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer explicit-token');
    return new Response(new ReadableStream({ cancel() { released = true; } }), { status: 401 });
  });
  const result = await readGeminiQuota(ctx);
  assert.equal(result.status, 'error');
  assert.match(result.message, /401.*刷新/);
  assert.equal(released, true);
});
