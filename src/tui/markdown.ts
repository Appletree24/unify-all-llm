import { rgb, toCells, type Cell } from './screen.js';
import { sourceCells, sourceReference } from './source.js';
import { tex } from './tex.js';

const DIM = rgb(120, 125, 135);
const RULE = rgb(72, 76, 86);
const CODE = rgb(150, 190, 225);
const BLOCK = rgb(140, 175, 165);
const MATH = rgb(205, 175, 245);
const QUOTE = rgb(165, 170, 180);
const RED = rgb(240, 90, 90);
const NO_LINE_START = '，。、；：？！）」』】》”’,.;:?!)';

const space = (n: number): Cell[] => Array.from({ length: Math.max(0, n) }, () => ({ ch: ' ', st: '', w: 1 }));
const widthOf = (cells: Cell[]) => cells.reduce((a, c) => a + c.w, 0);
const add = (base: string, extra: string) => (base ? `${extra};${base}` : extra);

/** Wrap to `width` columns. Latin words break at spaces, CJK breaks anywhere. */
export function wrap(cells: Cell[], width: number, hang = 0): Cell[][] {
  width = Math.max(4, width);
  if (width <= hang + 4) hang = 0;
  const out: Cell[][] = [];
  let line: Cell[] = [];
  let w = 0;
  let lastSpace = -1;
  for (const c of cells) {
    if (w + c.w > width) {
      const isWordChar = c.w === 1 && c.ch !== ' ' && c.ch.charCodeAt(0) < 0x250;
      if (isWordChar && lastSpace >= hang) {
        const rest = line.splice(lastSpace + 1);
        out.push(line);
        line = [...space(hang), ...rest];
      } else if (NO_LINE_START.includes(c.ch) && line.length > hang + 1) {
        // Closing punctuation must not start a line: carry the previous character down with it.
        const carried = line.pop()!;
        out.push(line);
        line = [...space(hang), carried];
      } else {
        out.push(line);
        line = space(hang);
        if (c.ch === ' ') {
          w = hang;
          lastSpace = -1;
          continue;
        }
      }
      w = widthOf(line);
      lastSpace = -1;
    }
    if (c.ch === ' ') lastSpace = line.length;
    line.push(c);
    w += c.w;
  }
  out.push(line);
  return out;
}

const withPrefix = (lines: Cell[][], prefix: Cell[]) => lines.map((l) => [...prefix, ...l]);

// One alternation per inline construct. Half-streamed markers simply do not match yet.
const INLINE = new RegExp(
  [
    '(`+)(.+?)\\1', // 1,2 code
    '\\*\\*(?!\\s)(.+?)\\*\\*', // 3 bold
    '(?<![\\p{L}\\p{N}])__(?!\\s)(.+?)__(?![\\p{L}\\p{N}])', // 4 bold
    '~~(?!\\s)(.+?)~~', // 5 strike
    '\\*(?![\\s*])(.+?)(?<!\\s)\\*', // 6 italic
    '(?<![\\p{L}\\p{N}_])_(?![\\s_])(.+?)(?<!\\s)_(?![\\p{L}\\p{N}_])', // 7 italic
    '!?\\[([^\\]\\n]+)\\]\\((<[^>\\n]+>|[^)\\s]+)(?:\\s+"[^"]*")?\\)', // 8,9 link
    '\\$(?![\\s$])([^$\\n]+?)(?<!\\s)\\$(?!\\d)', // 10 $math$
    '\\\\\\((.+?)\\\\\\)', // 11 \(math\)
    '\\\\([\\\\`*_{}\\[\\]()#+\\-.!$~|>])', // 12 escaped character
  ].join('|'),
  'gu',
);

function inline(text: string, base: string): Cell[] {
  const cells: Cell[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) cells.push(...sourceCells(text.slice(last, m.index), base));
    last = m.index! + m[0].length;
    if (m[2] !== undefined) cells.push(...sourceCells(m[2], CODE));
    else if (m[3] !== undefined || m[4] !== undefined) cells.push(...inline(m[3] ?? m[4], add(base, '1')));
    else if (m[5] !== undefined) cells.push(...inline(m[5], add(base, '9')));
    else if (m[6] !== undefined || m[7] !== undefined) cells.push(...inline(m[6] ?? m[7], add(base, '3')));
    else if (m[8] !== undefined) {
      const source = sourceReference(m[9], true);
      cells.push(...inline(m[8], add(base, '4')).map(cell => ({ ...cell, source })));
      if (!source && m[9] !== m[8] && !m[9].startsWith('#')) cells.push(...toCells(` (${m[9]})`, DIM));
    } else if (m[10] !== undefined || m[11] !== undefined) cells.push(...toCells(tex(m[10] ?? m[11]).replace(/\s*\n\s*/g, ' '), MATH));
    else if (m[12] !== undefined) cells.push(...toCells(m[12], base));
  }
  if (last < text.length) cells.push(...sourceCells(text.slice(last), base));
  return cells;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

const isTableRule = (line: string) => line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

