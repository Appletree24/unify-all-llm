import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startComparison, selectPlan } from '../dist/core/workflow.js';
import { historyAfter, loadRun } from '../dist/core/store.js';
import { advisorTrigger } from '../dist/core/advisor.js';
import { aborted, deferred, target, workspace } from './helpers.mjs';

const question = '这个仓库的请求超时后会自动重试吗？';
const draft = '超时会自动重试，最多三次。';
const corrected = '更正：当前实现仅在连接被重置时重试，超时直接返回。';
const line = 'return err.code === "ECONNRESET";';
const report = { verdict: 'disputed', finding: '比较了错误码，超时未进入重试分支。',
  excerpts: [{ path: 'retry.js', line: 2, quote: line }], quotes: [] };
const reader = { askPolicy: 'read-tools', exec: false };
function fixture(t, options = {}) {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'retry.js'), 'function retry(err) {\n' + line + '\n}\n');
  const calls = [];
  const a = target('primary', async function* (req) {
    calls.push(['primary', req]);
    if (req.prompt.startsWith('请结合已核对的证据')) {
      if (options.failedRevision) throw new Error('revision offline');
      assert.match(req.prompt, /ECONNRESET/);
      yield { type: 'done', text: options.revision ?? corrected };
    } else yield { type: 'done', text: options.draft ?? draft };
  }, reader);
  const b = target('reviewer', async function* (req) {
    calls.push(['reviewer', req]);
    if (options.review) yield* options.review(req);
    else yield { type: 'done', text: JSON.stringify(options.report ?? report) };
  }, options.capabilities ?? reader);
  const config = { routing: 'auto', providers: ['primary', 'reviewer'], ...options.config };
  return { cwd, a, b, calls, ask: (overrides = {}) => startComparison({ cwd, config, targets: [a, b], question, ...overrides }) };
}

test('advisor resolves a confident but incorrect repository answer, preserves its draft and persists the revised public answer', async t => {
  const f = fixture(t);
  const run = await f.ask().done;
  assert.deepEqual(run.calls.map(c => c.scope), ['answer', 'advisor', 'advisor-revision']);
  assert.match(f.calls[0][1].prompt, /需独立核对/);
  assert.equal(f.calls[1][1].mode, 'ask');
  assert.equal(f.calls[1][1].interact, undefined);
  assert.equal(run.calls[0].result.text, draft);
  assert.equal(run.advisor.status, 'revised');
  assert.match(run.advisor.evidence[0], /retry.js:2/);
  assert.equal(run.results[0].runId, run.calls[2].id);
  const saved = loadRun(f.cwd, run.id);
  assert.equal(selectPlan(saved).text, corrected);
  assert.match(historyAfter(saved)[0].answer, /更正：[\s\S]*retry\.js:2/);
  assert.equal(readFileSync(join(f.cwd, '.unify', 'runs', run.id, 'answer-primary.md'), 'utf8').trim(), corrected);
  const retry = await f.ask({ config: { routing: 'single', advisor: 'off' }, retry: { record: saved, targetIds: ['primary'] } }).done;
  assert.equal(retry.advisor.status, 'revised');
  assert.equal(retry.calls[0].input.prompt, run.calls[0].input.prompt);
  assert.deepEqual(retry.calls.map(c => c.scope), ['answer', 'advisor', 'advisor-revision']);
});

test('advisor checks source quotes and leaves conflicts, missing evidence, failures and cancellations visible', async t => {
  for (const [options, status, count] of [
    [{ report: { ...report, verdict: 'confirmed' } }, 'confirmed', 2],
    [{ report: { ...report, excerpts: [{ path: 'retry.js', line: 1, quote: line }] } }, 'insufficient', 2],
    [{ report: { ...report, verdict: 'insufficient', finding: '缺少线上超时配置' } }, 'insufficient', 2],
    [{ review: async function* () { yield { type: 'done', text: 'looks good' }; } }, 'failed', 2],
    [{ failedRevision: true }, 'disputed', 3],
    [{ revision: draft }, 'disputed', 3],
    [{ draft: '测试全部通过。', report: { ...report, verdict: 'confirmed' } }, 'insufficient', 2],
    [{ draft: '需独立核对：请求是否超时。需要提供线上日志。' }, 'insufficient', 1],
  ]) {
    const f = fixture(t, options);
    const r = await f.ask().done;
    assert.equal(r.results[0].text, options.draft ?? draft);
    assert.equal(r.advisor.status, status);
    assert.equal(r.calls.length, count);
  }
  const started = deferred();
  const f = fixture(t, { review: async function* ({ signal }) { started.resolve(); await aborted(signal); } });
  const handle = f.ask(); await started.promise; handle.cancel(); const stopped = await handle.done;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.results[0].text, draft);
  assert.deepEqual(stopped.calls.map(c => c.scope), ['answer', 'advisor']);
});

