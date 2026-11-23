import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture, candidateEvidence, caseId, getCase, listBench } from '../dist/bench/cases.js';
import { grade, materials } from '../dist/bench/grading.js';
import { draftCase, publish, runBench } from '../dist/bench/workflow.js';
import { createRun } from '../dist/core/store.js';
import { target, workspace } from './helpers.mjs';

const task = { title: '重复订单', prompt: '计算订单总金额，每个 id 只计一次。', files: [] };
const negative = 'function solve(rows){ return rows.reduce((a,r)=>a+r.amount,0) }';
const positive = 'function solve(rows){ return [...new Map(rows.map(r=>[r.id,r.amount])).values()].reduce((a,b)=>a+b,0) }';
const review = { skill: '具有相同 id 的重复行', negative, positive, grader: { kind: 'javascript', tests: [
  { input: [{ id: 7, amount: 241 }, { id: 7, amount: 241 }], expected: 241 }, { input: [], expected: 0 },
] } };
const item = { version: 1, task, review };
const model = (id, answer) => ({ target: target(id, async function* (req) { yield { type: 'done', text: await answer(req) }; }), timeoutMs: 2000 });
function record(cwd, id, question, parentTurnId) {
  const text = 'WRONG-ORIGINAL';
  const result = { runId: 'call', targetId: 'a', provider: 'a', status: 'succeeded', ok: true, durationMs: 2, text, reasoning: 'PRIVATE-REASONING' };
  const now = new Date().toISOString();
  createRun(cwd, { schemaVersion: 2, kind: 'comparison', id, sessionId: 'one', parentTurnId, createdAt: now, updatedAt: now,
    input: { cwd, prompt: question, history: [] }, question, status: 'completed', results: [result], targets: [], calls: [] });
}

test('capture costs no model call; review uses a private channel and published cases survive deleted runs', async t => {
  const cwd = workspace(t);
  record(cwd, 'a', 'Deduplicate charges.'); record(cwd, 'b', 'CORRECTION-ONLY', 'a');
  assert.equal(existsSync(join(cwd, '.unify', 'bench')), false);
  const { id } = capture(cwd, 'a', 'call');
  assert.equal(id, capture(cwd, 'a', 'call').id);
  assert.throws(() => capture(cwd, 'a', 'unrelated'));
  assert.deepEqual(listBench(cwd).candidates.map(c => c.id), [id]);
  assert.equal(JSON.stringify(listBench(cwd)).includes('WRONG-ORIGINAL'), false);
  assert.equal(candidateEvidence(cwd, id).followUp, 'CORRECTION-ONLY');
  const prompts = [], dirs = [];
  const author = model('author', req => {
    assert.deepEqual(readdirSync(req.cwd), []); dirs.push(req.cwd); prompts.push(req.prompt);
    return JSON.stringify(prompts.length === 1 ? task : review);
  });
  const draft = await draftCase(cwd, id, author, 'CORRECTION-ONLY');
  assert.doesNotMatch(prompts[0], /WRONG-ORIGINAL|CORRECTION-ONLY|PRIVATE-REASONING/);
  assert.match(prompts[1], /WRONG-ORIGINAL/); assert.match(prompts[1], /CORRECTION-ONLY/);
  assert.equal(draft.id, caseId(item));
  const published = await publish(cwd, draft.data);
  rmSync(join(cwd, '.unify', 'runs'), { recursive: true });
  const solver = (id, solution) => model(id, req => {
    assert.doesNotMatch(req.prompt, /241|CORRECTION|WRONG-ORIGINAL|reduce|具有相同/);
    assert.deepEqual(readdirSync(req.cwd), []); dirs.push(req.cwd);
    writeFileSync(join(req.cwd, 'attempt'), 'private');
    return solution;
  });
  const rows = await runBench(cwd, [], [solver('bad', negative), solver('good', positive)]);
  assert.deepEqual(rows.map(r => r.status), ['fail', 'pass']);
  assert.equal(rows[0].caseId, published);
  assert.equal(new Set(dirs).size, dirs.length); assert.ok(dirs.every(d => !existsSync(d)));
  assert.equal(getCase(cwd, published).review.skill, review.skill);
});

test('controls reject a non-discriminating case, malformed code and environment failures', async t => {
  const cwd = workspace(t);
  for (const changes of [{ negative: positive }, { positive: negative }, { negative: 'not code !' }]) {
    await assert.rejects(publish(cwd, { ...item, review: { ...review, ...changes } }));
  }
  assert.deepEqual(listBench(cwd).cases, []);
  assert.equal((await grade(item, 'function solve(){while(true){}}', [])).invalid, true);
  assert.equal((await grade(item, 'function solve(){return process.env}', [])).invalid, true);
  await assert.rejects(publish(cwd, { ...item, task: { ...task, files: [{ path: '../escape', content: '' }] } }));
  const pending = await captureDraftMissing(cwd);
  assert.match(pending, /待补材料/);
  assert.deepEqual(listBench(cwd).drafts, []);
});

