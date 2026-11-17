import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEntry, parseMemory, replaceLines } from '../dist/memory/parse.js';
import { effectiveContext, scanMemory } from '../dist/memory/scan.js';
import { ConflictError, deleteMemory, editEntry, listBackups, restoreBackup, writeMemory } from '../dist/memory/edit.js';
import { startMemoryServer } from '../dist/memory/server.js';
import { workspace } from './helpers.mjs';

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A home directory and a git project with memory in every layer the scanners know. */
export function fixture(t) {
  const base = workspace(t);
  const home = join(base, 'home'), root = join(base, 'proj'), cwd = join(root, 'pkg');
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  mkdirSync(cwd, { recursive: true });
  put(join(home, '.claude/CLAUDE.md'), '# 个人偏好\n\n- 回答使用中文\n- 提交信息遵循 Conventional Commits\n');
  put(join(home, '.claude/rules/style.md'), '- 不写多余的注释\n');
  put(join(root, 'CLAUDE.md'), '# 项目\n\n构建与测试见 @docs/build.md，另见 @docs/missing.md。\n\n## 约定\n\n- 提交信息遵循 Conventional Commits\n- 测试用 `npm test`\n  不要跳过失败的测试\n\n```sh\nnpm ci\n```\n');
  put(join(root, 'docs/build.md'), '- 先 npm ci 再 npm run build\n');
  put(join(root, '.claude/rules/api.md'), '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n- API 处理函数必须校验输入\n');
  put(join(root, 'CLAUDE.local.md'), '- 我的沙箱地址是 localhost:8080\n');
  put(join(cwd, 'CLAUDE.md'), '- pkg 使用 vitest\n');
  put(join(cwd, 'sub/CLAUDE.md'), '- sub 目录的说明\n');
  const slug = root.replace(/[^A-Za-z0-9]/g, '-');
  put(join(home, '.claude/projects', slug, 'memory/MEMORY.md'), Array.from({ length: 230 }, (_, i) => `- 经验 ${i + 1}：一些内容足够长`).join('\n') + '\n');
  put(join(home, '.claude/projects', slug, 'memory/debugging.md'), '---\nname: 调试\ndescription: 调试时的经验\ntype: feedback\n---\n\n- Redis 必须先启动\n');
  put(join(home, '.codex/AGENTS.md'), '- 全局：先读测试\n');
  put(join(root, 'AGENTS.md'), '- 使用 pnpm\n');
  put(join(root, 'AGENTS.override.md'), '- 临时：冻结发布\n');
  put(join(home, '.gemini/GEMINI.md'), '# 我\n\n- 手写的一条\n\n## Gemini Added Memories\n\n- 用户喜欢简洁的回答\n');
  symlinkSync('AGENTS.md', join(root, 'GEMINI.md'));
  git('init', '-q');
  git('add', 'CLAUDE.md', 'AGENTS.md', 'docs');
  git('commit', '-q', '-m', 'docs: 初始记忆');
  writeFileSync(join(root, 'CLAUDE.md'), readFileSync(join(root, 'CLAUDE.md'), 'utf8') + '\n- 尚未提交的一条\n');
  return { ctx: { cwd, home, env: {}, platform: 'linux' }, home, root, cwd };
}

const layer = (state, harness, id) => state.harnesses.find((h) => h.id === harness).layers.find((l) => l.id === id);
const file = (state, harness, id, suffix) => layer(state, harness, id).files.find((f) => f.path.endsWith(suffix));

test('memory parser splits bullets, paragraphs and code under their headings', () => {
  const p = parseMemory('---\nname: x\npaths:\n  - "a/**"\n  - b\n---\n# A\n\n段落 @./rel.md 与 `@not/import.md` 和 user@example.com\n\n## B\n\n- 一\n  续行\n\n  ```js\n  x\n  ```\n- 二\n\n```sh\n@in/code.md\n```\n');
  assert.deepEqual(p.meta, { name: 'x', paths: 'a/**, b' });
  assert.deepEqual(p.entries.map((e) => [e.kind, e.start, e.end, e.heading.join('/')]), [['text', 9, 9, 'A'], ['bullet', 13, 18, 'A/B'], ['bullet', 19, 19, 'A/B'], ['code', 21, 23, 'A/B']]);
  assert.deepEqual(p.imports, [{ target: './rel.md', line: 9 }]);
  assert.equal(replaceLines('a\n\n- x\n\nb\n', 3, 3, ''), 'a\n\nb\n');
  assert.equal(replaceLines('- x\n- y\n', 2, 2, '- z\n  more'), '- x\n- z\n  more\n');
  assert.throws(() => replaceLines('a\n', 5, 6, 'x'), /行范围/);
  assert.equal(appendEntry('# T\n\n## S\n\n- a\n\n## U\n\n- b\n', '- c', 'S'), '# T\n\n## S\n\n- a\n- c\n\n## U\n\n- b\n');
  assert.equal(appendEntry('', '- first'), '- first\n');
  assert.equal(appendEntry('- a\n', '- b', '新小节'), '- a\n\n## 新小节\n\n- b\n');
});

