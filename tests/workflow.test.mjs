import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startComparison, startExecution, selectPlan, chooseExecutor } from '../dist/core/workflow.js';
import { historyAfter, listRunIds, loadRun, newRunId } from '../dist/core/store.js';
import { parseConfig } from '../dist/core/config.js';
import { buildRegistry } from '../dist/providers/index.js';
import { extractFinalPlan, synthesisFormatter } from '../dist/core/synth.js';
import { displaySynthesisEvents } from '../dist/ui/synthesis.js';
import { aborted, deferred, target, workspace } from './helpers.mjs';

test('memory references stay with the reporting call, survive reload and are excluded from later prompts', async (t) => {
  const cwd = workspace(t);
  const ref = { source: 'AGENTS.md:8', content: 'TEST_PREFERENCE', effect: '选择了离线方案' };
  const reports = target('reports', async function* ({ prompt }) {
    const tag = prompt.match(/<unify-memory-[\w-]+>$/)[0];
    const text = '使用离线方案。\n' + tag + '\n' + JSON.stringify([ref]);
    for (const ch of text) yield { type: 'delta', text: ch };
    yield { type: 'done', text };
  }, { askPolicy: 'read-tools', exec: true });
  const plain = target('plain', async function* ({ prompt }) {
    assert.doesNotMatch(prompt, /TEST_PREFERENCE/);
    yield { type: 'done', text: '普通回答' };
  });
  let streamed = '';
  const run = await startComparison({
    cwd, question: '选择方案', targets: [reports, plain], selected: ['reports', 'plain'],
    config: { synthesizer: 'plain' },
    onEvent(ev) {
      if (ev.type === 'provider' && ev.targetId === 'reports' && ev.event.type === 'delta') streamed += ev.event.text;
    },
  }).done;
  assert.equal(run.status, 'completed');
  assert.equal(streamed, '使用离线方案。');
  const saved = loadRun(cwd, run.id);
  assert.equal(saved.results[0].text, streamed);
  assert.deepEqual(saved.calls[0].result.memoryReferences, [ref]);
  assert.deepEqual(saved.results[0].memoryReferences, [ref]);
  assert.equal(saved.results[1].memoryReferences, undefined);
  assert.equal(saved.synthesis.result.memoryReferences, undefined);
  assert.doesNotMatch(historyAfter(saved, undefined, 'reports').at(-1).answer, /TEST_PREFERENCE/);
  const md = readFileSync(join(cwd, '.unify', 'runs', saved.id, 'answer-reports.md'), 'utf8');
  assert.match(md, /记忆依据（模型自报）[\s\S]*AGENTS\.md:8[\s\S]*TEST_PREFERENCE[\s\S]*选择了离线方案/);
});

test('unique records, full public history, decision and synthesis input snapshots', async (t) => {
  const cwd = workspace(t);
  const requests = [];
  const answer = (id) => target(id, async function* (req) { requests.push([id, req.prompt]); yield { type: 'done', text: `${id}-answer` }; });
  const decider = target('router', async function* (req) {
    requests.push(['router', req.prompt]); yield { type: 'done', text: '{"providers":["a","b"],"synthesize":true}' };
  });
  const targets = [answer('a'), answer('b'), decider];
  const config = { providers: ['a', 'b'], decider: 'router', synthesizer: 'a' };
  let previous;
  for (const question of ['FIRST', 'SECOND', 'THIRD']) {
    previous = await startComparison({ cwd, question, config, targets, previous }).done;
    assert.equal(previous.status, 'completed');
    assert.equal(loadRun(cwd, previous.id).results.length, 2);
  }
  assert.equal(listRunIds(cwd).length, 3);
  assert.equal(previous.input.history.length, 2);
  for (const call of previous.calls) {
    assert.match(call.input.prompt, /FIRST/);
    assert.match(call.input.prompt, /SECOND/);
    assert.match(call.input.prompt, /THIRD/);
  }
  assert.deepEqual(previous.results.map((r) => r.text), ['a-answer', 'b-answer']);
  assert.equal(new Set(Array.from({ length: 1000 }, newRunId)).size, 1000);
});

test('blind synthesis resolves shuffled references only for readers, including split streaming references', async (t) => {
  const cwd = workspace(t);
  const answer = (text) => async function* () { yield { type: 'done', text }; };
  const first = { ...target('fast', answer('选红色')), model: 'model-one' };
  const second = target('deep', answer('选蓝色'));
  second.adapter.configuration = { type: 'openai', model: 'model-two', baseUrl: 'https://example.test' };
  let raw;
  const judge = target('judge', async function* ({ prompt }) {
    assert.doesNotMatch(prompt, /fast|deep|model-one|model-two/);
    const red = /<answer id="([^"]+)"[^>]*>\n选红色/.exec(prompt)[1];
    const blue = /<answer id="([^"]+)"[^>]*>\n选蓝色/.exec(prompt)[1];
    raw = `单元格 A1。**${red}** 与${blue}不同。首选${red}`;
    for (const type of ['reasoning', 'delta']) for (const text of raw) yield { type, text };
    yield { type: 'done', text: raw };
  });
  const events = [];
  const run = await startComparison({
    cwd, question: '颜色？', targets: [first, second, judge], selected: ['fast', 'deep'], config: { synthesizer: 'judge' },
    onEvent: displaySynthesisEvents((ev) => { if (ev.type === 'provider' && ev.scope === 'synthesis') events.push(ev.event); }),
  }).done;
  assert.equal(run.status, 'completed');
  const expected = '单元格 A1。**model-one** 与model-two不同。首选model-one';
  for (const type of ['reasoning', 'delta', 'done']) {
    assert.equal(events.filter((ev) => ev.type === type).map((ev) => ev.text).join(''), expected);
  }
  assert.equal(events.map((ev) => ev.text).join(''), expected.repeat(3));
  assert.equal(readFileSync(join(cwd, '.unify', 'runs', run.id, 'synthesis.md'), 'utf8'), expected + '\n');
  assert.equal(loadRun(cwd, run.id).synthesis.result.text, raw);
  assert.equal(selectPlan(run).text, expected);
  assert.equal(historyAfter(run)[0].answer, expected);
  assert.equal(run.synthesis.alsoAnswered, false);
  assert.equal(run.synthesis.fallback, undefined);
});

