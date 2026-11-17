import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { blame } from './git.js';
import { estimateTokens, parseMemory } from './parse.js';
import type { Harness, Issue, Layer, LoadTiming, MemoryContext, MemoryFile, MemoryState, Origin, Scope, Writer } from './types.js';

const MAX_READ = 1024 * 1024;
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor']);

export function defaultContext(cwd: string): MemoryContext {
  return { cwd: resolve(cwd), home: homedir(), env: process.env, platform: process.platform };
}

export const sha = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 16);

interface Slot { path: string; load?: LoadTiming }
interface DirSlot { path: string; recursive?: boolean; load?: LoadTiming; main?: string }
interface LayerSpec {
  id: string; title: string; scope: Scope; load: LoadTiming; writer: Writer; note: string;
  readonly?: boolean;
  /** Each group is one directory's candidates; with `exclusive`, only the first existing one is read. */
  groups?: Slot[][];
  exclusive?: boolean;
  dirs?: DirSlot[];
  /** Label for items the harness wrote on its own. */
  via?: string;
  /** Only the head of the main file is loaded at startup. */
  head?: { lines: number; bytes: number };
}
interface HarnessSpec {
  id: string; name: string; summary: string; home: string;
  layers: LayerSpec[];
  imports?: boolean;
  /** Combined size limit of the project layer, in bytes. */
  projectLimit?: number;
}

function gitRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

/** Directories from `from` down to `to`, inclusive. */
function chain(from: string, to: string): string[] {
  const rel = relative(from, to);
  if (rel.startsWith('..') || isAbsolute(rel)) return [to];
  const out = [from];
  for (const part of rel.split(sep).filter(Boolean)) out.push(join(out[out.length - 1], part));
  return out;
}

/** Ancestors above the project root, outermost first. */
function above(root: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    out.unshift(dir);
    if (dirname(dir) === dir) return out;
  }
}

function listDir(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { if (recursive && depth < 4) visit(join(d, e.name), depth + 1); }
      else if (/\.(md|mdc|txt)$/i.test(e.name)) out.push(join(d, e.name));
    }
  };
  visit(dir, 0);
  return out;
}

/** Files with one of `names` in directories strictly below `cwd`. */
function nested(cwd: string, names: string[]): string[] {
  const out: string[] = [];
  let seen = 0;
  const visit = (d: string, depth: number) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 5 && ++seen < 3000 && !e.name.startsWith('.') && !SKIP.has(e.name)) visit(join(d, e.name), depth + 1);
      } else if (depth > 0 && names.includes(e.name)) out.push(join(d, e.name));
    }
  };
  visit(cwd, 0);
  return out.sort();
}

// ── harness definitions ─────────────────────────────────────────────────────
// Each function encodes one harness's documented discovery rules; see code.claude.com/docs/en/memory,
// developers.openai.com/codex/guides/agents-md,
// geminicli.com/docs/cli/gemini-md, github.com/badlogic/pi-mono (coding-agent README).