async function captureDraftMissing(cwd) {
  record(cwd, 'a', 'Missing original dependency');
  const c = capture(cwd, 'a');
  try { await draftCase(cwd, c.id, model('editor', () => '{"missing":"原始依赖缺失"}')); }
  catch (e) { return e.message; }
  assert.fail('expected missing material');
}

test('explicit commit references read the pinned text and retain repository paths without snapshotting', async t => {
  const cwd = workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); mkdirSync(join(cwd, 'lib')); writeFileSync(join(cwd, 'lib', 'a.js'), 'original');
  git('add', 'lib/a.js'); git('-c', 'user.name=Fixture', '-c', 'user.email=f@test', 'commit', '-qm', 'baseline');
  const commit = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'lib', 'a.js'), 'dirty');
  const repository = { commit, paths: ['lib/a.js'] };
  const c = { ...item, task: { ...task, repository } };
  assert.deepEqual(await materials(cwd, c.task), [{ path: 'lib/a.js', content: 'original' }]);
  const id = await publish(cwd, c);
  assert.doesNotMatch(readFileSync(join(cwd, 'unify-bench', id + '.json'), 'utf8'), /original|dirty/);
  const solver = model('solver', req => {
    assert.match(req.prompt, /original/); assert.doesNotMatch(req.prompt, /dirty/);
    assert.equal(readFileSync(join(req.cwd, 'lib', 'a.js'), 'utf8'), 'original'); return positive;
  });
  assert.equal((await runBench(cwd, [id], [solver]))[0].status, 'pass');
  rmSync(join(cwd, '.git'), { recursive: true });
  assert.equal((await runBench(cwd, [id], [solver]))[0].status, 'error');
});

test('CLI publishes a reviewed draft, lists a shareable case and compares two target configurations', t => {
  const cwd = workspace(t), home = workspace(t);
  const configDir = join(home, '.unify');
  mkdirSync(configDir);
  const script = join(cwd, 'fixture-model.cjs');
  writeFileSync(script, "process.stdin.resume(); process.stdin.on('end',()=>console.log(process.argv[2]))");
  const custom = Object.fromEntries(['good', 'bad'].map(id => [id, { type: 'command', command: process.execPath, args: [script, id] }]));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ custom }));
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'bench', ...args],
    { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 10000 });
  const c = { ...item, review: { skill: 'format', negative: 'bad', positive: 'good', grader: { kind: 'exact', expected: 'good' } } };
  const path = join(cwd, 'draft.json'); writeFileSync(path, JSON.stringify(c));
  assert.equal(run('check', '--file', path).status, 0);
  const publication = run('publish', '--file', path); assert.equal(publication.status, 0, publication.stderr);
  assert.equal(JSON.parse(run('list', '--json').stdout).cases[0].id, caseId(c));
  const res = run('run', '--models', 'bad,good', '--json');
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).map(r => r.status), ['fail', 'pass']);
});

