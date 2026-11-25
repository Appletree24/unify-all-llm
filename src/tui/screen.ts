import type { SourceReference } from './source.js';
import type { AnswerReference } from './answer-source.js';

export interface Point { x: number; y: number }
export interface Rect extends Point { w: number; h: number }
export interface TextRange { from: Point; to: Point; bounds: Rect }

/** A character cell. w=0 marks the right half of a wide (CJK) character. */
export interface Cell {
  ch: string;
  st: string; // SGR parameters, e.g. "1;38;2;255;0;0"
  w: number;
  source?: SourceReference | AnswerReference;
}

export const rgb = (r: number, g: number, b: number) => `38;2;${r};${g};${b}`;

export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function toCells(text: string, st = ''): Cell[] {
  const out: Cell[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = charWidth(cp);
    if (w > 0) out.push({ ch, st, w });
    else if (cp >= 0x300 && out.length) {
      // Combining mark (x̂, x⃗): rides on the previous cell.
      const prev = out[out.length - 1];
      out[out.length - 1] = { ...prev, ch: prev.ch + ch };
    }
  }
  return out;
}

export const textWidth = (text: string) => toCells(text).reduce((a, c) => a + c.w, 0);

/** Cut text to at most `width` columns, ending in … when shortened. */
export function truncate(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const c of toCells(text)) {
    if (w + c.w > width - 1) break;
    out += c.ch;
    w += c.w;
  }
  return out + '…';
}

const BLANK: Cell = { ch: ' ', st: '', w: 1 };

/** An off-screen grid that is composed every frame and then diffed line by line. */
export class Screen {
  private grid: Cell[][];

  constructor(
    public readonly cols: number,
    public readonly rows: number,
  ) {
    this.grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => BLANK));
  }

  private set(x: number, y: number, c: Cell): void {
    const row = this.grid[y];
    // Do not leave half of a wide character behind.
    if (row[x].w === 0 && x > 0) row[x - 1] = BLANK;
    if (row[x].w === 2 && x + 1 < this.cols) row[x + 1] = BLANK;
    row[x] = c;
  }

  /** Draw cells starting at (x, y), clipped to maxX (exclusive). Returns the next x. */
  putCells(x: number, y: number, cells: Cell[], maxX = this.cols): number {
    if (y < 0 || y >= this.rows) return x;
    const limit = Math.min(maxX, this.cols);
    for (const c of cells) {
      if (x < 0 || x + c.w > limit) break;
      this.set(x, y, c);
      if (c.w === 2) this.set(x + 1, y, { ch: '', st: c.st, w: 0 });
      x += c.w;
    }
    return x;
  }

  put(x: number, y: number, text: string, st = '', maxX = this.cols): number {
    return this.putCells(x, y, toCells(text, st), maxX);
  }

  sourceAt({ x, y }: Point): Cell['source'] {
    const row = this.grid[y];
    const cell = row?.[x];
    return cell?.w === 0 ? row[x - 1]?.source : cell?.source;
  }

  select({ from, to, bounds }: TextRange, highlight = false): string {
    const right = Math.min(bounds.x + bounds.w - 1, this.cols - 1);
    const bottom = Math.min(bounds.y + bounds.h - 1, this.rows - 1);
    if (right < bounds.x || bottom < bounds.y) return '';
    const clip = (p: Point) => ({
      x: Math.max(bounds.x, Math.min(right, p.x)),
      y: Math.max(bounds.y, Math.min(bottom, p.y)),
    });
    let start = clip(from), end = clip(to);
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) [start, end] = [end, start];
    const selected: string[] = [];
    for (let y = start.y; y <= end.y; y++) {
      const row = this.grid[y];
      let left = y === start.y ? start.x : bounds.x;
      const last = y === end.y ? end.x : right;
      if (row[left]?.w === 0 && left > bounds.x) left--;
      const cells = row.slice(left, last + 1);
      selected.push(cells.map(cell => cell.ch).join('').trimEnd());
      if (highlight) cells.forEach((cell, i) => { row[left + i] = { ...cell, st: cell.st ? `${cell.st};7` : '7' }; });
    }
    return selected.join('\n').replace(/\n+$/, '');
  }

  toLines(): string[] {
    return this.grid.map((row) => {
      let out = '';
      let cur = '';
      for (const c of row) {
        if (c.w === 0) continue;
        if (c.st !== cur) {
          out += '\x1b[0m' + (c.st ? `\x1b[${c.st}m` : '');
          cur = c.st;
        }
        out += c.ch;
      }
      return out + '\x1b[0m';
    });
  }

  toPlain(): string[] {
    return this.grid.map((row) => row.map((c) => c.ch).join('').replace(/\s+$/, ''));
  }
}