function claude(ctx: MemoryContext, root: string): HarnessSpec {
  const home = ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude');
  const managed = ctx.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
    : ctx.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\CLAUDE.md' : '/etc/claude-code/CLAUDE.md';
  const dirs = chain(root, ctx.cwd);
  const outer = above(root);
  const present = (paths: string[]) => paths.filter((p) => existsSync(p)).map((path) => ({ path }));
  const slug = root.replace(/[^A-Za-z0-9]/g, '-');
  return {
    id: 'claude', name: 'Claude Code', home, imports: true,
    summary: '启动时自上而下全部载入并拼接，越靠后的层越具体、冲突时优先。CLAUDE.md 由人维护，自动记忆由 Claude 自己写。',
    layers: [
      { id: 'managed', title: '组织策略', scope: 'managed', load: 'startup', writer: 'admin', readonly: true,
        note: '由管理员下发到系统目录，对这台机器上的所有人生效，个人无法排除。', groups: [[{ path: managed }]] },
      { id: 'user', title: '用户记忆', scope: 'user', load: 'startup', writer: 'human',
        note: '你在所有项目中的个人偏好。rules/ 下每个文件是一条独立规则。',
        groups: [[{ path: join(home, 'CLAUDE.md') }]], dirs: [{ path: join(home, 'rules'), recursive: true }] },
      { id: 'project', title: '项目记忆', scope: 'project', load: 'startup', writer: 'human',
        note: '随仓库提交、团队共享。从工作目录向上逐级查找，每一级的 CLAUDE.md 与 .claude/CLAUDE.md 都会载入；.claude/rules/ 中带 paths 的规则只在处理匹配文件时载入。',
        groups: [
          ...outer.map((d) => present([join(d, 'CLAUDE.md'), join(d, '.claude', 'CLAUDE.md')])),
          ...dirs.map((d) => [{ path: join(d, 'CLAUDE.md') }, ...present([join(d, '.claude', 'CLAUDE.md')])]),
        ],
        dirs: [{ path: join(root, '.claude', 'rules'), recursive: true }] },
      { id: 'local', title: '本地项目记忆', scope: 'local', load: 'startup', writer: 'human',
        note: '只属于你、只在这个项目生效，应加入 .gitignore。排在项目记忆之后载入。',
        groups: [...outer.map((d) => present([join(d, 'CLAUDE.local.md')])), ...dirs.map((d) => [{ path: join(d, 'CLAUDE.local.md') }])] },
      { id: 'nested', title: '子目录记忆', scope: 'nested', load: 'on-demand', writer: 'human',
        note: '工作目录以下的 CLAUDE.md 不在启动时载入，Claude 读取该子目录中的文件时才加入上下文。',
        groups: [nested(ctx.cwd, ['CLAUDE.md', 'CLAUDE.local.md']).map((path) => ({ path }))] },
      { id: 'auto', title: '自动记忆', scope: 'auto', load: 'startup', writer: 'agent', via: 'Claude 自动记忆',
        note: 'Claude 在工作中自己记下的经验，按仓库存放在本机。MEMORY.md 是索引，每次会话只载入前 200 行或 25KB；其余主题文件在需要时才读取。',
        dirs: [{ path: join(home, 'projects', slug, 'memory'), main: 'MEMORY.md', load: 'on-demand' }], head: { lines: 200, bytes: 25_000 } },
      { id: 'agent', title: '子代理记忆', scope: 'agent', load: 'on-demand', writer: 'agent', via: '子代理记忆',
        note: '启用了 memory 的子代理各自维护的记忆目录，仅在该子代理运行时载入。',
        dirs: [join(home, 'agent-memory'), join(root, '.claude', 'agent-memory'), join(root, '.claude', 'agent-memory-local')].filter((p) => existsSync(p)).map((path) => ({ path, recursive: true })) },
    ],
  };
}

function codex(ctx: MemoryContext, root: string): HarnessSpec {
  const home = ctx.env.CODEX_HOME || join(ctx.home, '.codex');
  const pair = (d: string) => [{ path: join(d, 'AGENTS.override.md') }, { path: join(d, 'AGENTS.md') }];
  // The override is a deliberate, temporary replacement: list it only where it exists.
  const group = (d: string) => pair(d).filter((s, i) => i === 1 || existsSync(s.path));
  return {
    id: 'codex', name: 'Codex', home, projectLimit: 32 * 1024,
    summary: '每次运行开始时构建一次指令链：先全局，再从项目根逐级到当前目录。每个目录只取一个文件（AGENTS.override.md 优先），越靠近当前目录越靠后、越优先。',
    layers: [
      { id: 'user', title: '全局指令', scope: 'user', load: 'startup', writer: 'human', exclusive: true,
        note: '对所有仓库生效的个人约定。AGENTS.override.md 存在时取代 AGENTS.md。', groups: [group(home)] },
      { id: 'project', title: '项目指令', scope: 'project', load: 'startup', writer: 'human', exclusive: true,
        note: '从项目根到当前目录逐级拼接，合计超过 project_doc_max_bytes（默认 32 KiB）后不再继续加入。',
        groups: chain(root, ctx.cwd).map(group) },
      { id: 'nested', title: '子目录指令', scope: 'nested', load: 'on-demand', writer: 'human',
        note: '当前目录以下的 AGENTS.md 不参与本次运行；在那个子目录里启动 Codex 时才会生效。',
        groups: [nested(ctx.cwd, ['AGENTS.md', 'AGENTS.override.md']).map((path) => ({ path }))] },
      { id: 'auto', title: 'Codex 记忆', scope: 'auto', load: 'on-demand', writer: 'agent', via: 'Codex 记忆',
        note: '启用 memories 功能后，Codex 从过往会话中提炼并保存在本机的内容。',
        dirs: [join(home, 'memories')].filter((p) => existsSync(p)).map((path) => ({ path, recursive: true })) },
    ],
  };
}