test('historical synthesis resolves only whole labels and distinguishes targets sharing a model', () => {
  const format = synthesisFormatter({
    targets: [{ id: 'fast', model: 'shared' }, { id: 'deep', model: 'shared' }, { id: 'cli', label: 'Codex' }],
    synthesis: { labels: { A1: 'fast', A2: 'deep', A10: 'cli', B: 'legacy' } },
  });
  assert.equal(format('A1和A2 / A10、B；A11 XA1 A1_x'), 'shared（fast）和shared（deep） / Codex、legacy；A11 XA1 A1_x');
});

test('cancelled comparisons persist successful and partial answers and bind execution to that turn', async (t) => {
  const cwd = workspace(t);
  const started = deferred();
  const aDone = deferred();
  const a = target('a', async function* () { yield { type: 'done', text: 'NEW_PLAN' }; aDone.resolve(); });
  const b = target('b', async function* (req) { yield { type: 'delta', text: 'unfinished' }; started.resolve(); await aborted(req.signal); });
  const handle = startComparison({ cwd, question: 'NEW_QUESTION', config: {}, targets: [a, b] });
  await Promise.all([started.promise, aDone.promise]);
  await new Promise(setImmediate);
  handle.cancel();
  const run = await handle.done;
  const stored = loadRun(cwd, run.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.results[0].status, 'succeeded');
  assert.equal(stored.results[1].status, 'cancelled');
  assert.equal(stored.results[1].text, 'unfinished');
  const plan = selectPlan(stored, 'a');
  assert.equal(plan.question, 'NEW_QUESTION');
  assert.equal(plan.text, 'NEW_PLAN');
  let execInput;
  const executor = target('worker', async function* (req) { execInput = req; yield { type: 'done', text: 'implemented' }; }, { askPolicy: 'sandbox-read-only', exec: true });
  const execution = await startExecution({ cwd, config: {}, targets: [executor], source: stored, from: 'a', executor }).done;
  assert.equal(execution.planSource.turnId, stored.id);
  assert.equal(execution.planSource.runId, stored.results[0].runId);
  assert.match(execInput.prompt, /NEW_QUESTION/);
  assert.match(execInput.prompt, /NEW_PLAN/);
  assert.equal(loadRun(cwd, execution.id).kind, 'execution');
});

test('single-target cancellation and retry preserve the original input and records', async (t) => {
  const cwd = workspace(t);
  const bStarted = deferred();
  let attempt = 0;
  let aRuns = 0;
  const a = target('a', async function* () { aRuns++; yield { type: 'done', text: 'a' }; });
  const b = target('b', async function* (req) {
    if (++attempt === 1) { bStarted.resolve(); await aborted(req.signal); }
    else yield { type: 'done', text: 'retried' };
  });
  const handle = startComparison({ cwd, question: 'Q', config: {}, targets: [a, b] });
  await bStarted.promise;
  assert.equal(handle.cancelTarget('b'), true);
  const run = await handle.done;
  assert.equal(run.status, 'partial');
  const retry = await startComparison({ cwd, config: {}, targets: [a, b], question: 'ignored', retry: { record: run, targetIds: ['b'] } }).done;
  assert.equal(aRuns, 1);
  assert.equal(retry.results[0].text, 'retried');
  assert.equal(retry.input.prompt, run.input.prompt);
  assert.equal(retry.retryOf, run.id);
  assert.equal(loadRun(cwd, run.id).results[1].status, 'cancelled');
});

test('decision cancellation is saved and never starts answering', async (t) => {
  const cwd = workspace(t);
  const ready = deferred();
  let answered = false;
  const answer = async function* () { answered = true; yield { type: 'done', text: 'a' }; };
  const router = target('router', async function* (req) { ready.resolve(); await aborted(req.signal); });
  const h = startComparison({ cwd, question: 'Q', config: { providers: ['a', 'b'], decider: 'router' }, targets: [target('a', answer), target('b', answer), router] });
  await ready.promise;
  h.cancel();
  const record = await h.done;
  assert.equal(record.status, 'cancelled');
  assert.equal(loadRun(cwd, record.id).calls[0].result.status, 'cancelled');
  assert.equal(answered, false);
});

test('invalid decisions fall back; display failures do not affect outcomes', async (t) => {
  const cwd = workspace(t);
  const answer = async function* () { yield { type: 'done', text: 'answer' }; };
  const run = await startComparison({
    cwd, question: 'Q', config: { providers: ['a', 'b'], decider: 'router' },
    targets: [target('a', answer), target('b', answer), target('router', async function* () { throw new Error('down'); })],
    onEvent: () => { throw new Error('broken renderer'); },
  }).done;
  assert.equal(run.status, 'completed');
  assert.equal(run.results.length, 2);
  assert.ok(run.observerErrors.length > 0);
});

test('opt-in routing sends direct requests once and prefers readers and the previous answer model', async (t) => {
  const cwd = workspace(t);
  const answer = async function* () { yield { type: 'done', text: '完成' }; };
  const plain = target('plain', answer);
  const reader = target('reader', answer, { askPolicy: 'sandbox-read-only', exec: true });
  const router = target('router', async function* () { assert.fail('a direct request must skip the decider'); });
  const config = { routing: 'auto', providers: ['plain', 'reader'], decider: 'router' };
  const opts = { cwd, config, targets: [plain, reader, router] };
  const direct = await startComparison({ ...opts, question: '把下文压到 200 字：\n\n让两个模型分别给意见' }).done;
  assert.deepEqual(direct.calls.map(c => [c.scope, c.target.id]), [['answer', 'plain']]);
  const repo = await startComparison({ ...opts, question: '查一下源码中的重试逻辑，给我代码行号' }).done;
  assert.deepEqual(repo.calls.map(c => c.target.id), ['reader']);
  const follow = await startComparison({ ...opts, question: '把刚才的解释压到 200 字', previous: repo }).done;
  assert.deepEqual(follow.calls.map(c => c.target.id), ['reader']);
  assert.match(loadRun(cwd, follow.id).routing.reason, /沿用/);
});

