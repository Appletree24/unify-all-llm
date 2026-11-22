import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startComparison, startExecution } from '../dist/core/workflow.js';
import { loadRun } from '../dist/core/store.js';
import { mergeConfig, parseConfig } from '../dist/core/config.js';
import { buildSynthesisPrompt } from '../dist/core/synth.js';
import { customAdapter } from '../dist/providers/custom.js';
import { runOne } from '../dist/core/orchestrator.js';
import { resolveSharedMemory } from '../dist/memory/shared.js';
import { applyMemorySync, MANAGED_END, MANAGED_START, previewMemorySync } from '../dist/memory/sync.js';
import { applyDistillSave, checkMemoryDuplicates, distillCandidates, prepareDistill } from '../dist/memory/distill.js';
import { options, target, workspace } from './helpers.mjs';

test('Phase 1: API targets receive frozen shared memory, append-only history, exact retry replay, and user-memory privacy isolation', async (t) => {
  const base = workspace(t);
  const home = join(base, 'home');
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(home, '.unify'), { recursive: true });

  writeFileSync(join(home, '.unify', 'memory.md'), '- 个人隐私偏好：使用中文简洁作答\n');
  writeFileSync(join(cwd, 'AGENTS.md'), '# 项目规范\n\n- 必须使用 pnpm\n');
  writeFileSync(join(cwd, 'src', 'mod.ts'), 'export const VERSION = 1;\n');

  const seenA = [];
  const seenB = [];
  const seenCustom = [];
  const seenSynth = [];

  const apiA = target('apiA', async function* (req) {
    seenA.push(req);
    const tag = req.messages.at(-1).content.match(/<unify-memory-[\w-]+>$/)?.[0];
    const body = 'API_A_ANSWER' + (tag ? `\n${tag}\n[{"source":"project:AGENTS.md","content":"必须使用 pnpm","effect":"推荐使用 pnpm"}]` : '');
    yield { type: 'done', text: body, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 } };
  }, { askPolicy: 'text-only', exec: false });

  const apiB = target('apiB', async function* (req) {
    seenB.push(req);
    yield { type: 'done', text: 'API_B_ANSWER' };
  }, { askPolicy: 'text-only', exec: false });

  const customApi = target('thirdparty', async function* (req) {
    seenCustom.push(req);
    yield { type: 'done', text: 'CUSTOM_ANSWER' };
  }, { askPolicy: 'text-only', exec: false });
  customApi.adapter.configuration = { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', system: 'BASE_SYSTEM' };

  const apiSynth = target('judge', async function* (req) {
    seenSynth.push(req);
    yield { type: 'done', text: '## 最终答案\n综合采用 pnpm 方案' };
  }, { askPolicy: 'text-only', exec: false });

  // Project config tries to enable userEnabled, but mergeConfig must ignore project-level user disclosure!
  const mergedSafe = mergeConfig(
    parseConfig({}),
    parseConfig({ memory: { userEnabled: true, projectSource: 'AGENTS.md' } }),
  );
  assert.equal(mergedSafe.memory?.userEnabled, undefined);
  assert.equal(mergedSafe.memory?.projectSource, 'AGENTS.md');

  // User config enables personal memory without allowlisting custom `thirdparty`.
  const config = parseConfig({
    synthesizer: 'judge',
    custom: { thirdparty: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', system: 'BASE_SYSTEM' } },
    memory: { userEnabled: true, projectSource: 'AGENTS.md' },
  });

  const turn1 = await startComparison({
    cwd, home, config,
    question: '检查 @src/mod.ts 的版本规范',
    targets: [apiA, apiB, customApi, apiSynth],
    selected: ['apiA', 'apiB', 'thirdparty'],
  }).done;

  assert.equal(turn1.status, 'completed');
  // apiA received both user + project memory in system message, and reported memory reference cleanly
  assert.equal(seenA[0].messages[0].role, 'system');
  assert.match(seenA[0].messages[0].content, /个人隐私偏好/);
  assert.match(seenA[0].messages[0].content, /必须使用 pnpm/);
  assert.match(seenA[0].messages[1].content, /VERSION = 1/);
  assert.equal(turn1.results[0].text, 'API_A_ANSWER');
  assert.equal(turn1.results[0].memoryReferences?.[0]?.source, 'project:AGENTS.md');
  assert.equal(turn1.results[0].usage?.cachedInputTokens, 60);

  // thirdparty custom endpoint must NOT receive personal user memory, while preserving BASE_SYSTEM + project memory
  assert.match(seenCustom[0].messages[0].content, /BASE_SYSTEM/);
  assert.match(seenCustom[0].messages[0].content, /必须使用 pnpm/);
  assert.doesNotMatch(seenCustom[0].messages[0].content, /个人隐私偏好/);

  // Personal user memory text must NEVER be persisted inside project `.unify/runs/<id>/run.json`
  const runJson = readFileSync(join(cwd, '.unify', 'runs', turn1.id, 'run.json'), 'utf8');
  assert.doesNotMatch(runJson, /个人隐私偏好/);
  assert.ok(existsSync(join(home, '.unify', 'memory-snapshots')));

  // Separately configured text-only synthesizer also received shared memory + rubric in system, and anonymous evidence
  assert.equal(seenSynth[0].messages[0].role, 'system');
  assert.match(seenSynth[0].messages[0].content, /必须使用 pnpm/);
  assert.match(seenSynth[0].messages[0].content, /你是一名严谨的多模型综合分析员/);
  assert.match(seenSynth[0].messages[1].content, /已提供共享项目约定/);

  // Now mutate disk memory AND @src/mod.ts!
  writeFileSync(join(cwd, 'AGENTS.md'), '# 项目规范\n\n- 改成了 yarn\n');
  writeFileSync(join(cwd, 'src', 'mod.ts'), 'export const VERSION = 999;\n');

  // 1) Exact retry MUST replay the original frozen memory + original VERSION = 1 attachment!
  const retried = await startComparison({
    cwd, home, config, question: '',
    targets: [apiA, apiB, customApi, apiSynth],
    retry: { record: loadRun(cwd, turn1.id), targetIds: ['apiA'] },
  }).done;
  assert.equal(retried.status, 'completed');
  assert.equal(seenA[1].messages[0].content, seenA[0].messages[0].content);
  assert.equal(seenA[1].messages[1].content, seenA[0].messages[1].content);
  assert.match(seenA[1].messages[0].content, /必须使用 pnpm/);
  assert.doesNotMatch(seenA[1].messages[0].content, /改成了 yarn/);
  assert.match(seenA[1].messages[1].content, /VERSION = 1/);
  assert.doesNotMatch(seenA[1].messages[1].content, /VERSION = 999/);

  // 2) Follow-up choosing apiB MUST keep frozen system prefix [S, U1, B, U2] and append tail <memory-update> without mutating S!
  const turn2 = await startComparison({
    cwd, home, config,
    question: '下一步怎么做',
    targets: [apiA, apiB, customApi, apiSynth],
    selected: ['apiA', 'apiB'],
    previous: turn1,
    continueFrom: 'apiB',
    memoryUpdates: ['- 新增规则：接口必须校验参数'],
  }).done;
  assert.equal(turn2.status, 'completed');
  // System message stays byte-for-byte identical to turn 1 (KV cache prefix preserved!)
  assert.equal(seenA[2].messages[0].content, seenA[0].messages[0].content);
  // Turn 1 user message (with original @src/mod.ts) preserved intact
  assert.match(seenA[2].messages[1].content, /VERSION = 1/);
  // Public chosen answer B is identical for both apiA and apiB
  assert.equal(seenA[2].messages[2].role, 'assistant');
  assert.match(seenA[2].messages[2].content, /API_B_ANSWER/);
  assert.equal(seenA[2].messages[2].content, seenB[1].messages[2].content);
  // Tail user message carries append-only <memory-update>
  assert.equal(seenA[2].messages[3].role, 'user');
  assert.match(seenA[2].messages[3].content, /<memory-update>[\s\S]*接口必须校验参数/);
  assert.doesNotMatch(seenA[2].messages[0].content, /接口必须校验参数/);
});