function gemini(ctx: MemoryContext, root: string): HarnessSpec {
  const home = join(ctx.home, '.gemini');
  let names = ['GEMINI.md'];
  try {
    const configured = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))?.context?.fileName;
    const list = (Array.isArray(configured) ? configured : [configured]).filter((n): n is string => typeof n === 'string' && !!n && !/[\\/]/.test(n));
    if (list.length) names = list;
  } catch { /* default file name */ }
  const group = (d: string) => names.map((n) => ({ path: join(d, n) })).filter((s, i) => i === 0 || existsSync(s.path));
  return {
    id: 'gemini', name: 'Gemini CLI', home, imports: true,
    summary: '启动时把全局与项目各级的上下文文件拼接后随每次请求发送，越具体的越靠后。/memory show 可在 CLI 中查看拼接结果。',
    layers: [
      { id: 'user', title: '全局上下文', scope: 'user', load: 'startup', writer: 'human', via: 'save_memory 工具',
        note: '对所有项目生效。让 Gemini“记住”某件事时，save_memory 工具会把它追加到这个文件的「Gemini Added Memories」小节。',
        groups: [group(home)] },
      { id: 'project', title: '项目上下文', scope: 'project', load: 'startup', writer: 'human',
        note: `从当前目录向上到项目根（.git 所在目录），每一级的 ${names.join(' / ')} 都会载入。`, groups: chain(root, ctx.cwd).map(group) },
      { id: 'nested', title: '子目录上下文', scope: 'nested', load: 'on-demand', writer: 'human',
        note: '当前目录以下的上下文文件，在工具访问到该目录时才被发现并载入。',
        groups: [nested(ctx.cwd, names).map((path) => ({ path }))] },
    ],
  };
}

function pi(ctx: MemoryContext, root: string): HarnessSpec {
  const home = ctx.env.PI_CODING_AGENT_DIR || join(ctx.home, '.pi', 'agent');
  const pair = (d: string) => [{ path: join(d, 'AGENTS.md') }, { path: join(d, 'CLAUDE.md') }];
  const group = (d: string) => pair(d).filter((s, i) => i === 0 || existsSync(s.path));
  return {
    id: 'pi', name: 'Pi', home,
    summary: '启动时载入全局文件，再从上级目录逐级到当前目录。每个目录取 AGENTS.md，没有时取 CLAUDE.md。Pi 自身没有自动记忆。',
    layers: [
      { id: 'user', title: '全局上下文', scope: 'user', load: 'startup', writer: 'human', exclusive: true,
        note: '对所有项目生效的个人约定。', groups: [group(home)] },
      { id: 'project', title: '项目上下文', scope: 'project', load: 'startup', writer: 'human', exclusive: true,
        note: '从上级目录到当前目录逐级载入，每一级只取一个文件。',
        groups: [...above(root).map((d) => pair(d).filter((s) => existsSync(s.path))), ...chain(root, ctx.cwd).map(group)] },
    ],
  };
}

const HARNESSES = [claude, codex, gemini, pi];

// ── scanning ────────────────────────────────────────────────────────────────

interface ScanContext extends MemoryContext { root: string }
const inside = (dir: string, path: string) => { const rel = relative(dir, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };

/** Project files relative to the working directory (../ for its ancestors), home files as ~/…. */
function display(ctx: ScanContext, path: string): string {
  if (inside(ctx.root, path)) return relative(ctx.cwd, path).split(sep).join('/');
  const fromHome = relative(ctx.home, path);
  if (fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome)) return '~/' + fromHome.split(sep).join('/');
  return path;
}

function writable(path: string): boolean {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(p)) {
      try { accessSync(p, constants.W_OK); return true; } catch { return false; }
    }
    if (dirname(p) === p) return false;
  }
}