test('auto compares concrete alternatives and honors named models, synthesis and manual overrides', async (t) => {
  const cwd = workspace(t);
  const answer = async function* () { yield { type: 'done', text: '有条件的方案' }; };
  const a = target('codex', answer);
  const b = target('gemini-pro', answer);
  const c = target('third', answer);
  const config = { routing: 'auto', providers: [a.id, b.id, c.id], synthesizer: c.id };
  const opts = { cwd, config, targets: [a, b, c] };
  const compare = await startComparison({ ...opts, question: '双写迁移和停机迁移怎么选？上线窗口只有十分钟，优先考虑回滚风险' }).done;
  assert.deepEqual(compare.calls.map(call => call.scope), ['answer', 'answer', 'synthesis']);
  const raw = await startComparison({ ...opts, question: '让 Codex 和 Gemini 分别给意见，只看原答' }).done;
  assert.deepEqual(raw.calls.map(call => call.target.id), [a.id, b.id]);
  assert.equal(raw.synthesis, undefined);
  const manual = await startComparison({ ...opts, question: '翻译这句话', selected: [a.id, c.id], manualSelection: true, synthesize: false }).done;
  assert.deepEqual(manual.calls.map(call => call.target.id), [a.id, c.id]);
  const single = await startComparison({ ...opts, routing: 'single', question: '让两个模型分别给意见' }).done;
  assert.equal(single.calls.length, 1);
  const multi = await startComparison({ ...opts, routing: 'multi', synthesize: false, question: '一句话总结' }).done;
  assert.deepEqual(multi.calls.map(call => call.target.id), [a.id, b.id, c.id]);
});

test('auto respects the requested speakers, evidence and number of independent opinions', async (t) => {
  const answer = async function* () { yield { type: 'done', text: '回答' }; };
  const plain = target('plain', answer);
  const codex = target('codex', answer, { askPolicy: 'sandbox-read-only', exec: true });
  const gemini = target('gemini-pro', answer);
  const router = target('router', async function* () {
    yield { type: 'done', text: '{"providers":["plain"],"synthesize":false}' };
  });
  const opts = { cwd: workspace(t), config: { providers: ['plain', 'codex', 'gemini-pro'], routing: 'auto', decider: 'router' },
    targets: [plain, codex, gemini, router] };
  // Assert every call, including unwanted decisions and post-answer work.
  for (const [question, ids] of [
    ['只让 Codex 回答这个问题', ['codex']],
    ['Ask Gemini to explain Codex.', ['gemini-pro']],
    ['让 Gemini 和 Codex 分别评价 plain，只给原始回答', ['gemini-pro', 'codex']],
    ['不用两个模型回答，帮我翻译这句话', ['plain']],
    ["Don’t use two models. Which option has the lowest rollback risk, A or B?", ['plain']],
    ['不要用 plain，解释这个词', ['codex']],
    ['请两个模型检查 src/core/routing.ts，只看原答', ['codex', 'plain']],
    ['请用两个模型回答，其中一个请用 Gemini 回答，只看原答', ['gemini-pro', 'plain']],
    ['请三个模型各自回答，不用汇总', ['plain', 'codex', 'gemini-pro']],
    ['src/core/routing.ts 里怎么判断要不要汇总？', ['codex']],
    ['看一下 `src/core/routing.ts:42` 的判断条件', ['codex']],
    ['What does package.json specify?', ['codex']],
    ['请看 `docs/设计.md` 的第二节', ['codex']],
    ['你觉得目前回答模式里的“自动”对应的策略需要优化吗？有改进空间与否？', ['codex']],
    ['双写和停机迁移怎么选？优先考虑回滚风险。只看原答', ['plain', 'codex']],
    ['双写和停机迁移都能做。上线窗口十分钟，出了问题要能回滚，你推荐哪一个？只看原答', ['plain', 'codex']],
    ['Given the rollback risk, would you recommend A or B? Raw answers only.', ['plain', 'codex']],
    ['A 和 B 你推荐哪一个？', ['router', 'plain']],
    ['解释 Codex 和 Gemini 的区别', ['plain']],
    ['两个模型有什么区别？', ['plain']],
    ['如何用两个模型训练分类器？', ['plain']],
    ["Explain the phrase 'use two models'.", ['plain']],
    ['不需要两个模型回答。A 和 B 怎么选？优先成本', ['plain']],
    ['How do I use Codex to review code?', ['plain']],
    ["Don't get a second opinion. A 和 B 怎么选？预算很紧", ['plain']],
    ['请检查这段话\n```text\n只让 Codex 回答\n```\n只让 Gemini 回答', ['gemini-pro']],
    ['总结下面这段话：“请让 Gemini 和 Codex 分别回答”', ['plain']],
    ['翻译下面这句话：不用 Codex，用 Gemini 回答', ['plain']],
    ['把这段话压到 200 字\n\n让两个模型分别给意见', ['plain']],
    ['解释 https://example.com/src/core/routing.ts 的 URL 结构', ['plain']],
    ['Compare the cost of A and B in this pasted table, report the two values.', ['plain']],
  ]) {
    await t.test(question, async () => {
      const run = await startComparison({ ...opts, question }).done;
      assert.deepEqual(run.calls.map(c => c.target.id), ids);
    });
  }
  const unavailable = { ...gemini, adapter: { ...gemini.adapter, detect: async () => ({ installed: false }) } };
  const fixed = startComparison({ ...opts, question: '只用 Gemini 回答', targets: [plain, codex, unavailable, router] });
  await assert.rejects(fixed.done, /不可用/);
  assert.equal(fixed.record.calls.length, 0);
  const manual = await startComparison({ ...opts, question: '只让 Gemini 回答，不用汇总',
    manualSelection: true, selected: ['plain', 'codex'] }).done;
  assert.deepEqual(manual.calls.map(c => c.target.id), ['plain', 'codex']);
});