test('KV Cache helpers: buildSynthesisPrompt puts static rubric first and HTTP adapter parses cached tokens', async (t) => {
  const p = buildSynthesisPrompt('问题', [
    { label: '[ref:1]', provider: 'a', text: '答A' },
    { label: '[ref:2]', provider: 'b', text: '答B' },
  ]);
  assert.ok(p.startsWith('你是一名严谨'));
  assert.ok(p.indexOf('原则：') < p.indexOf('<question>'));
  assert.ok(p.indexOf('## 最终答案') < p.indexOf('<answer id="[ref:1]"'));

  // Verify DeepSeek / OpenAI cached usage fields are captured without breaking existing usage shape
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":15,"prompt_cache_hit_tokens":96}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const adapter = customAdapter('ds', { type: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'm' });
  const res = await runOne({ id: 'ds', label: 'DS', adapter }, options(workspace(t)));
  assert.equal(res.status, 'succeeded');
  assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 15, cachedInputTokens: 96 });
});

test('Phase 2: Windows-safe explicit one-way managed-block sync preserves hand-written text, is idempotent, and blocks conflicts/overrides', (t) => {
  const base = workspace(t);
  const home = join(base, 'home');
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });

  const ctx = { cwd, home, env: {}, platform: 'win32' };
  const agents = join(cwd, 'AGENTS.md');
  const claude = join(cwd, 'CLAUDE.md');
  const gemini = join(cwd, 'GEMINI.md');

  writeFileSync(agents, '# 共享约定\n\n- 优先使用 pnpm\n');
  writeFileSync(claude, '# Claude 专属手写前缀\r\n\r\n- 保留这段手写内容\r\n');

  // Preview sync AGENTS.md -> CLAUDE.md, GEMINI.md, and AGENTS.md (self = shared)
  const p1 = previewMemorySync(ctx, agents, [agents, claude, gemini]);
  assert.equal(p1.targets[0].status, 'shared');
  assert.equal(p1.targets[1].status, 'update');
  assert.equal(p1.targets[2].status, 'create');

  // Apply first sync
  const r1 = applyMemorySync(ctx, { sourcePath: agents, targetPaths: [agents, claude, gemini] });
  assert.deepEqual(r1.results.map((r) => r.status), ['shared', 'written', 'written']);

  // Hand-written prefix in CLAUDE.md is preserved byte-for-byte (including CRLF!)
  const claudeAfter = readFileSync(claude, 'utf8');
  assert.ok(claudeAfter.startsWith('# Claude 专属手写前缀\r\n\r\n- 保留这段手写内容\r\n'));
  assert.match(claudeAfter, new RegExp(`${MANAGED_START}[\\s\\S]*优先使用 pnpm[\\s\\S]*${MANAGED_END}`));

  // Second sync MUST be zero diff!
  const p2 = previewMemorySync(ctx, agents, [claude, gemini]);
  assert.deepEqual(p2.targets.map((x) => x.status), ['unchanged', 'unchanged']);
  const r2 = applyMemorySync(ctx, { sourcePath: agents, targetPaths: [claude, gemini] });
  assert.deepEqual(r2.results.map((r) => r.status), ['unchanged', 'unchanged']);

  // Hand-editing inside managed block triggers conflict protection on next sync
  writeFileSync(claude, claudeAfter.replace('优先使用 pnpm', '手改冲突内容'));
  writeFileSync(agents, '# 共享约定\n\n- 优先使用 pnpm\n- 新增一条\n');
  const pConflict = previewMemorySync(ctx, agents, [claude, gemini]);
  assert.equal(pConflict.targets[0].status, 'conflict');
  assert.equal(pConflict.targets[1].status, 'update');

  // Override shadowing blocks syncing to shadowed file
  writeFileSync(join(cwd, 'AGENTS.override.md'), '- 临时覆盖\n');
  const resMem = resolveSharedMemory({ cwd, home }, {});
  assert.ok(resMem.snapshot.overrides?.includes('AGENTS.override.md'));
});

