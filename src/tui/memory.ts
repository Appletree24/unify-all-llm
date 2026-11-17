import { editEntry, listBackups, restoreBackup } from '../memory/edit.js';
import { effectiveContext, scanMemory } from '../memory/scan.js';
import type { Entry, Harness, Layer, MemoryContext, MemoryFile, MemoryState } from '../memory/types.js';
import { Editor } from './editor.js';
import type { Key } from './keys.js';
import { Screen, charWidth, rgb, textWidth, truncate } from './screen.js';

const ACCENT = rgb(232, 196, 104);
const DIM = rgb(120, 125, 135);
const BORDER = rgb(72, 76, 86);
const RED = rgb(240, 90, 90);
const YELLOW = rgb(235, 190, 90);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const LOAD = { startup: '启动时载入', 'on-demand': '按需载入' } as const;
const WRITER = { human: '人工维护', agent: '模型写入', admin: '管理员下发' } as const;

function ago(ms: number | undefined): string {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Hard-wrap to a column width, counting wide characters as two. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let cur = '';
    let w = 0;
    for (const ch of line.replace(/\t/g, '  ')) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (w + cw > width && cur) { out.push(cur); cur = ''; w = 0; }
      cur += ch;
      w += cw;
    }
    out.push(cur);
  }
  return out;
}

/** Keep the end of a path: the file name matters more than its prefix. */
function tail(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  const chars = Array.from(text);
  let w = 1;
  let i = chars.length;
  while (i > 0 && w + charWidth(chars[i - 1].codePointAt(0)!) <= width) w += charWidth(chars[--i].codePointAt(0)!);
  return '…' + chars.slice(i).join('');
}

interface Row { layer: Layer; index: number; file?: MemoryFile }
interface Line { text: string; st?: string; entry?: number; indent?: number }
interface Target { path: string; label: string }
type Mode =
  | { kind: 'browse' }
  | { kind: 'input'; purpose: 'edit' | 'add' | 'search'; title: string; ed: Editor }
  | { kind: 'confirm'; text: string; yes: () => void }
  | { kind: 'pick'; op: 'copy' | 'move'; targets: Target[]; sel: number }
  | { kind: 'text'; title: string; lines: Line[]; scroll: number };

export interface MemoryViewHooks {
  close(): void;
  /** Start the web interface and return its address. */
  web(): Promise<string>;
}

/**
 * The memory manager inside the terminal: a harness's layers and files on the
 * left in load order, the selected file's memories and where they came from on
 * the right. Edits go through the same guarded, backed-up path as the web UI.
 */
export class MemoryView {
  private state: MemoryState;
  private hi = 0;
  private sel = 0;
  private treeTop = 0;
  private pane: 'tree' | 'entries' = 'tree';
  private esel = 0;
  private detailTop = 0;
  private query = '';
  private mode: Mode = { kind: 'browse' };
  private msg = '';
  private msgColor = DIM;
  private bodyH = 10;

  constructor(private ctx: MemoryContext, private hooks: MemoryViewHooks) {
    this.state = scanMemory(ctx);
    this.hi = Math.max(0, this.state.harnesses.findIndex((h) => h.detected));
    this.sel = this.firstFile();
  }

  private get harness(): Harness { return this.state.harnesses[this.hi]; }
  private rows(): Row[] {
    return this.harness.layers.flatMap((layer, index) => [{ layer, index }, ...layer.files.map((file) => ({ layer, index, file }))]);
  }
  private firstFile(): number { return Math.max(0, this.rows().findIndex((r) => r.file?.exists)); }
  private row(): Row | undefined { return this.rows()[this.sel]; }
  private entries(f: MemoryFile | undefined): Entry[] {
    const q = this.query.toLowerCase();
    return (f?.entries ?? []).filter((e) => !q || e.text.toLowerCase().includes(q) || e.heading.join(' ').toLowerCase().includes(q));
  }
  private say(text: string, color = DIM): void { this.msg = text; this.msgColor = color; }

  /** Re-read everything, keeping the selection on the same file. */
  private rescan(): void {
    const path = this.row()?.file?.path;
    this.state = scanMemory(this.ctx);
    this.hi = clamp(this.hi, 0, this.state.harnesses.length - 1);
    const at = this.rows().findIndex((r) => r.file?.path === path);
    this.sel = at >= 0 ? at : clamp(this.sel, 0, Math.max(0, this.rows().length - 1));
    this.esel = clamp(this.esel, 0, Math.max(0, this.entries(this.row()?.file).length - 1));
  }