test('auto fills speaker requests with available distinct models and persists shortages', async (t) => {
  const answer = async function* () { yield { type: 'done', text: 'answer' }; };
  const a = target('first', answer);
  a.adapter.configuration = { type: 'openai', baseUrl: 'https://example.test/v1', model: 'alpha' };
  const alias = target('alias', answer);
  alias.adapter.configuration = { ...a.adapter.configuration, baseUrl: 'https://example.test/v1/' };
  const b = target('other', answer);
  const offline = target('offline', answer);
  offline.adapter.detect = async () => ({ installed: false });
  const opts = { cwd: workspace(t), config: { routing: 'auto' }, targets: [a, alias, offline, b] };
  const run = await startComparison({ ...opts, question: '请三个模型回答，只看原答' }).done;
  assert.deepEqual(run.calls.map(c => c.target.id), ['first', 'other']);
  assert.match(loadRun(opts.cwd, run.id).routing.reason, /2 个/);
  const named = await startComparison({ ...opts, selected: [], question: '只让 other 回答' }).done;
  assert.deepEqual(named.calls.map(c => c.target.id), ['other']);
});

test('direct auto turns probe their explicit speaker and keep it for a requested follow-up', async (t) => {
  const probes = [];
  const targets = ['default', 'named', 'router', 'synth', 'unused'].map(id => {
    const t = target(id, async function* () { yield { type: 'done', text: 'answer' }; });
    t.adapter.detect = async () => { probes.push(id); return { installed: true }; };
    return t;
  });
  const opts = { cwd: workspace(t), config: { routing: 'auto', providers: ['default'], decider: 'router', synthesizer: 'synth' }, targets };
  const first = await startComparison({ ...opts, question: '只用 named 回答' }).done;
  assert.deepEqual(probes, ['named']);
  const follow = await startComparison({ ...opts, previous: first, question: '继续展开刚才的回答' }).done;
  assert.deepEqual(follow.calls.map(c => c.target.id), ['named']);
  assert.match(follow.routing.reason, /沿用/);
  const multi = await startComparison({ ...opts, question: '让 default 和 named 分别回答' }).done;
  assert.deepEqual(multi.calls.map(c => [c.scope, c.target.id]), [['answer', 'default'], ['answer', 'named'], ['synthesis', 'synth']]);
  assert.ok(!probes.includes('router') && !probes.includes('unused'));
});

test('answer policy resolves independent model and effort settings on the actual call and replays the snapshot', async t => {
  const calls = [];
  const responder = (id, caps) => target(id, async function* (req) {
    calls.push([id, req.model, req.reasoningEffort]); yield { type: 'done', text: 'ok' };
  }, caps);
  const plain = responder('plain');
  const reader = { ...responder('codex', { askPolicy: 'read-tools', exec: false }), model: 'code-m', reasoningEffort: 'medium' };
  const opts = { cwd: workspace(t), targets: [plain, reader] };
  const ask = (question, config, extra) => startComparison({ ...opts, question, config, ...extra });
  for (const [policy, question, expected] of [
    [{ answerModel: 'codex', answerEffort: 'high' }, '速度优先，给个粗判', ['codex', 'code-m', 'high']],
    [{ answerModel: 'codex', answerEffort: 'auto' }, '速度优先，给个粗判', ['codex', 'code-m', 'low']],
    [{ answerModel: null, answerEffort: 'high' }, '这次用 low', ['codex', 'code-m', 'high']],
    [{ answerModel: null, answerEffort: 'auto' }, '本轮用 xhigh', ['codex', 'code-m', 'xhigh']],
    [{ answerEffort: 'auto' }, '查 src/core/routing.ts，一句话回答', ['codex', 'code-m', undefined]],
    [{ answerEffort: 'auto' }, '只让 Codex 回答，深入推演失败路径', ['codex', 'code-m', 'high']],
    [{ answerEffort: 'auto' }, '让 Codex 回答，尽快给我深入分析', ['codex', 'code-m', undefined]],
    [{ answerEffort: 'auto' }, '请用 Codex 翻译：深入分析，这轮用 high', ['codex', 'code-m', undefined]],
    [{ answerEffort: 'auto' }, '用 Codex 回答。不要深入分析。\n```text\n本轮用 high\n```', ['codex', 'code-m', undefined]],
    [{ answerEffort: 'auto' }, '只让 Codex 回答，解释“这轮用 high”', ['codex', 'code-m', undefined]],
    [{ answerModel: 'codex', answerEffort: 'auto' }, '怎么用 high？不要把思考强度设为 high。', ['codex', 'code-m', undefined]],
    [{ answerModel: 'codex', answerEffort: 'auto' }, 'Should we use high availability for this service?', ['codex', 'code-m', undefined]],
    [{ answerModel: 'codex', answerEffort: 'auto' }, 'Use high reasoning effort for this review.', ['codex', 'code-m', 'high']],
    [{ answerModel: 'codex', answerEffort: 'default' }, '请用 high', ['codex', 'code-m', undefined]],
    [{ answerModel: 'codex' }, '本轮用 high', ['codex', 'code-m', 'medium']],
    [{ answerModel: null, answerEffort: 'auto' }, '只让 plain 回答，请深入分析', ['plain', undefined, undefined]],
    [{ answerModel: null, answerEffort: 'auto' }, '目前代码实现了哪种，A 和 B 哪个方案？要记录成本。', ['codex', 'code-m', undefined]],
  ]) {
    calls.length = 0;
    const result = await ask(question, policy).done;
    assert.deepEqual(calls, [expected], question);
    assert.deepEqual(loadRun(opts.cwd, result.id).routing.answers.map(a => [a.targetId, a.model, a.level]), [expected]);
  }
  const first = await ask('查源码，这轮用 high', { answerEffort: 'auto' }).done;
  const follow = await ask('继续，一句话', { answerEffort: 'auto' }, { previous: first }).done;
  assert.equal(follow.calls[0].target.reasoningEffort, undefined);
  const retry = await ask('', { answerModel: 'plain', answerEffort: 'low' }, {
    retry: { record: loadRun(opts.cwd, first.id), targetIds: ['codex'] },
  }).done;
  assert.deepEqual(calls.at(-1), ['codex', 'code-m', 'high']);
  assert.deepEqual(retry.routing.answers, first.routing.answers);
  assert.equal(reader.reasoningEffort, 'medium');
  for (const [config, question] of [
    [{ answerModel: 'plain', answerEffort: 'high' }, '问个问题'],
    [{ answerEffort: 'auto' }, '只让 plain 回答，本轮用 high'],
    [{ providers: ['plain'], answerEffort: 'high' }, '问个问题'],
  ]) {
    const run = ask(question, config);
    await assert.rejects(run.done, /思考强度 high/);
    assert.equal(run.record.calls.length, 0);
  }
});