test('advisor respects speaker restrictions, evidence access and the configured reviewer', async t => {
  const f = fixture(t);
  for (const [overrides, status] of [
    [{ routing: 'single' }, 'suggested'],
    [{ question: '只让 primary 回答，这个仓库超时会自动重试吗？' }, 'suggested'],
    [{ question: '这个仓库的超时重试如何处理？不要复核。' }, undefined],
    [{ config: { routing: 'auto', advisor: 'off' } }, undefined],
    [{ config: { routing: 'auto', providers: ['primary'] } }, 'unavailable'],
    [{ config: { routing: 'auto', answerModel: 'primary', providers: ['primary'], advisor: 'reviewer' } }, 'revised'],
    [{ config: { routing: 'auto', answerModel: 'primary', advisor: 'reviewer' }, question: '只让 primary 回答，这个仓库超时会自动重试吗？' }, 'suggested'],
    [{ config: { routing: 'auto', answerModel: 'primary', advisor: 'reviewer' }, question: '不要让 reviewer 回答，这个仓库超时会自动重试吗？' }, 'unavailable'],
  ]) {
    const run = await f.ask(overrides).done;
    assert.equal(run.advisor?.status, status);
    assert.equal(run.calls.filter(c => c.scope === 'advisor').length, Number(status === 'revised'));
  }
  for (const caps of ['text-only', 'unrestricted-command', 'provider-plan']) {
    const f = fixture(t, { capabilities: { askPolicy: caps, exec: false } });
    assert.equal((await f.ask().done).advisor.status, 'unavailable');
  }
  f.b.model = f.a.model = 'same-model';
  assert.equal((await f.ask().done).advisor.status, 'unavailable');
});

test('advisor handles explicit primary doubts and allows text-only review against supplied evidence', async t => {
  const text = 'run 729: timeout did not retry';
  const f = fixture(t, { draft: '需独立核对：超时之后有没有重试？', capabilities: { askPolicy: 'text-only', exec: false },
    report: { verdict: 'confirmed', finding: '日志记录了超时分支。', excerpts: [], quotes: [text] } });
  const result = await f.ask({ question: '核对这次执行。日志：' + text }).done;
  assert.equal(result.advisor.status, 'confirmed');
  assert.deepEqual(result.advisor.evidence, ['输入材料 — ' + text]);
  assert.deepEqual(result.calls.map(c => c.scope), ['answer', 'advisor']);
  for (const [output, expected] of [['12 passed, 0 failed', 'confirmed'], ['12 passed, 2 failed', 'insufficient']]) {
    const log = fixture(t, { draft: '测试全部通过。', report: { verdict: 'confirmed', finding: '已核对测试输出。',
      excerpts: [{ path: 'tests.log', line: 1, quote: output }] } });
    writeFileSync(join(log.cwd, 'tests.log'), output + '\n');
    assert.equal((await log.ask({ question: '请查仓库上次测试的结果。' }).done).advisor.status, expected);
  }
  const easy = fixture(t, { draft: '你好。' });
  assert.equal((await easy.ask({ question: '打个招呼' }).done).advisor, undefined);
  assert.equal(advisorTrigger('需独立核对：原句。', '翻译下文', false), undefined);
  assert.equal(advisorTrigger('如果请求超时，客户端会自动重试。', question, true).claim, '如果请求超时，客户端会自动重试。');
  assert.equal(advisorTrigger('如果测试全部通过，就可以提交。', '下一步做什么', true), undefined);
  assert.match(advisorTrigger('配置里可能有开关。', '请查仓库', true, [{ name: 'read', status: 'failed' }, { name: 'search', status: 'failed' }]).reason, /工具调用失败/);
  assert.equal(advisorTrigger('文案例子“故障已修复”。\n```text\n需独立核对：例子\n```', '润色文字', false), undefined);
});