test('scan lays out each harness in its own layers, load order and precedence', (t) => {
  const { ctx, root } = fixture(t);
  const state = scanMemory(ctx);
  assert.equal(state.root, root);
  const claude = state.harnesses.find((h) => h.id === 'claude');
  assert.deepEqual(claude.layers.map((l) => l.id), ['managed', 'user', 'project', 'local', 'nested', 'auto']);
  assert.deepEqual(layer(state, 'claude', 'project').files.map((f) => [f.display, f.load, f.importedBy ?? '']), [
    ['../CLAUDE.md', 'startup', ''], ['CLAUDE.md', 'startup', ''], ['../.claude/rules/api.md', 'on-demand', ''], ['../docs/build.md', 'startup', '../CLAUDE.md'],
  ]);
  assert.deepEqual(file(state, 'claude', 'project', 'api.md').appliesTo, ['src/api/**/*.ts']);
  assert.deepEqual(layer(state, 'claude', 'nested').files.map((f) => f.display), ['sub/CLAUDE.md']);
  assert.equal(layer(state, 'claude', 'managed').readonly, true);

  // provenance: committed lines carry their commit, later edits are flagged, agent-written layers are labelled
  const project = file(state, 'claude', 'project', join('proj', 'CLAUDE.md'));
  assert.equal(project.tracked, true);
  assert.deepEqual(project.entries.map((e) => e.origin.kind), ['git', 'git', 'git', 'git', 'uncommitted']);
  assert.equal(project.entries[1].origin.commit.author, 'Ada');
  assert.equal(project.entries[1].origin.commit.summary, 'docs: 初始记忆');
  assert.equal(file(state, 'claude', 'local', 'CLAUDE.local.md').entries[0].origin.kind, 'untracked');
  const auto = layer(state, 'claude', 'auto');
  assert.deepEqual(auto.files.map((f) => [f.display.split('/').pop(), f.load]), [['MEMORY.md', 'startup'], ['debugging.md', 'on-demand']]);
  assert.equal(auto.files[1].entries[0].origin.via, 'Claude 自动记忆');
  assert.equal(auto.files[1].meta.description, '调试时的经验');
  const added = file(state, 'gemini', 'user', 'GEMINI.md').entries;
  assert.deepEqual(added.map((e) => e.origin.via), [undefined, 'save_memory 工具']);

  // diagnostics
  const codes = (h) => state.harnesses.find((x) => x.id === h).issues.map((i) => i.code).sort();
  assert.deepEqual(codes('claude'), ['broken-import', 'duplicate', 'truncated']);
  assert.match(claude.issues.find((i) => i.code === 'duplicate').message, /~\/\.claude\/CLAUDE\.md:4、\.\.\/CLAUDE\.md:7/);
  assert.deepEqual(codes('codex'), ['shadowed']);

  // Codex: one file per directory, the override wins
  assert.equal(file(state, 'codex', 'project', 'AGENTS.md').shadowedBy, '../AGENTS.override.md');
  const codexText = effectiveContext(state, 'codex');
  assert.match(codexText, /全局：先读测试[\s\S]*临时：冻结发布/);
  assert.doesNotMatch(codexText, /使用 pnpm/);
  // the head of MEMORY.md is all that loads
  const memoryIndex = auto.files[0];
  assert.ok(claude.effective.bytes < memoryIndex.bytes + 2000 && memoryIndex.lines === 230);
  // one file behind a symlink has two readers; Codex is not one, because its override replaces it
  assert.deepEqual(file(state, 'gemini', 'project', 'GEMINI.md').sharedWith, ['Pi']);
  assert.deepEqual(file(state, 'pi', 'project', 'AGENTS.md').sharedWith, ['Gemini CLI']);
  assert.equal(file(state, 'codex', 'project', 'AGENTS.md').sharedWith, undefined);
});