function readFile(ctx: ScanContext, path: string, load: LoadTiming, layer: LayerSpec, issues: Issue[]): MemoryFile {
  const file: MemoryFile = { path, display: display(ctx, path), exists: false, writable: !layer.readonly && writable(path), load, bytes: 0, lines: 0, tokens: 0, entries: [], imports: [] };
  let content: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return file;
    file.exists = true;
    file.mtime = st.mtimeMs;
    file.bytes = st.size;
    if (st.size > MAX_READ) {
      issues.push({ level: 'warn', code: 'oversize', path, message: `${file.display} 超过 1 MiB，未解析内容` });
      return file;
    }
    content = readFileSync(path, 'utf8');
  } catch (err) {
    if (file.exists) issues.push({ level: 'error', code: 'unreadable', path, message: `${file.display} 无法读取: ${err instanceof Error ? err.message : err}` });
    return file;
  }
  const parsed = parseMemory(content);
  file.content = content;
  file.hash = sha(content);
  file.lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  file.tokens = estimateTokens(content);
  file.meta = parsed.meta;
  file.entries = parsed.entries;
  file.imports = parsed.imports.map((i) => ({ ...i, exists: false }));
  const globs = parsed.meta?.paths ?? parsed.meta?.globs;
  if (globs) {
    file.appliesTo = globs.split(',').map((s) => s.trim()).filter(Boolean);
    file.load = 'on-demand';
  }
  if (!content.trim()) issues.push({ level: 'info', code: 'empty', path, message: `${file.display} 是空文件` });

  const authorship = blame(path);
  file.tracked = !!authorship;
  file.history = authorship?.history;
  for (const e of file.entries) {
    let origin: Origin = { kind: 'untracked' };
    if (authorship) {
      const lines = authorship.lines.slice(e.start - 1, e.end);
      const newest = lines.reduce<Origin['commit']>((a, c) => (c && (!a || c.time > a.time) ? c : a), undefined);
      origin = lines.some((c) => !c) || !newest ? { kind: 'uncommitted' } : { kind: 'git', commit: newest };
    }
    if (layer.via && (layer.writer === 'agent' || e.heading.some((h) => /Gemini Added Memories/i.test(h)))) origin.via = layer.via;
    e.origin = origin;
  }
  return file;
}

function scanHarness(ctx: ScanContext, spec: HarnessSpec): Harness {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const layers: Layer[] = spec.layers.map((ls) => {
    const files: MemoryFile[] = [];
    const add = (f: MemoryFile) => { if (!seen.has(f.path)) { seen.add(f.path); files.push(f); } return f; };
    for (const group of ls.groups ?? []) {
      let winner: MemoryFile | undefined;
      for (const slot of group) {
        if (seen.has(slot.path)) continue;
        const f = add(readFile(ctx, slot.path, slot.load ?? ls.load, ls, issues));
        if (!ls.exclusive || !f.exists) continue;
        if (winner) {
          f.shadowedBy = winner.display;
          issues.push({ level: 'info', code: 'shadowed', path: f.path, message: `${f.display} 不会被读取：同目录的 ${winner.display} 优先` });
        } else if (f.content?.trim()) winner = f;
      }
    }
    for (const dir of ls.dirs ?? []) {
      // The index comes first: it is what loads, and it points at the rest.
      const main = dir.main ? join(dir.path, dir.main) : undefined;
      for (const path of [...(main ? [main] : []), ...listDir(dir.path, !!dir.recursive).filter((p) => p !== main)]) {
        const isMain = dir.main && path === join(dir.path, dir.main);
        const f = add(readFile(ctx, path, dir.main ? (isMain ? 'startup' : 'on-demand') : (dir.load ?? ls.load), ls, issues));
        if (isMain && ls.head && (f.lines > ls.head.lines || f.bytes > ls.head.bytes)) {
          issues.push({ level: 'warn', code: 'truncated', path, message: `${f.display} 有 ${f.lines} 行 / ${f.bytes} 字节，只有前 ${ls.head.lines} 行或 ${ls.head.bytes / 1000}KB 会在启动时载入，其后的内容对模型不可见` });
        }
      }
    }
    // @imports are expanded in place, up to five hops deep.
    if (spec.imports) {
      const queue = files.filter((f) => f.exists).map((f) => ({ f, depth: 0 }));
      for (let item; (item = queue.shift());) {
        for (const imp of item.f.imports) {
          const target = imp.target.startsWith('~') ? join(ctx.home, imp.target.slice(1)) : resolve(dirname(item.f.path), imp.target);
          let ok = false;
          try { ok = statSync(target).isFile(); } catch { /* missing */ }
          imp.exists = ok;
          imp.target = target;
          if (!ok) { issues.push({ level: 'warn', code: 'broken-import', path: item.f.path, line: imp.line, message: `${item.f.display}:${imp.line} 导入的 ${display(ctx, target)} 不存在` }); continue; }
          if (seen.has(target)) continue;
          if (item.depth >= 5) { issues.push({ level: 'warn', code: 'import-depth', path: item.f.path, line: imp.line, message: `${item.f.display}:${imp.line} 的导入超过 5 层，不会被展开` }); continue; }
          const child = add(readFile(ctx, target, item.f.load, ls, issues));
          child.importedBy = item.f.display;
          queue.push({ f: child, depth: item.depth + 1 });
        }
      }
    }
    return { id: ls.id, title: ls.title, scope: ls.scope, load: ls.load, writer: ls.writer, note: ls.note, readonly: ls.readonly, dirs: ls.readonly ? [] : (ls.dirs ?? []).map((d) => d.path), files };
  }).filter((l) => l.files.length || l.dirs.length);

  const loaded = layers.flatMap((l) => l.files.filter((f) => f.exists && f.load === 'startup' && !f.shadowedBy).map((f) => ({ l, f })));
  const head = spec.layers.find((l) => l.head)?.head;
  const effective = { bytes: 0, tokens: 0, files: loaded.length, limitBytes: spec.projectLimit };
  for (const { l, f } of loaded) {
    const cut = l.scope === 'auto' && head && f.content !== undefined ? f.content.split('\n').slice(0, head.lines).join('\n').slice(0, head.bytes) : undefined;
    effective.bytes += cut === undefined ? f.bytes : Buffer.byteLength(cut);
    effective.tokens += cut === undefined ? f.tokens : estimateTokens(cut);
  }
  if (spec.projectLimit) {
    const size = loaded.filter((x) => x.l.scope === 'project').reduce((a, x) => a + x.f.bytes, 0);
    if (size > spec.projectLimit) issues.push({ level: 'warn', code: 'oversize', message: `项目指令合计 ${size} 字节，超过 ${spec.projectLimit} 字节上限，靠后的文件会被截断或忽略` });
  }
  // The same sentence in two places costs context twice and drifts apart over time.
  const where = new Map<string, { f: MemoryFile; line: number }[]>();
  for (const l of layers) for (const f of l.files) for (const e of f.entries) {
    if (e.kind === 'code') continue;
    const key = e.text.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (key.length < 16) continue;
    where.set(key, [...(where.get(key) ?? []), { f, line: e.start }]);
  }
  for (const hits of where.values()) {
    if (hits.length < 2) continue;
    issues.push({ level: 'info', code: 'duplicate', path: hits[0].f.path, line: hits[0].line, message: `重复的记忆：${hits.map((h) => `${h.f.display}:${h.line}`).join('、')}` });
  }
  const detected = existsSync(spec.home) || layers.some((l) => l.files.some((f) => f.exists));
  return { id: spec.id, name: spec.name, detected, summary: spec.summary, layers, effective, issues };
}