test('automatic effort preserves higher defaults and resolves Gemini effort to an advertised same-family ID', async () => {
  const { resolveAnswerEffort } = await import('../dist/core/answer-effort.js');
  const { independentTargets } = await import('../dist/core/routing.js');
  const { parseAgyModels } = await import('../dist/providers/agy-models.js');
  const codex = { ...target('codex', async function* () {}), defaultEffort: 'xhigh' };
  assert.equal(resolveAnswerEffort(codex, 'auto', { level: 'high', exact: false }, []).target.reasoningEffort, undefined);
  const gemini = { ...target('gemini-pro', async function* () {}, { askPolicy: 'provider-plan' }), model: 'g-medium' };
  const catalog = parseAgyModels('g-medium\tModel (medium)\ng-high\tModel (high)\nother-low\tOther (low)');
  const resolved = resolveAnswerEffort(gemini, 'high', undefined, catalog);
  assert.equal(resolved.target.model, 'g-high');
  assert.equal(resolved.target.reasoningEffort, undefined);
  assert.equal(resolved.choice.level, 'high');
  assert.equal(resolveAnswerEffort(gemini, 'low', undefined, catalog), undefined);
  const alias = { ...gemini, id: 'same-model', model: 'g-high' };
  const other = { ...gemini, id: 'different-model', model: 'other-low' };
  assert.deepEqual(independentTargets([gemini], [gemini, alias, other], 2), [gemini, other]);
});

test('answer policy preserves configured synthesis effort and the original policy for a later opinion', async t => {
  const answer = async function* ({ reasoningEffort }) { yield { type: 'done', text: reasoningEffort ?? 'native' }; };
  const codex = { ...target('codex', answer), reasoningEffort: 'high' };
  const claude = { ...target('claude', answer), reasoningEffort: 'medium' };
  const offline = target('offline', answer);
  offline.adapter.detect = async () => ({ installed: false });
  const opts = { cwd: workspace(t), targets: [codex, claude, offline] };
  const config = { providers: ['codex', 'claude'], synthesizer: 'offline', answerEffort: 'low' };
  const multi = await startComparison({ ...opts, question: '给两个独立意见', config: { ...config, routing: 'multi' } }).done;
  assert.deepEqual(multi.calls.map(c => [c.scope, c.target.id, c.result.text]), [
    ['answer', 'codex', 'low'], ['answer', 'claude', 'low'], ['synthesis', 'codex', 'high'],
  ]);
  const retry = await startComparison({ ...opts, question: '', config: { ...config, answerEffort: 'high' },
    retry: { record: loadRun(opts.cwd, multi.id), targetIds: ['codex', 'claude'] } }).done;
  assert.deepEqual(retry.calls.map(c => [c.scope, c.result.text]), [['answer', 'low'], ['answer', 'low'], ['synthesis', 'high']]);
  const original = await startComparison({ ...opts, question: '给个判断', config: { ...config, routing: 'single' } }).done;
  const opinion = await startComparison({ ...opts, question: '', config: { ...config, answerEffort: 'high' },
    supplement: { source: original, action: 'opinion' } }).done;
  assert.deepEqual(opinion.calls.map(c => [c.scope, c.target.id, c.result.text]), [['answer', 'claude', 'low']]);
  assert.deepEqual(opinion.routing.answers.map(a => [a.targetId, a.level]), [['codex', 'low'], ['claude', 'low']]);
});

test('the auto decider runs only for ambiguous choices and fails back to one answer', async (t) => {
  const cwd = workspace(t);
  const answer = async function* () { yield { type: 'done', text: '回答' }; };
  const router = target('router', async function* () { throw new Error('down'); });
  const run = await startComparison({
    cwd, config: { routing: 'auto', providers: ['a', 'b'], decider: router.id },
    question: '方案 A 和方案 B 怎么选？', targets: [target('a', answer), target('b', answer), router],
  }).done;
  assert.deepEqual(run.calls.map(c => [c.scope, c.target.id]), [['decision', 'router'], ['answer', 'a']]);
  assert.match(run.routing.reason, /无可用结果/);
});

