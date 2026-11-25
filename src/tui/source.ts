import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Key } from './keys.js';
import { Screen, rgb, textWidth, toCells, truncate, type Cell } from './screen.js';

export interface SourceReference {
  path: string;
  line?: number;
  column?: number;
}

export function sourceReference(value: string, explicit = false): SourceReference | undefined {
  const text = value.trim().replace(/^<(.+)>$/, '$1').replace(/[.,;:!?]+$/, '');
  const suffix = /#L(\d+)(?:-L?\d+)?$|:(\d+)(?::(\d+)|-\d+)?$/i.exec(text);
  let path = (suffix ? text.slice(0, suffix.index) : text).replace(/^@/, '');
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path); } catch { return; }
  } else if (explicit && /%[0-9a-f]{2}/i.test(path)) {
    try { path = decodeURIComponent(path); } catch { return; }
  }
  if (!path || /[#?]/.test(path) || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) return;
  const looksLikeFile = /[\\/].*[\p{L}\p{N}_.-]/u.test(path) || /\.(?:[\p{L}_][\p{L}\p{N}_-]*)$/u.test(path)
    || /^(?:Dockerfile|Makefile|Gemfile|LICENSE)$/i.test(path);
  if (!looksLikeFile && !explicit) return;
  const line = Number(suffix?.[1] ?? suffix?.[2]);
  const column = Number(suffix?.[3]);
  return { path, line: Number.isSafeInteger(line) && line > 0 ? line : undefined, column: Number.isSafeInteger(column) && column > 0 ? column : undefined };
}

export function sourceCells(text: string, style: string): Cell[] {
  const cells: Cell[] = [];
  const underline = style ? style + ';4' : '4';
  let offset = 0;
  for (const match of text.matchAll(/[^\s"'<>()[\]{}\x60，。；：！？、]+/gu)) {
    const ref = sourceReference(match[0]);
    if (!ref) continue;
    const token = match[0].replace(/[.,;:!?]+$/, '');
    cells.push(...toCells(text.slice(offset, match.index), style), ...toCells(token, underline).map(cell => ({ ...cell, source: ref })));
    offset = match.index + token.length;
  }
  cells.push(...toCells(text.slice(offset), style));
  return cells;
}

const DIM = rgb(120, 125, 135);
const ACCENT = rgb(232, 196, 104);
const MAX_SOURCE_SIZE = 8 * 1024 * 1024;

/** Read-only view of a file referenced in the current conversation. */
export class SourceView {
  private readonly lines: string[];
  private readonly target: number;
  private top: number;
  private page = 1;
  private offset = 0;

  constructor(cwd: string, readonly ref: SourceReference) {
    const path = /^~[\\/]/.test(ref.path) ? resolve(homedir(), ref.path.slice(2)) : resolve(cwd, ref.path);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('请选择文本文件');
    if (stat.size > MAX_SOURCE_SIZE) throw new Error('文件超过 8 MiB');
    const data = stat.size ? readFileSync(path) : Buffer.alloc(0);
    if (data.subarray(0, 8192).includes(0)) throw new Error('请选择文本文件');
    this.lines = data.toString('utf8').replace(/\n$/, '').split(/\r?\n/);
    this.target = Math.min((ref.line ?? 1) - 1, this.lines.length - 1);
    this.top = Math.max(0, this.target - 3);
    this.offset = Math.max(0, (ref.column ?? 1) - 1);
  }

  handleKey(key: Key): void {
    switch (key.name) {
      case 'up': this.top--; break;
      case 'down': this.top++; break;
      case 'wheelup': this.top -= 3; break;
      case 'wheeldown': this.top += 3; break;
      case 'pgup': this.top -= this.page; break;
      case 'pgdn': this.top += this.page; break;
      case 'home': this.top = this.offset = 0; break;
      case 'end': this.top = this.lines.length - 1; break;
      case 'left': this.offset = Math.max(0, this.offset - 8); break;
      case 'right': this.offset += 8; break;
    }
  }

  draw(s: Screen): void {
    this.page = s.rows - 3;
    this.top = Math.max(0, Math.min(this.top, this.lines.length - this.page));
    const title = [this.ref.path, this.ref.line && this.target + 1, this.ref.column].filter(Boolean).join(':');
    s.put(1, 0, truncate(title, s.cols - 2), '1;' + ACCENT);
    const digits = String(this.lines.length).length;
    this.lines.slice(this.top, this.top + this.page).forEach((line, i) => {
      const y = i + 2;
      const current = this.top + i;
      const active = current === this.target;
      const label = (active ? '› ' : '  ') + String(current + 1).padStart(digits) + ' │ ';
      const x = s.put(1, y, label, active ? ACCENT : DIM);
      const cells = toCells(line.replace(/\t/g, '    '), active ? '1' : '');
      const first = active ? Math.min(this.offset, Math.max(0, cells.length - (s.cols - x - 2))) : this.offset;
      s.putCells(x, y, cells.slice(first), s.cols - 1);
    });
    const count = String(this.top + 1) + '/' + this.lines.length;
    s.put(1, s.rows - 1, truncate('Esc 返回 · ↑↓ 滚动 · ←→ 横移', s.cols - textWidth(count) - 4), DIM);
    s.put(s.cols - textWidth(count) - 1, s.rows - 1, count, DIM);
  }
}