export function scanMemory(ctx: MemoryContext): MemoryState {
  const root = gitRoot(ctx.cwd);
  const harnesses = HARNESSES.map((h) => scanHarness({ ...ctx, root }, h(ctx, root)));
  // A file read by several harnesses (AGENTS.md, or a symlinked CLAUDE.md) is one memory, not several.
  const readers = new Map<string, Set<string>>();
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const each = (fn: (h: Harness, f: MemoryFile, key: string) => void) => {
    for (const h of harnesses) for (const l of h.layers) for (const f of l.files) if (f.exists && !f.shadowedBy) fn(h, f, real(f.path));
  };
  each((h, _f, key) => readers.set(key, (readers.get(key) ?? new Set()).add(h.name)));
  each((h, f, key) => {
    const others = [...readers.get(key)!].filter((n) => n !== h.name);
    if (others.length) f.sharedWith = others;
  });
  return { cwd: ctx.cwd, home: ctx.home, root, harnesses };
}

/** The startup context of one harness, in load order, as the model would receive it. */
export function effectiveContext(state: MemoryState, harnessId: string): string {
  const h = state.harnesses.find((x) => x.id === harnessId);
  if (!h) throw new Error(`未知 harness ${harnessId}`);
  return h.layers.flatMap((l) => l.files.filter((f) => f.exists && f.load === 'startup' && !f.shadowedBy)
    .map((f) => `<!-- ${l.title} · ${f.display} -->\n${(f.content ?? '').trimEnd()}\n`)).join('\n');
}

/** A path may be written only if a scan offers it: a known slot, or a new file in a layer's directory. */
export function writableTarget(state: MemoryState, path: string): boolean {
  const target = resolve(path);
  for (const h of state.harnesses) for (const l of h.layers) {
    if (l.readonly) continue;
    if (l.files.some((f) => f.path === target)) return true;
    if (/\.md$/i.test(target) && l.dirs.some((d) => { const rel = relative(d, target); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); })) return true;
  }
  return false;
}