test('an additional opinion and deferred synthesis reuse independent answers and the original history', async (t) => {
  const cwd = workspace(t);
  const a = target('a', async function* () { yield { type: 'done', text: '首答正文' }; });
  const b = target('b', async function* ({ prompt }) {
    assert.match(prompt, /原问题/);
    assert.match(prompt, /前文/);
    assert.doesNotMatch(prompt, /首答正文/);
    yield { type: 'done', text: '第二意见' };
  });
  const judge = target('judge', async function* ({ prompt }) {
    assert.match(prompt, /首答正文/);
    assert.match(prompt, /第二意见/);
    yield { type: 'done', text: '汇总正文' };
  });
  const opts = { cwd, config: { providers: ['a'], synthesizer: 'judge', routing: 'auto' }, targets: [a, b, judge] };
  const original = await startComparison({ ...opts, question: '原问题', handoff: { turnId: 'earlier', question: '前文', answer: '背景' } }).done;
  const opinion = await startComparison({ ...opts, question: '', supplement: { source: original, action: 'opinion' } }).done;
  assert.equal(opinion.supplementOf, original.id);
  assert.deepEqual(opinion.calls.map(c => [c.scope, c.target.id]), [['answer', 'b']]);
  assert.equal(opinion.results[0].runId, original.results[0].runId);
  assert.equal(selectPlan(opinion, 'a').text, '首答正文');
  assert.equal(historyAfter(opinion, undefined, 'b').at(-1).answer, '第二意见');
  assert.throws(() => startComparison({ ...opts, question: '', supplement: { source: original, action: 'opinion' } }), /最新/);
  const synthesis = await startComparison({ ...opts, question: '', supplement: { source: opinion, action: 'synthesis' } }).done;
  assert.deepEqual(synthesis.calls.map(c => c.scope), ['synthesis']);
  assert.deepEqual(synthesis.results.map(r => r.runId), opinion.results.map(r => r.runId));
  assert.equal(loadRun(cwd, synthesis.id).synthesis.result.text, '汇总正文');
  assert.equal(loadRun(cwd, original.id).results.length, 1);
});

test('orphaned records expose interruption without rewriting history', async (t) => {
  const cwd = workspace(t);
  const run = await startComparison({ cwd, config: {}, question: 'Q', targets: [target('a', async function* () { yield { type: 'done', text: 'answer' }; })] }).done;
  const path = join(cwd, '.unify', 'runs', run.id, 'run.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.status = 'answering'; raw.owner = undefined;
  raw.results[0].status = 'running'; raw.results[0].ok = false;
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(loadRun(cwd, run.id).results[0].status, 'interrupted');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'answering');
});

test('config validates references, duplicates, capabilities and independent model targets', () => {
  for (const config of [{ timeoutSec: Infinity }, { concurrency: 0 }, { disableClaude: 'true' }, { providers: ['a', 'a'] }, { typo: 1 }]) assert.throws(() => parseConfig(config));
  assert.throws(() => buildRegistry({ providers: ['missing'] }));
  assert.throws(() => buildRegistry({ custom: { api: { type: 'openai', baseUrl: 'https://example.com/v1', model: 'x' } }, executor: 'api' }));
  const reg = buildRegistry({ disableClaude: true, targets: { fast: { provider: 'codex', model: 'm1' }, deep: { provider: 'codex', model: 'm2' } } });
  assert.equal(reg.fast.adapter, reg.deep.adapter);
  assert.equal(reg.fast.model, 'm1');
  assert.equal(reg.deep.model, 'm2');
  assert.throws(() => chooseExecutor(Object.values(reg), 'missing', new Map()));
});

test('storage failure stops queued work and prevents synthesis', async (t) => {
  const cwd = workspace(t);
  let laterStarted = false, broken = false;
  const h = startComparison({
    cwd, question: 'Q', config: { concurrency: 1 },
    targets: [
      target('a', async function* () { yield { type: 'delta', text: 'partial' }; yield { type: 'done', text: 'a' }; }),
      target('b', async function* () { laterStarted = true; yield { type: 'done', text: 'b' }; }),
    ],
    onEvent(event) {
      if (event.type === 'provider' && event.event.type === 'delta' && !broken) {
        broken = true;
        const path = join(cwd, '.unify', 'runs', event.turnId, 'run.json');
        rmSync(path);
        mkdirSync(path);
      }
    },
  });
  await assert.rejects(h.done);
  assert.equal(laterStarted, false);
  assert.equal(h.record.status, 'failed');
  assert.equal(h.record.synthesis, undefined);
});

test('synthesis cancellation retains anonymous mapping, partial output, and completed answers', async (t) => {
  const cwd = workspace(t), ready = deferred();
  const a = target('a', async function* (req) {
    if (req.prompt.startsWith('你是一名严谨')) {
      yield { type: 'delta', text: 'partial synthesis' };
      ready.resolve(); await aborted(req.signal);
    } else yield { type: 'done', text: 'a' };
  });
  const b = target('b', async function* () { yield { type: 'done', text: 'b' }; });
  const h = startComparison({ cwd, question: 'Q', config: { synthesizer: 'a' }, targets: [a, b] });
  await ready.promise;
  const live = loadRun(cwd, h.record.id);
  assert.equal(live.status, 'synthesizing');
  assert.deepEqual(Object.values(live.synthesis.labels).sort(), ['a', 'b']);
  h.cancel();
  const run = await h.done;
  assert.equal(run.synthesis.result.status, 'cancelled');
  assert.equal(run.synthesis.result.text, 'partial synthesis');
  assert.ok(run.results.every((r) => r.ok));
});

test('availability detection receives cancellation before any model invocation', async (t) => {
  const ready = deferred();
  const a = target('a', async function* () { assert.fail('model must not start'); });
  a.adapter.detect = async (signal) => { ready.resolve(); await aborted(signal); return { installed: false }; };
  const h = startComparison({ cwd: workspace(t), config: {}, question: 'Q', targets: [a] });
  await ready.promise; h.cancel();
  assert.equal((await h.done).status, 'cancelled');
});

test('legacy records remain readable and executable without rewriting the original', (t) => {
  const cwd = workspace(t), id = '20261117-110000';
  const dir = join(cwd, '.unify', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const contents = JSON.stringify({ id, createdAt: '2026-11-17T11:00:00Z', question: 'old question', results: [
    { provider: 'codex', ok: true, text: 'old plan', reasoning: '', durationMs: 1 },
  ] });
  writeFileSync(join(dir, 'run.json'), contents);
  assert.equal(selectPlan(loadRun(cwd, id)).text, 'old plan');
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), contents);
});

