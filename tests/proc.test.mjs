import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runJsonl, runText } from '../dist/core/proc.js';
import { options, workspace } from './helpers.mjs';

const fixture = fileURLToPath(new URL('fixtures/process.mjs', import.meta.url));

test('POSIX argv supports spaces and shell metacharacters as literal arguments', { skip: process.platform === 'win32' }, async (t) => {
  let output = '';
  for await (const chunk of runText(process.execPath, [fixture, 'hello world', '$(never-run)'], options(workspace(t)))) output += chunk;
  assert.equal(output, 'hello world|$(never-run)');
});

test('JSONL observes exit failures and rejects malformed protocol data', async (t) => {
  for (const mode of ['failure', 'bad-json']) {
    await assert.rejects(async () => {
      for await (const _ of runJsonl(process.execPath, [fixture, mode], options(workspace(t)))) {}
    });
  }
});

test('cancellation kills descendants retaining stdout after their parent exits', { skip: process.platform === 'win32', timeout: 5000 }, async (t) => {
  const ctl = new AbortController();
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await assert.rejects(async () => {
    for await (const chunk of runText(process.execPath, [fixture, 'tree'], options(workspace(t), { signal: ctl.signal }))) {
      pid = Number(chunk.trim());
      ctl.abort();
    }
  });
  assert.ok(pid > 0);
  if (process.platform === 'linux') {
    let state;
    try { state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]; } catch {}
    assert.ok(state === undefined || state === 'Z', `descendant still running: ${state}`);
  } else assert.throws(() => process.kill(pid, 0));
});