test('Phase 3: Distill prepares from answer/synthesis/exec without cross-card confusion, checks short duplicates, saves clean Markdown + local provenance', async (t) => {
  const base = workspace(t);
  const home = join(base, 'home');
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const ctx = { cwd, home, env: {}, platform: 'win32' };
  const agents = join(cwd, 'AGENTS.md');
  writeFileSync(agents, '# 约定\n\n- 用中文回答\n');

  // Same target `a` both answers AND synthesizes — runId + scope must stay distinct
  const a = target('a', async function* (req) {
    if (req.prompt.startsWith('你是一名严谨')) {
      yield { type: 'done', text: '## 分歧\n拒绝 B\n## 最终答案\n必须支持无软链权限的 Windows' };
    } else {
      yield { type: 'done', text: '单答正文：A 的观点' };
    }
  });
  const b = target('b', async function* () { yield { type: 'done', text: '单答正文：B 的观点' }; });
  const worker = target('worker', async function* () {
    yield { type: 'done', text: '已完成修改并通过测试' };
  }, { askPolicy: 'sandbox-read-only', exec: true });

  const cmp = await startComparison({ cwd, home, config: { synthesizer: 'a' }, question: '同步方案？', targets: [a, b], selected: ['a', 'b'] }).done;
  const execRun = await startExecution({ cwd, home, config: {}, targets: [worker], source: cmp, executor: worker }).done;

  // Answer card prep vs Synthesis card prep (same targetId 'a', different runId & scope)
  const ansPrep = prepareDistill(ctx, { turnId: cmp.id, runId: cmp.results[0].runId, scope: 'answer' });
  assert.equal(ansPrep.defaultText, '单答正文：A 的观点');
  const synthPrep = prepareDistill(ctx, { turnId: cmp.id, runId: cmp.synthesis.result.runId, scope: 'synthesis' });
  assert.equal(synthPrep.defaultText, '必须支持无软链权限的 Windows');
  assert.equal(synthPrep.defaultTargetPath, agents);

  // Exec card exposes BOTH adopted plan and execution outcome separately
  const execPrep = prepareDistill(ctx, { turnId: execRun.id, runId: execRun.results[0].runId, scope: 'exec' });
  assert.match(execPrep.planText, /无软链权限的 Windows/);
  assert.match(execPrep.execOutcome, /已完成修改/);

  // Short Chinese rule duplicate check (< 16 chars!) catches exact duplicate
  const dup = checkMemoryDuplicates(ctx, agents, '- 用中文回答');
  assert.equal(dup.exact?.start, 3);

  // On-demand distillation runs isolated and parses <= 3 candidates
  const distiller = target('distiller', async function* (req) {
    assert.match(req.prompt, /无软链权限的 Windows/);
    yield { type: 'done', text: '```json\n[{"text":"本项目同步必须支持无软链权限的 Windows 环境","scopeHint":"project","quote":"必须支持无软链权限的 Windows"}]\n```' };
  }, { askPolicy: 'text-only', exec: false });
  const cands = await distillCandidates(ctx, { turnId: cmp.id, runId: cmp.synthesis.result.runId, scope: 'synthesis' }, distiller);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].text, '- 本项目同步必须支持无软链权限的 Windows 环境');

  // Apply save: Markdown stays clean (no machine comments), provenance recorded in local JSONL
  const saved = applyDistillSave(ctx, {
    source: { turnId: execRun.id, runId: execRun.results[0].runId, scope: 'exec' },
    targetPath: agents,
    text: cands[0].text,
    heading: '约定',
  });
  const md = readFileSync(agents, 'utf8');
  assert.match(md, /- 本项目同步必须支持无软链权限的 Windows 环境/);
  assert.doesNotMatch(md, /unify-run|auditId|provenance/);

  const auditLines = readFileSync(join(home, '.unify', 'memory-provenance.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].id, saved.auditId);
  assert.equal(auditLines[0].provenance.turnId, execRun.id);
  assert.equal(auditLines[0].provenance.planSource.turnId, cmp.id);
});