test('memory edits are confined to memory files, detect conflicts and can be undone', (t) => {
  const { ctx, root, home, cwd } = fixture(t);
  const path = join(root, 'CLAUDE.local.md');
  const local = () => file(scanMemory(ctx), 'claude', 'local', 'CLAUDE.local.md');
  assert.throws(() => writeMemory(ctx, join(root, 'package.json'), '{}', undefined), /不是可编辑的记忆文件/);
  assert.throws(() => writeMemory(ctx, join(home, '.claude/rules/../../.bashrc.md'), 'x', undefined), /不是可编辑的记忆文件/);
  assert.throws(() => writeMemory(ctx, '/etc/claude-code/CLAUDE.md', 'x', undefined), /不是可编辑的记忆文件/);

  const before = local();
  editEntry(ctx, { op: 'add', path, baseHash: before.hash, text: '- 第二条' });
  assert.throws(() => editEntry(ctx, { op: 'delete', path, baseHash: before.hash, start: 1, end: 1 }), ConflictError);
  const two = local();
  editEntry(ctx, { op: 'update', path, baseHash: two.hash, start: 2, end: 2, text: '- 第二条（改）' });
  assert.equal(readFileSync(path, 'utf8'), '- 我的沙箱地址是 localhost:8080\n- 第二条（改）\n');

  // promote a project-local habit to the user layer, and mirror it to Codex
  const user = join(home, '.claude/CLAUDE.md');
  editEntry(ctx, { op: 'move', path, baseHash: local().hash, start: 2, end: 2, to: user, heading: '个人偏好' });
  assert.equal(readFileSync(path, 'utf8'), '- 我的沙箱地址是 localhost:8080\n');
  assert.match(readFileSync(user, 'utf8'), /Conventional Commits\n- 第二条（改）\n$/);
  editEntry(ctx, { op: 'copy', path: user, start: 3, end: 3, to: join(cwd, 'AGENTS.md') });
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), '- 回答使用中文\n');
  assert.throws(() => editEntry(ctx, { op: 'copy', path: user, start: 3, end: 3, to: join(cwd, 'notes.txt') }), /不是可编辑的记忆文件/);

  // new rule file inside a layer directory; symlinked memory is written through, not replaced
  writeMemory(ctx, join(root, '.claude/rules/new/testing.md'), '- 新规则\n', '');
  assert.ok(file(scanMemory(ctx), 'claude', 'project', 'testing.md'));
  writeMemory(ctx, join(root, 'GEMINI.md'), '- 使用 pnpm\n- 经由符号链接\n', undefined);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '- 使用 pnpm\n- 经由符号链接\n');

  deleteMemory(ctx, path);
  assert.equal(existsSync(path), false);
  const backups = listBackups(ctx, path);
  assert.deepEqual(backups.map((b) => b.reason), ['删除文件', '移出记忆', '修改记忆', '新增记忆']);
  restoreBackup(ctx, backups[2].id);
  assert.equal(readFileSync(path, 'utf8'), '- 我的沙箱地址是 localhost:8080\n- 第二条\n');
});

test('memory server requires its token and a loopback host', async (t) => {
  const { ctx, root } = fixture(t);
  const server = await startMemoryServer(ctx);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { 'x-unify-token': server.token, ...init.headers } });
  assert.match(await (await fetch(base + '/')).text(), /Unify 记忆/);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await call('/api/state', { headers: { 'x-unify-token': 'wrong' } })).status, 401);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
  const state = await (await call('/api/state')).json();
  assert.equal(state.root, root);
  const local = file(state, 'claude', 'local', 'CLAUDE.local.md');
  const post = (path, body, type = 'application/json') => call(path, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  assert.equal((await post('/api/file', { path: local.path, content: 'x', baseHash: local.hash }, 'text/plain')).status, 415);
  assert.equal((await post('/api/file', { path: join(root, 'package.json'), content: 'x' })).status, 400);
  assert.equal((await post('/api/file', { path: local.path, content: '- 改了\n', baseHash: 'stale' })).status, 409);
  assert.equal((await post('/api/entry', { op: 'add', path: local.path, baseHash: local.hash, text: '- 来自网页' })).status, 200);
  assert.match(readFileSync(local.path, 'utf8'), /- 来自网页\n$/);
  assert.match((await (await call('/api/effective?harness=claude')).json()).text, /<!-- 本地项目记忆 · \.\.\/CLAUDE\.local\.md -->/);
  const { backups } = await (await call('/api/backups')).json();
  assert.equal(backups.length, 1);

  const { request } = await import('node:http');
  const status = await new Promise((resolve) => request({ host: '127.0.0.1', port: server.port, path: '/api/state', headers: { host: 'evil.example', 'x-unify-token': server.token } }, (res) => { res.resume(); resolve(res.statusCode); }).end());
  assert.equal(status, 403);
});