function table(header: string[], aligns: string[], body: string[][], width: number): Cell[][] | undefined {
  const n = Math.max(header.length, ...body.map((r) => r.length));
  const rows = [header, ...body].map((r, ri) =>
    Array.from({ length: n }, (_, c) => inline(r[c] ?? '', ri === 0 ? '1' : '')),
  );
  const avail = width - (n + 1) - 2 * n;
  if (avail < n * 3) return undefined; // too narrow to draw: caller falls back to plain text
  const cols = Array.from({ length: n }, (_, c) => Math.max(3, ...rows.map((r) => widthOf(r[c]))));
  while (cols.reduce((a, b) => a + b, 0) > avail) {
    const widest = cols.indexOf(Math.max(...cols));
    cols[widest]--;
  }
  const rule = (l: string, m: string, r: string) => toCells(l + cols.map((w) => '─'.repeat(w + 2)).join(m) + r, RULE);
  const bar = toCells('│', RULE);
  const out: Cell[][] = [rule('┌', '┬', '┐')];
  rows.forEach((r, ri) => {
    const wrapped = r.map((cell, c) => wrap(cell, cols[c]));
    const h = Math.max(...wrapped.map((w) => w.length));
    for (let li = 0; li < h; li++) {
      const line: Cell[] = [...bar];
      wrapped.forEach((w, c) => {
        const content = w[li] ?? [];
        const pad = cols[c] - widthOf(content);
        const left = aligns[c] === 'right' ? pad : aligns[c] === 'center' ? Math.floor(pad / 2) : 0;
        line.push(...space(1 + left), ...content, ...space(1 + pad - left), ...bar);
      });
      out.push(line);
    }
    if (ri === 0) out.push(rule('├', '┼', '┤'));
  });
  out.push(rule('└', '┴', '┘'));
  return out;
}

function mathBlock(src: string, width: number): Cell[][] {
  const out: Cell[][] = [];
  for (const line of tex(src).split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) out.push(...withPrefix(wrap(toCells(t, MATH), width - 4), space(4)));
  }
  return out;
}

/**
 * Lay markdown out into terminal lines: headings, nested and task lists,
 * quotes, tables, fenced code, emphasis, links, and LaTeX math flattened to
 * Unicode. Constructs that are still mid-stream are shown verbatim, so text
 * never jumps around while it arrives.
 */
export function layout(text: string, width: number, accent: string, muted = false): Cell[][] {
  const src = text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n');
  if (muted) return src.flatMap((l) => wrap(sourceCells(l, DIM), width));

  const out: Cell[][] = [];
  const codeBar = toCells('│ ', RULE);
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];

    // fenced code
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(raw);
    if (fence) {
      out.push(toCells(`┌─ ${fence[2] || 'code'}`, RULE));
      for (i++; i < src.length && !src[i].trim().startsWith(fence[1]); i++) {
        out.push(...withPrefix(wrap(sourceCells(src[i], BLOCK), width - 2), codeBar));
      }
      if (i < src.length) out.push(toCells('└─', RULE));
      continue;
    }

    // display math: $$ … $$ or \[ … \], on one line or spanning several
    const open = /^\s*(\$\$|\\\[)(.*)$/.exec(raw);
    if (open) {
      const close = open[1] === '$$' ? '$$' : '\\]';
      let body = open[2];
      let end = body.indexOf(close);
      while (end < 0 && i + 1 < src.length) {
        body += '\n' + src[++i];
        end = body.indexOf(close);
      }
      out.push(...mathBlock(end < 0 ? body : body.slice(0, end), width));
      const tail = end < 0 ? '' : body.slice(end + close.length).trim();
      if (tail) out.push(...wrap(inline(tail, ''), width));
      continue;
    }

    // table: a header row followed by |---|---|
    if (raw.includes('|') && i + 1 < src.length && isTableRule(src[i + 1])) {
      const aligns = splitRow(src[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
      const body: string[][] = [];
      let j = i + 2;
      for (; j < src.length && src[j].includes('|') && src[j].trim(); j++) body.push(splitRow(src[j]));
      const drawn = table(splitRow(raw), aligns, body, width);
      if (drawn) {
        out.push(...drawn);
        i = j - 1;
        continue;
      }
    }

    if (raw.startsWith('⚙ ')) {
      out.push(...wrap(sourceCells(raw, DIM), width, 2));
      continue;
    }
    if (raw.startsWith('✗ ')) {
      out.push(...wrap(toCells(raw, RED), width, 2));
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      out.push(...wrap(inline(heading[2], level <= 2 ? `1;${accent}` : '1'), width));
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(toCells('─'.repeat(Math.max(1, width)), RULE));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(...withPrefix(wrap(inline(quote[1], `3;${QUOTE}`), width - 2), toCells('▌ ', accent)));
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const indent = Math.min(item[1].length, 12);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      const marker = task ? (task[1] === ' ' ? '☐' : '☑') : /\d/.test(item[2]) ? item[2] : indent >= 2 ? '◦' : '•';
      const head = [...space(indent), ...toCells(marker + ' ', accent)];
      out.push(...wrap([...head, ...inline(task ? task[2] : item[3], '')], width, widthOf(head)));
      continue;
    }

    // Continuation lines of a list item keep their indentation.
    const lead = /^ */.exec(raw)![0].length;
    out.push(...wrap([...space(Math.min(lead, 12)), ...inline(raw.slice(lead), '')], width, Math.min(lead, 12)));
  }
  return out;
}