test('custom target configuration survives persistence and supports an unchanged retry', async (t) => {
  const cwd = workspace(t);
  const config = { custom: { local: { type: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fake', system: 'system' } }, providers: ['local'] };
  const targets = [buildRegistry(config).local];
  targets[0].adapter.run = async function* () { yield { type: 'done', text: 'fixture' }; };
  const run = await startComparison({ cwd, config, targets, question: 'Q' }).done;
  const stored = loadRun(cwd, run.id);
  assert.equal(stored.calls[0].target.configuration.system, 'system');
  const retry = await startComparison({ cwd, config, targets, question: '', retry: { record: stored, targetIds: ['local'] } }).done;
  assert.equal(retry.status, 'completed');
});

test('extractFinalPlan and selectPlan isolate final answer, resolve references, and handle fences/fallback', async (t) => {
  const withFence = [
    '## 共识',
    '一致观点',
    '## 分歧',
    '拒绝方案 X',
    '```markdown',
    '## 最终答案',
    '这不是标题，在代码块里',
    '```',
    '## 最终答案',
    '采用 [ref:1] 的做法。',
    '### 步骤 1',
    '修改 core.ts',
    '## 附注',
    '额外说明',
  ].join('\n');
  assert.equal(extractFinalPlan(withFence), '采用 [ref:1] 的做法。\n### 步骤 1\n修改 core.ts');
  assert.equal(extractFinalPlan('没有标题的纯文本'), '没有标题的纯文本');

  const cwd = workspace(t);
  const a = { ...target('a', async function* () { yield { type: 'done', text: '方案 A 原文' }; }), model: 'alpha-model' };
  const b = { ...target('b', async function* () { yield { type: 'done', text: '方案 B 原文' }; }), model: 'beta-model' };
  const judge = target('judge', async function* ({ prompt }) {
    const aRef = /<answer id="([^"]+)"[^>]*>\n方案 A 原文/.exec(prompt)[1];
    const bRef = /<answer id="([^"]+)"[^>]*>\n方案 B 原文/.exec(prompt)[1];
    yield {
      type: 'done',
      text: `## 共识\n无\n\n## 分歧\n${aRef} 与 ${bRef} 意见相反，否决 ${bRef}\n\n## 独有亮点\n无\n\n## 最终答案\n按 ${aRef} 执行。\n### 验证\n运行测试`,
    };
  });
  const run = await startComparison({
    cwd, question: '选哪个方案', targets: [a, b, judge], selected: ['a', 'b'], config: { synthesizer: 'judge' },
  }).done;

  const synthPlan = selectPlan(run);
  assert.equal(synthPlan.text, '按 alpha-model 执行。\n### 验证\n运行测试');
  assert.doesNotMatch(synthPlan.text, /\[ref:\d+\]|否决|分歧/);

  const directPlan = selectPlan(run, 'b');
  assert.equal(directPlan.text, '方案 B 原文');
});

test('follow-up conversation inherits executed plan choice instead of rejected synthesis, and ignores cancelled execs', async (t) => {
  const cwd = workspace(t);
  const prompts = [];
  const a = target('a', async function* (req) {
    prompts.push(['a', req.prompt]);
    yield { type: 'done', text: 'PLAN_A_DETAILS' };
  });
  const b = target('b', async function* (req) {
    prompts.push(['b', req.prompt]);
    yield { type: 'done', text: 'PLAN_B_DETAILS' };
  });
  const judge = target('judge', async function* ({ prompt }) {
    const aRef = /<answer id="([^"]+)"[^>]*>\nPLAN_A_DETAILS/.exec(prompt)?.[1] ?? '[ref:1]';
    yield { type: 'done', text: `## 分歧\n分歧说明\n## 最终答案\n推荐 ${aRef} 的 PLAN_A_DETAILS` };
  });
  const executor = target('worker', async function* (req) {
    if (req.prompt.includes('PLAN_A_DETAILS')) {
      yield { type: 'delta', text: 'starting...' };
      await aborted(req.signal);
    }
    yield { type: 'done', text: '已按 B 完成改动，测试通过' };
  }, { askPolicy: 'sandbox-read-only', exec: true });

  const turn1 = await startComparison({
    cwd, question: '重构缓存', targets: [a, b, judge], selected: ['a', 'b'], config: { synthesizer: 'judge' },
  }).done;

  // Execute B successfully
  const execB = await startExecution({ cwd, config: {}, targets: [executor], source: turn1, from: 'b', executor }).done;
  assert.equal(execB.status, 'completed');
  assert.equal(execB.planSource.planText, 'PLAN_B_DETAILS');

  // Later start an accidental execution on synthesis and immediately cancel it — should not override execB
  const cancelledHandle = startExecution({ cwd, config: {}, targets: [executor], source: turn1, executor });
  cancelledHandle.cancel();
  const cancelledExec = await cancelledHandle.done;
  assert.equal(cancelledExec.status, 'cancelled');

  // Follow-up question continuing from turn1 must inherit B's plan and execution outcome, not A's synthesis
  prompts.length = 0;
  const turn2 = await startComparison({
    cwd, question: '下一步优化什么', targets: [a, b, judge], selected: ['a', 'b'],
    config: { synthesizer: 'judge' }, previous: turn1,
  }).done;

  assert.equal(turn2.parentTurnId, execB.id);
  assert.equal(turn2.input.history.length, 1);
  assert.match(turn2.input.history[0].answer, /PLAN_B_DETAILS/);
  assert.match(turn2.input.history[0].answer, /已按 B 完成改动/);
  assert.doesNotMatch(turn2.input.history[0].answer, /PLAN_A_DETAILS|\[ref:\d+\]/);
  for (const [, prompt] of prompts) {
    assert.match(prompt, /PLAN_B_DETAILS/);
    assert.doesNotMatch(prompt, /PLAN_A_DETAILS|\[ref:\d+\]/);
  }
});