test('Docker grader applies real diffs to fresh inputs and distinguishes a failed test from a broken runner', { skip: process.platform === 'win32' }, async t => {
  const cwd = workspace(t), bin = join(cwd, 'bin');
  mkdirSync(bin);
  // Exercise the Docker CLI protocol without assuming a daemon in the test environment.
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), { join } = require('node:path'), { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.UNIFY_BENCH_TEST_DOCKER_ERROR) process.exit(1);
const mounts = args.filter((_, i) => args[i-1] === '-v');
const input = mounts[0].slice(0, -':/case:ro'.length), checks = mounts[1].slice(0, -':/checks:ro'.length);
if (fs.existsSync(join(input, 'check.cjs')) || !args.includes('--read-only') || !args.includes('none')) process.exit(125);
const r = spawnSync(process.execPath, [join(checks, 'check.cjs')], { cwd: input });
console.error(args.find(a => a.startsWith('VERDICT=')).slice(8) + r.status);
`, { mode: 0o755 });
  const saved = process.env.PATH; process.env.PATH = bin + ':' + saved;
  const data = { version: 1, task: { title: 'Fix addition', prompt: 'Fix add', files: [{ path: 'add.cjs', content: 'module.exports=(a,b)=>a-b\n' }] },
    review: { skill: 'arithmetic', negative: '', positive: 'diff --git a/add.cjs b/add.cjs\n--- a/add.cjs\n+++ b/add.cjs\n@@ -1 +1 @@\n-module.exports=(a,b)=>a-b\n+module.exports=(a,b)=>a+b\n',
      grader: { kind: 'patch', image: 'sha256:' + 'a'.repeat(64), files: [{ path: 'check.cjs', content: "process.exit(require(process.cwd()+'/add.cjs')(2,1)===3 ? 0 : 1)" }], command: ['node', '/checks/check.cjs'] } } };
  try {
    const id = await publish(cwd, data);
    const [r] = await runBench(cwd, [id], [model('solver', req => {
      assert.deepEqual(readdirSync(req.cwd), ['add.cjs']);
      assert.doesNotMatch(req.prompt, /check\.cjs|a\+b/);
      return data.review.positive;
    })]);
    assert.equal(r.status, 'pass', r.detail);
    process.env.UNIFY_BENCH_TEST_DOCKER_ERROR = '1';
    const [broken] = await runBench(cwd, [id], [model('solver', () => data.review.positive)]);
    assert.equal(broken.status, 'error');
  } finally { process.env.PATH = saved; delete process.env.UNIFY_BENCH_TEST_DOCKER_ERROR; }
});

test('rubric grading receives an anonymous answer and malformed verdicts stay errors', async t => {
  const cwd = workspace(t);
  const c = { version: 1, task, review: { skill: 'edge case', negative: 'bad', positive: 'good',
    grader: { kind: 'rubric', criteria: ['private rubric'] } } };
  const judge = model('reviewer', req => {
    assert.doesNotMatch(req.prompt, /participant-secret/);
    const { answer } = JSON.parse(req.prompt.slice(req.prompt.indexOf('\n') + 1));
    return JSON.stringify({ pass: answer === 'good', reason: 'reviewed' });
  });
  const id = await publish(cwd, c, judge);
  const solver = model('participant-secret', req => { assert.doesNotMatch(req.prompt, /private rubric/); return 'good'; });
  assert.equal((await runBench(cwd, [id], [solver], judge))[0].status, 'pass');
  assert.equal((await runBench(cwd, [id], [solver], model('badjudge', () => '{}')))[0].status, 'error');
});

test('text examples can be listed offline and opened as ordinary editable drafts', t => {
  const cwd = workspace(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, 'bench', 'example', ...args], { cwd, encoding: 'utf8' });
  const names = run();
  assert.match(names, /meeting-notes/);
  assert.match(names, /customer-support/);
  assert.match(names, /research-summary/);
  assert.match(names, /brand-copy/);
  assert.deepEqual(readdirSync(cwd), []);
  const first = run('meeting-notes');
  assert.equal(run('meeting-notes'), first);
  const { drafts, cases } = listBench(cwd);
  assert.equal(drafts.length, 1);
  assert.ok(first.includes(drafts[0].id));
  assert.equal(drafts[0].title, '发布会后纪要');
  assert.deepEqual(cases, []);
  assert.equal(existsSync(join(cwd, '.unify', 'runs')), false);
});

test('authored open-ended tasks retain the original format and pass only when every criterion passes', async t => {
  const cwd = workspace(t);
  const { exampleCase } = await import('../dist/bench/examples.js');
  const sample = exampleCase('meeting-notes');
  const criteria = sample.review.grader.criteria;
  record(cwd, 'a', sample.task.prompt);
  const candidate = capture(cwd, 'a', 'call', '不要把上线目标写成承诺');
  const author = model('author', ({ prompt }) => {
    if (prompt.startsWith('从原始请求')) {
      assert.doesNotMatch(prompt, /不要把上线目标写成承诺/);
      return JSON.stringify(sample.task);
    }
    assert.match(prompt, /不要把上线目标写成承诺/);
    return JSON.stringify({ ...sample.review, grader: { kind: 'rubric', criteria } });
  });
  const { data, id: draftId } = await draftCase(cwd, candidate.id, author);
  assert.equal(draftId, caseId(sample));

  const wrong = '产品已确定周五上线。';
  const paraphrase = '授权条款获批后才能敲定日子，目前瞄准周五。';
  const judge = model('judge', ({ prompt }) => {
    const input = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    assert.deepEqual(input.criteria, criteria);
    assert.doesNotMatch(prompt, /participant-private-id/);
    return JSON.stringify({ checks: [3, 1, 2].map(index => {
      const pass = index !== 2 || !input.answer.includes(wrong);
      return { index, pass, reason: pass ? '符合本项标准' : '答卷写了“已确定周五上线”' };
    }) });
  });
  const id = await publish(cwd, data, judge);
  const rows = await runBench(cwd, [id], [
    model('participant-private-id', req => {
      assert.ok(!req.prompt.includes(criteria[0]));
      return sample.review.negative;
    }),
    model('paraphrase', () => sample.review.positive.replace('产品以周五为上线目标，具体时间取决于法务确认授权条款。', paraphrase)),
  ], judge);
  assert.deepEqual(rows.map(r => r.status), ['fail', 'pass']);
  assert.deepEqual(rows[0].checks.map(c => c.criterion), criteria);
  assert.deepEqual(rows[0].checks.map(c => c.pass), [true, false, true]);
  assert.equal(rows[0].detail, '2/3 项通过');
  assert.equal(rows[1].detail, '3/3 项通过');
  await assert.rejects(publish(cwd, { ...data, review: { ...data.review, positive: data.review.negative } }, judge), /已确定周五上线/);

  for (const indexes of [[1, 2], [1, 1, 3], [0, 1, 2], [1, 2, 3, 4]]) {
    const broken = model('judge', () => JSON.stringify({ pass: true, checks: indexes.map(index => ({ index, pass: true, reason: 'ok' })) }));
    const [r] = await runBench(cwd, [id], [model('solver', () => sample.review.positive)], broken);
    assert.equal(r.status, 'error');
    assert.equal(r.checks, undefined);
  }
});