  private attempt(done: string, fn: () => void): void {
    try { fn(); this.say(done, ACCENT); }
    catch (err) { this.say(err instanceof Error ? err.message : String(err), RED); }
    this.rescan();
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  handleKey(k: Key): void {
    if (k.name === 'wheelup' || k.name === 'wheeldown') {
      for (let i = 0; i < 3; i++) this.handleKey({ name: k.name === 'wheelup' ? 'up' : 'down' });
      return;
    }
    if (k.name === 'click') return;
    this.msg = '';
    const m = this.mode;
    if (m.kind === 'input') return this.inputKey(m, k);
    if (m.kind === 'confirm') {
      this.mode = { kind: 'browse' };
      if (k.name === 'char' && /^[yY]$/.test(k.text ?? '')) m.yes();
      else this.say('已取消');
      return;
    }
    const ch = k.name === 'char' ? k.text ?? '' : '';
    const move = k.name === 'up' || ch === 'k' ? -1 : k.name === 'down' || ch === 'j' ? 1 : k.name === 'pgup' ? -this.bodyH : k.name === 'pgdn' || ch === ' ' ? this.bodyH : 0;
    const back = k.name === 'esc' || k.name === 'ctrl+c' || ch === 'q';
    if (m.kind === 'text') {
      if (back || k.name === 'left' || ch === 'h') this.mode = { kind: 'browse' };
      else if (move) m.scroll = clamp(m.scroll + move, 0, Math.max(0, m.lines.length - this.bodyH));
      else if (k.name === 'home' || ch === 'g') m.scroll = 0;
      else if (k.name === 'end' || ch === 'G') m.scroll = Math.max(0, m.lines.length - this.bodyH);
      return;
    }
    if (m.kind === 'pick') {
      if (back) this.mode = { kind: 'browse' };
      else if (move) m.sel = clamp(m.sel + Math.sign(move), 0, m.targets.length - 1);
      else if (k.name === 'enter') this.transfer(m.op, m.targets[m.sel]);
      return;
    }
    const rows = this.rows();
    const file = this.row()?.file;
    const list = this.entries(file);
    if (back) {
      if (this.pane === 'entries') this.pane = 'tree';
      else if (this.query) this.query = '';
      else this.hooks.close();
    } else if (k.name === 'tab' || k.name === 'shifttab' || /^[1-9]$/.test(ch)) {
      const n = this.state.harnesses.length;
      const next = ch ? Number(ch) - 1 : (this.hi + (k.name === 'tab' ? 1 : -1) + n) % n;
      if (next < n) { this.hi = next; this.sel = this.firstFile(); this.treeTop = 0; this.pane = 'tree'; this.esel = 0; }
    } else if (move) {
      if (this.pane === 'tree') { this.sel = clamp(this.sel + move, 0, rows.length - 1); this.esel = 0; this.detailTop = 0; }
      else this.esel = clamp(this.esel + Math.sign(move) * (Math.abs(move) > 1 ? 5 : 1), 0, Math.max(0, list.length - 1));
    } else if (k.name === 'home' || ch === 'g') { if (this.pane === 'tree') this.sel = 0; else this.esel = 0; }
    else if (k.name === 'end' || ch === 'G') { if (this.pane === 'tree') this.sel = rows.length - 1; else this.esel = Math.max(0, list.length - 1); }
    else if (k.name === 'right' || k.name === 'enter' || ch === 'l') {
      if (list.length) this.pane = 'entries';
      else if (file && !file.exists && file.writable) this.startAdd(file);
    } else if (k.name === 'left' || ch === 'h') this.pane = 'tree';
    else if (ch === '/') this.mode = { kind: 'input', purpose: 'search', title: '搜索这个工具的记忆', ed: this.editor(this.query) };
    else if (ch === 'r') { this.rescan(); this.say('已重新扫描'); }
    else if (ch === 'x') this.showEffective();
    else if (ch === 'i') this.showIssues();
    else if (ch === 'u') this.undo();
    else if (ch === 'w') { this.say('正在启动网页界面…'); this.hooks.web().then((url) => this.say(`网页界面（仅本机）: ${url}`, ACCENT), (err) => this.say(String(err instanceof Error ? err.message : err), RED)); }
    else if (ch === 'a') { if (file) this.startAdd(file); }
    else if ('edcm'.includes(ch) && ch) {
      const entry = this.pane === 'entries' ? list[this.esel] : undefined;
      if (!file || !entry) return this.say('先用 → 或 Enter 进入右侧，选中一条记忆', YELLOW);
      if (!file.writable) return this.say('这一层是只读的', YELLOW);
      if (ch === 'e') this.mode = { kind: 'input', purpose: 'edit', title: `编辑 ${file.display} 第 ${entry.start} 行`, ed: this.editor(entry.text) };
      else if (ch === 'd') this.mode = { kind: 'confirm', text: `按 y 删除这条记忆（可用 u 撤销）· 其他键取消`, yes: () => this.attempt('已删除，按 u 撤销', () => editEntry(this.ctx, { op: 'delete', path: file.path, baseHash: file.hash, start: entry.start, end: entry.end })) };
      else {
        const targets = this.state.harnesses.flatMap((h) => h.layers.flatMap((l) => l.files.filter((t) => t.writable && !t.shadowedBy && t.path !== file.path)
          .map((t) => ({ path: t.path, label: `${h.name} · ${l.title} · ${t.display}${t.exists ? '' : '（新建）'}` }))));
        const seen = new Set<string>();
        this.mode = { kind: 'pick', op: ch === 'c' ? 'copy' : 'move', targets: targets.filter((t) => !seen.has(t.path) && seen.add(t.path)), sel: 0 };
      }
    }
  }

  private editor(text: string): Editor {
    const ed = new Editor();
    ed.set(text);
    return ed;
  }

  private startAdd(file: MemoryFile): void {
    if (!file.writable) return this.say('这一层是只读的', YELLOW);
    this.mode = { kind: 'input', purpose: 'add', title: `新增到 ${file.display}${file.exists ? '' : '（将创建文件）'}`, ed: this.editor('- ') };
  }

  private inputKey(m: Extract<Mode, { kind: 'input' }>, k: Key): void {
    const ed = m.ed;
    const file = this.row()?.file;
    if (k.name === 'esc' || k.name === 'ctrl+c') { this.mode = { kind: 'browse' }; return this.say('已取消'); }
    if (k.name === 'enter') {
      this.mode = { kind: 'browse' };
      const text = ed.text;
      if (m.purpose === 'search') { this.query = text.trim(); this.esel = 0; return; }
      if (!file) return;
      if (m.purpose === 'add') return this.attempt('已新增', () => editEntry(this.ctx, { op: 'add', path: file.path, baseHash: file.exists ? file.hash : '', text }));
      const entry = this.entries(file)[this.esel];
      if (entry) this.attempt('已保存，按 u 撤销', () => editEntry(this.ctx, { op: 'update', path: file.path, baseHash: file.hash, start: entry.start, end: entry.end, text }));
      return;
    }
    switch (k.name) {
      case 'char': case 'paste': ed.insert(k.text ?? ''); break;
      case 'altenter': case 'ctrl+j': if (m.purpose !== 'search') ed.insert('\n'); break;
      case 'backspace': ed.backspace(); break;
      case 'delete': case 'ctrl+d': ed.del(); break;
      case 'left': ed.left(); break;
      case 'right': ed.right(); break;
      case 'up': ed.vertical(-1); break;
      case 'down': ed.vertical(1); break;
      case 'wordleft': ed.wordLeft(); break;
      case 'wordright': ed.wordRight(); break;
      case 'wordback': case 'ctrl+w': ed.deleteWordBack(); break;
      case 'worddel': ed.deleteWordForward(); break;
      case 'home': case 'ctrl+a': ed.home(); break;
      case 'end': case 'ctrl+e': ed.end(); break;
      case 'ctrl+u': ed.killToStart(); break;
      case 'ctrl+k': ed.killToEnd(); break;
    }
  }

  private transfer(op: 'copy' | 'move', to: Target): void {
    const file = this.row()?.file;
    const entry = this.entries(file)[this.esel];
    this.mode = { kind: 'browse' };
    if (!file || !entry) return;
    this.attempt(op === 'move' ? '已移动，按 u 撤销' : '已复制，按 u 撤销', () => editEntry(this.ctx, { op, path: file.path, baseHash: file.hash, start: entry.start, end: entry.end, to: to.path, heading: entry.heading[entry.heading.length - 1] || undefined }));
  }

  private undo(): void {
    const last = listBackups(this.ctx)[0];
    if (!last) return this.say('没有可撤销的修改');
    const name = last.path.split('/').slice(-2).join('/');
    this.mode = { kind: 'confirm', text: `按 y 把 ${name} 恢复到「${last.reason}」之前（${ago(last.time)}）· 其他键取消`, yes: () => this.attempt(`已恢复 ${name}`, () => restoreBackup(this.ctx, last.id)) };
  }

  private showEffective(): void {
    const lines = effectiveContext(this.state, this.harness.id).split('\n').map((text): Line => ({ text, st: text.startsWith('<!--') ? ACCENT : undefined }));
    this.mode = { kind: 'text', title: `${this.harness.name} 启动时的记忆上下文（按载入顺序拼接）`, lines, scroll: 0 };
  }

  private showIssues(): void {
    const lines = this.harness.issues.map((i): Line => ({ text: `${i.level === 'info' ? '·' : '!'} ${i.message}`, st: i.level === 'error' ? RED : i.level === 'warn' ? YELLOW : undefined }));
    this.mode = { kind: 'text', title: `${this.harness.name} 的问题与建议`, lines: lines.length ? lines : [{ text: '没有发现问题', st: DIM }], scroll: 0 };
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  /** Draw the whole screen; returns where the terminal cursor belongs, if anywhere. */
  draw(s: Screen): { x: number; y: number } | null {
    const h = this.harness;
    let x = s.put(1, 0, '记忆', `1;${ACCENT}`) + 2;
    this.state.harnesses.forEach((hn, i) => {
      const on = i === this.hi;
      x = s.put(x, 0, `${i + 1} ${hn.name}`, on ? '1;4' : hn.detected ? '' : DIM) + 3;
    });
    const right = h.detected ? `启动载入 ${h.effective.files} 个文件 · 约 ${h.effective.tokens} tokens${h.issues.length ? ` · ${h.issues.length} 个问题` : ''}` : '未使用';
    if (s.cols - textWidth(right) - 1 > x) s.put(s.cols - textWidth(right) - 1, 0, right, DIM);
    s.put(1, 1, truncate(h.summary, s.cols - 2), DIM);
    s.put(0, 2, '─'.repeat(s.cols), BORDER);

    const m = this.mode;
    const inputLines = m.kind === 'input' ? wrap(m.ed.text || ' ', s.cols - 4) : [];
    const inputH = m.kind === 'input' ? Math.min(inputLines.length, Math.max(1, Math.floor(s.rows / 3))) + 2 : 0;
    const top = 3;
    const bodyH = (this.bodyH = Math.max(1, s.rows - top - 2 - inputH));
    let cursor: { x: number; y: number } | null = null;

    if (m.kind === 'text') {
      s.put(1, top, truncate(m.title, s.cols - 2), '1');
      const lines = m.lines.flatMap((l) => wrap(l.text, s.cols - 2).map((text) => ({ ...l, text })));
      m.lines = lines;
      m.scroll = clamp(m.scroll, 0, Math.max(0, lines.length - (bodyH - 2)));
      lines.slice(m.scroll, m.scroll + bodyH - 2).forEach((l, i) => s.put(1, top + 2 + i, l.text, l.st ?? ''));
    } else {
      const tw = clamp(Math.floor(s.cols * 0.4), 26, 56);
      this.drawTree(s, top, bodyH, tw);
      for (let i = 0; i < bodyH; i++) s.put(tw, top + i, '│', BORDER);
      if (m.kind === 'pick') this.drawPick(s, m, tw + 2, top, s.cols - tw - 3, bodyH);
      else this.drawDetail(s, tw + 2, top, s.cols - tw - 3, bodyH);
    }

    const base = s.rows - 2 - inputH;
    if (m.kind === 'input') {
      s.put(0, base, '─'.repeat(s.cols), ACCENT);
      s.put(2, base, ` ${truncate(m.title, s.cols - 30)} `, `1;${ACCENT}`);
      // Find the caret's wrapped position by wrapping the text before it.
      const before = wrap(m.ed.chars.slice(0, m.ed.caret).join('') || '', s.cols - 4);
      const cy = before.length - 1;
      const first = clamp(cy - (inputH - 2) + 1, 0, Math.max(0, inputLines.length - (inputH - 2)));
      inputLines.slice(first, first + inputH - 2).forEach((l, i) => s.put(2, base + 1 + i, l));
      cursor = { x: 2 + textWidth(before[cy]), y: base + 1 + cy - first };
    }
    const y = s.rows - 2;
    if (m.kind === 'confirm') s.put(1, y, truncate(m.text, s.cols - 2), `1;${YELLOW}`);
    else if (this.msg) s.put(1, y, truncate(this.msg, s.cols - 2), this.msgColor);
    else if (this.query) s.put(1, y, truncate(`筛选: ${this.query}（Esc 清除）`, s.cols - 2), ACCENT);
    const hints = m.kind === 'input' ? (m.purpose === 'search' ? ['Enter 确定', 'Esc 取消'] : ['Enter 保存', 'Shift+Enter 换行', 'Esc 取消'])
      : m.kind === 'pick' ? ['↑↓ 选择', 'Enter 确定', 'Esc 取消']
      : m.kind === 'text' ? ['↑↓ 滚动', 'Esc 返回']
      : this.pane === 'tree' ? ['↑↓ 选择', '→ 查看记忆', 'Tab 切换工具', 'a 新增', 'x 拼接结果', 'i 问题', '/ 搜索', 'u 撤销', 'w 网页', 'q 返回']
      : ['↑↓ 选择', 'e 编辑', 'd 删除', 'c 复制到', 'm 移动到', 'a 新增', 'u 撤销', '← 返回'];
    let hx = 1;
    for (const hint of hints) {
      if (hx + textWidth(hint) + 3 > s.cols) break;
      const [key, ...rest] = hint.split(' ');
      hx = s.put(hx, s.rows - 1, key, '');
      hx = s.put(hx, s.rows - 1, ' ' + rest.join(' '), DIM) + 3;
    }
    return cursor;
  }

  private drawTree(s: Screen, top: number, h: number, w: number): void {
    const rows = this.rows();
    this.treeTop = clamp(this.treeTop, Math.max(0, this.sel - h + 1), this.sel);
    rows.slice(this.treeTop, this.treeTop + h).forEach((r, i) => {
      const y = top + i;
      const on = this.treeTop + i === this.sel;
      const mark = on ? (this.pane === 'tree' ? `1;${ACCENT}` : '1') : '';
      if (on) s.put(0, y, '›', this.pane === 'tree' ? ACCENT : DIM);
      if (!r.file) {
        const x = s.put(2, y, `${r.index + 1} ${r.layer.title}`, mark || '1', w - 1);
        s.put(x + 2, y, truncate(`${r.layer.load === 'startup' ? '启动' : '按需'} · ${WRITER[r.layer.writer].slice(0, 2)}`, Math.max(0, w - x - 3)), DIM, w - 1);
        return;
      }
      const f = r.file;
      const count = f.exists ? String(this.query ? this.entries(f).length : f.entries.length) : '';
      s.put(4, y, f.shadowedBy ? '◌' : f.exists ? '●' : '○', f.exists && !f.shadowedBy ? '' : DIM, w - 1);
      s.put(6, y, tail(f.display, w - 8 - count.length - 1), mark || (f.exists && !f.shadowedBy ? '' : DIM), w - 1);
      if (count) s.put(w - 1 - count.length, y, count, DIM, w);
    });
  }

  private drawDetail(s: Screen, x: number, top: number, w: number, h: number): void {
    const row = this.row();
    if (!row) return;
    const { layer, file } = row;
    const lines: Line[] = [];
    const push = (text: string, st?: string, extra: Partial<Line> = {}) => wrap(text, w - (extra.indent ?? 0)).forEach((t) => lines.push({ text: t, st, ...extra }));
    if (!file) {
      push(`${row.index + 1} ${layer.title}`, '1');
      push(`${LOAD[layer.load]} · ${WRITER[layer.writer]}${layer.readonly ? ' · 只读' : ''}`, DIM);
      lines.push({ text: '' });
      push(layer.note);
      lines.push({ text: '' });
      push(`${layer.files.filter((f) => f.exists).length} 个文件，${layer.files.reduce((a, f) => a + f.entries.length, 0)} 条记忆`, DIM);
    } else {
      push(file.display, '1');
      push(`${layer.title} · ${LOAD[file.load]} · ${WRITER[layer.writer]}${file.writable ? '' : ' · 只读'}`, DIM);
      if (!file.exists) {
        lines.push({ text: '' });
        push(layer.readonly ? '未配置。' : '尚未创建。按 a 写入第一条记忆，文件会随之创建。', DIM);
      } else {
        const facts = [`${file.lines} 行`, `约 ${file.tokens} tokens`, `修改于 ${ago(file.mtime)}`, file.tracked ? '' : '未纳入 Git',
          file.shadowedBy ? `被 ${file.shadowedBy} 取代，不会被读取` : '', file.importedBy ? `由 ${file.importedBy} 导入` : '',
          file.appliesTo ? `仅对 ${file.appliesTo.join(', ')} 生效` : '', file.sharedWith ? `与 ${file.sharedWith.join('、')} 共用` : ''];
        push(facts.filter(Boolean).join(' · '), DIM);
        if (file.meta?.description) push(file.meta.description, DIM);
        let last: string | undefined;
        const list = this.entries(file);
        list.forEach((e, i) => {
          const path = e.heading.filter(Boolean).join(' › ');
          lines.push({ text: '' });
          if (path !== last) { if (path) { push(path, `1;${DIM}`); } last = path; }
          const on = this.pane === 'entries' && i === this.esel;
          const body = e.kind === 'bullet' ? e.text.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\n {2}/g, '\n') : e.text;
          push(body, on ? '1' : '', { entry: i, indent: 2 });
          const o = e.origin;
          const from = [o?.via, o?.kind === 'git' && o.commit ? `${o.commit.author} · ${ago(o.commit.time)} · ${o.commit.summary}` : o?.kind === 'uncommitted' ? '未提交的改动' : `文件修改于 ${ago(file.mtime)}`].filter(Boolean).join(' · ');
          push(from, DIM, { entry: i, indent: 2 });
        });
        if (!list.length) { lines.push({ text: '' }); push(this.query ? '没有匹配的记忆' : '（没有内容）', DIM); }
      }
    }
    // Keep the selected memory in view.
    if (this.pane === 'entries') {
      const first = lines.findIndex((l) => l.entry === this.esel);
      const last = lines.reduce((a, l, i) => (l.entry === this.esel ? i : a), first);
      if (first >= 0) this.detailTop = clamp(this.detailTop, last - h + 1, Math.max(0, first - 1));
    } else this.detailTop = 0;
    this.detailTop = clamp(this.detailTop, 0, Math.max(0, lines.length - h));
    lines.slice(this.detailTop, this.detailTop + h).forEach((l, i) => {
      const y = top + i;
      const on = this.pane === 'entries' && l.entry === this.esel;
      if (on) s.put(x, y, '›', ACCENT);
      s.put(x + (l.indent ?? 0), y, l.text, l.st ?? '', x + w);
    });
  }

  private drawPick(s: Screen, m: Extract<Mode, { kind: 'pick' }>, x: number, top: number, w: number, h: number): void {
    s.put(x, top, m.op === 'move' ? '移动到' : '复制到', '1');
    const first = clamp(m.sel - (h - 3), 0, Math.max(0, m.targets.length - (h - 2)));
    m.targets.slice(first, first + h - 2).forEach((t, i) => {
      const on = first + i === m.sel;
      if (on) s.put(x, top + 2 + i, '›', ACCENT);
      s.put(x + 2, top + 2 + i, tail(t.label, w - 2), on ? `1;${ACCENT}` : '', x + w);
    });
  }

  /** Plain rows for tests and snapshots. */
  selection(): { harness: string; file?: string; entry?: string } {
    const file = this.row()?.file;
    return { harness: this.harness.id, file: file?.path, entry: this.pane === 'entries' ? this.entries(file)[this.esel]?.text : undefined };
  }
}