test('tool events persist on run results and synthesizer fallback prefers repo-reading targets with metadata', async (t) => {
  const cwd = workspace(t);
  const apiTarget = target('api', async function* () {
    yield { type: 'done', text: 'api answer' };
  }, { askPolicy: 'text-only', exec: false });
  const cliTarget = target('cli', async function* (req) {
    if (req.prompt.startsWith('你是一名严谨')) {
      yield { type: 'tool', name: 'Read', detail: 'src/core/workflow.ts' };
      yield { type: 'done', text: '## 最终答案\n核实后的结论' };
      return;
    }
    yield { type: 'tool', name: 'Grep', detail: 'selectPlan' };
    yield { type: 'tool', name: 'Read', detail: '  src/core/store.ts  ' };
    yield { type: 'done', text: 'cli answer' };
  }, { askPolicy: 'read-tools', exec: true });
  const unavailableSynth = target('claude', async function* () {
    assert.fail('unavailable synthesizer must not run');
  });
  unavailableSynth.adapter.detect = async () => ({ installed: false });

  const notices = [];
  const run = await startComparison({
    cwd, question: '检查实现', targets: [apiTarget, cliTarget, unavailableSynth],
    selected: ['api', 'cli'], config: { synthesizer: 'claude' },
    onEvent: (ev) => { if (ev.type === 'notice') notices.push(ev.message); },
  }).done;

  const stored = loadRun(cwd, run.id);
  assert.deepEqual(stored.results.find((r) => r.targetId === 'cli').tools, [
    { name: 'Grep', detail: 'selectPlan' },
    { name: 'Read', detail: 'src/core/store.ts' },
  ]);
  assert.equal(stored.results.find((r) => r.targetId === 'api').tools, undefined);
  // Fallback skipped text-only apiTarget and chose repo-reading cliTarget
  assert.equal(stored.synthesis.provider, 'cli');
  assert.equal(stored.synthesis.preferredProvider, 'claude');
  assert.equal(stored.synthesis.fallback, true);
  assert.equal(stored.synthesis.alsoAnswered, true);
  assert.deepEqual(stored.synthesis.result.tools, [{ name: 'Read', detail: 'src/core/workflow.ts' }]);
  assert.ok(notices.some((m) => m.includes('已回退') && m.includes('同时参与了答题')));
});

test('text-only targets and synthesizer receive referenced @files safely and anonymous evidence metadata', async (t) => {
  const cwd = workspace(t);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'app.ts'), 'export const MAGIC_CONST = 42;\n');
  writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  // File outside workspace must never be read via path traversal
  writeFileSync(join(cwd, '..', 'outside-secret.txt'), 'TOP_SECRET');

  let cliPrompt = '';
  let apiPrompt = '';
  let synthPrompt = '';
  const cli = target('cli', async function* (req) {
    cliPrompt = req.prompt;
    yield { type: 'tool', name: 'Read', detail: 'src/app.ts' };
    yield { type: 'done', text: 'CLI 实读结论' };
  }, { askPolicy: 'read-tools', exec: true });
  const api = target('api', async function* (req) {
    apiPrompt = req.prompt;
    yield { type: 'done', text: 'API 结合附带文件结论' };
  }, { askPolicy: 'text-only', exec: false });
  const synth = target('judge', async function* (req) {
    synthPrompt = req.prompt;
    yield { type: 'done', text: '## 最终答案\n综合结论' };
  }, { askPolicy: 'text-only', exec: false });

  const notices = [];
  const run = await startComparison({
    cwd,
    question: '请检查 @src/app.ts 和 @bin.dat 以及 @../outside-secret.txt',
    targets: [cli, api, synth],
    selected: ['cli', 'api'],
    config: { synthesizer: 'judge' },
    onEvent: (ev) => { if (ev.type === 'notice') notices.push(ev.message); },
  }).done;

  assert.equal(run.status, 'completed');
  // CLI already has workspace read access, so its prompt stays lean
  assert.doesNotMatch(cliPrompt, /<attached_file/);
  // text-only API receives the inlined text file, skips binary and traversal
  assert.match(apiPrompt, /<attached_file path="src\/app\.ts">[\s\S]*MAGIC_CONST = 42/);
  assert.doesNotMatch(apiPrompt, /<attached_file path="bin\.dat"|TOP_SECRET/);
  // text-only synthesizer also receives the shared file and anonymous evidence attributes
  assert.match(synthPrompt, /<attached_file path="src\/app\.ts">[\s\S]*MAGIC_CONST = 42/);
  assert.match(synthPrompt, /evidence="可查阅本地仓库；实际调用：Read\(src\/app\.ts\)"/);
  assert.match(synthPrompt, /evidence="纯文本对话（已附带提问引用的 1 个本地文件，未自行查阅仓库其他文件）"/);
  assert.doesNotMatch(synthPrompt, /\bcli\b|\bapi\b/);
  assert.ok(notices.some((m) => m.includes('src/app.ts')));
});

test('continueFrom lets follow-up turns inherit a specific answer and validates unknown targets', async (t) => {
  const cwd = workspace(t);
  let nextPrompt = '';
  const a = target('a', async function* (req) {
    nextPrompt = req.prompt;
    yield { type: 'done', text: 'ANSWER_A_ONLY' };
  });
  const b = target('b', async function* () {
    yield { type: 'done', text: 'ANSWER_B_CHOSEN' };
  });
  const judge = target('judge', async function* () {
    yield { type: 'done', text: '## 最终答案\nSYNTH_PREFERS_A' };
  });

  const turn1 = await startComparison({
    cwd, question: '第一问', targets: [a, b, judge], selected: ['a', 'b'], config: { synthesizer: 'judge' },
  }).done;

  assert.throws(
    () => startComparison({ cwd, question: '无效沿用', targets: [a, b], selected: ['a'], config: {}, previous: turn1, continueFrom: 'missing' }),
    /没有来自「missing」的可用回答/,
  );

  const turn2 = await startComparison({
    cwd, question: '第二问', targets: [a, b], selected: ['a'], config: {}, previous: turn1, continueFrom: 'b',
  }).done;

  assert.equal(turn2.input.history.length, 1);
  assert.match(turn2.input.history[0].answer, /ANSWER_B_CHOSEN/);
  assert.doesNotMatch(turn2.input.history[0].answer, /SYNTH_PREFERS_A/);
  assert.match(nextPrompt, /ANSWER_B_CHOSEN/);
  assert.doesNotMatch(nextPrompt, /SYNTH_PREFERS_A/);
});
