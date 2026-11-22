import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readAntigravityQuota } from '../dist/quota/antigravity.js';
import { readClaudeQuota } from '../dist/quota/claude.js';
import { readCodexQuota } from '../dist/quota/codex.js';
import { workspace } from './helpers.mjs';

function fakeCli(t, name, script) {
  const cwd = workspace(t);
  const oldPath = process.env.PATH;
  process.env.PATH = cwd + delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  writeFileSync(join(cwd, name), `#!${process.execPath}
const { createInterface } = require('node:readline');
const send = (value) => console.log(JSON.stringify(value));
const assert = require('node:assert/strict');
createInterface({ input: process.stdin }).on('line', raw => {
  const msg = JSON.parse(raw);
  ${script}
});`, { mode: 0o755 });
  return { cwd, signal: AbortSignal.timeout(5000) };
}

const posix = { skip: process.platform === 'win32' };

test('Antigravity reads quota through the headless command and skips older clients', posix, async (t) => {
  const cwd = workspace(t);
  const previousPath = process.env.PATH;
  process.env.PATH = cwd + delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  const version = join(cwd, 'version');
  writeFileSync(version, '1.1.11');
  writeFileSync(join(cwd, 'agy'), `#!${process.execPath}
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(require('node:fs').readFileSync(${JSON.stringify(version)}, 'utf8'));
} else {
  assert.deepEqual(args, ['--settings', '{"disableSlashCommands":false}', '--disable-slash-commands=false',
    '-p', '/usage', '--output-format', 'json', '--print-timeout', '10s']);
  console.log(JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { name: 'Weekly limit', window: 'weekly', remaining_fraction: 0, reset_time: '2026-11-25T03:56:27Z' },
      { name: 'Five-hour limit', window: '5h', remaining_fraction: 0.425 },
      { name: 'Invalid bucket', remaining_fraction: -1 },
    ] },
    { name: 'Gemini Argon', buckets: [{ name: 'Project window', remaining_fraction: 1 }] },
  ] } } }));
}`, { mode: 0o755 });
  const ctx = { cwd, signal: AbortSignal.timeout(5000) };
  assert.deepEqual(await readAntigravityQuota(ctx), { status: 'ok', limits: [
    { label: 'Gemini Models · 7 天', remaining: 0, unit: '%', resetsAt: '2026-11-25T03:56:27Z' },
    { label: 'Gemini Models · 5 小时', remaining: 42.5, unit: '%' },
    { label: 'Gemini Argon · Project window', remaining: 100, unit: '%' },
  ] });
  writeFileSync(version, '1.1.10');
  assert.equal((await readAntigravityQuota(ctx)).status, 'unavailable');
});

test('Codex reads quota after initialization, preserving distinct buckets and real zeroes', posix, async (t) => {
  const ctx = fakeCli(t, 'codex', `
    assert.deepEqual(process.argv.slice(2), ['app-server']);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method !== 'initialized') {
      assert.equal(msg.method, 'account/rateLimits/read');
      send({ id: msg.id, result: {
        rateLimits: { primary: { usedPercent: 10 } },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000000000 },
            secondary: { usedPercent: 0, windowDurationMins: 10080 }, credits: { balance: '12.5' } },
          spark: { limitName: 'Spark', primary: { usedPercent: 32.1 }, secondary: null }
        }
      } });
    }
  `);
  assert.deepEqual(await readCodexQuota(ctx), { status: 'ok', limits: [
    { label: 'codex · 5 小时', remaining: 0, unit: '%', resetsAt: new Date(2000000000000).toISOString() },
    { label: 'codex · 7 天', remaining: 100, unit: '%' },
    { label: 'codex · 点数', remaining: 12.5, unit: 'credits' },
    { label: 'Spark · 主窗口', remaining: 67.9, unit: '%' },
  ] });
});

test('Claude uses a control request without submitting a model turn, ignores unrelated replies', posix, async (t) => {
  const ctx = fakeCli(t, 'claude', `
    assert.equal(msg.type, 'control_request');
    assert.deepEqual(msg.request, { subtype: 'get_usage', skip_behaviors: true });
    send({ type: 'system', subtype: 'init' });
    send({ type: 'control_response', response: { subtype: 'error', request_id: 'other' } });
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id,
      response: { rate_limits_available: true, rate_limits: {
        five_hour: { utilization: 25, resets_at: '2026-11-19T12:00:00Z' },
        seven_day: { utilization: 100 }, seven_day_sonnet: null,
        model_scoped: [{ display_name: 'Opus', utilization: 0 }]
      } }
    } });
  `);
  assert.deepEqual(await readClaudeQuota(ctx), { status: 'ok', limits: [
    { label: '5 小时', remaining: 75, unit: '%', resetsAt: '2026-11-19T12:00:00.000Z' },
    { label: '7 天', remaining: 0, unit: '%' },
    { label: '7 天 · Opus', remaining: 100, unit: '%' },
  ] });
});

test('missing Claude subscription readings stay unavailable', posix, async (t) => {
  const claude = fakeCli(t, 'claude', `
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id,
      response: { rate_limits_available: false, session: { total_cost_usd: 123 } } } });
  `);
  assert.equal((await readClaudeQuota(claude)).status, 'unavailable');
});

test('Codex protocol errors are sanitized', posix, async (t) => {
  const codex = fakeCli(t, 'codex', `
    send({ id: msg.id, error: { message: 'private details from CLI' } });
  `);
  const error = await readCodexQuota(codex);
  assert.equal(error.status, 'error');
  assert.doesNotMatch(error.message, /private/);
});
