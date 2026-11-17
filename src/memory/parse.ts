import type { Entry } from './types.js';

export interface Parsed {
  meta?: Record<string, string>;
  entries: Entry[];
  imports: { target: string; line: number }[];
}

/** Rough token estimate: about four Latin characters or one CJK character per token. */
export function estimateTokens(text: string): number {
  let wide = 0;
  for (const ch of text) if (ch.codePointAt(0)! > 0x2e7f) wide++;
  return Math.ceil((text.length - wide) / 4 + wide);
}

const FENCE = /^\s*(```|~~~)/;
const BULLET = /^([-*+]|\d+[.)])\s+/;
// @path outside code spans; must look like a path, so @mentions and emails are left alone.
const IMPORT = /(?:^|[\s(])@((?:~|\.{1,2})?\/?[\w.\-~]+(?:\/[\w.\-]+)*\.[A-Za-z0-9]+|(?:~|\.{1,2})\/[\w.\-\/]+)/g;

/**
 * Split a memory file into the items a person would call "one memory": each
 * top-level bullet (with its nested lines), each paragraph, each code block.
 * Headings give the items their place; frontmatter is metadata, not an item.
 */
export function parseMemory(content: string): Parsed {
  const lines = content.split(/\r?\n/);
  const entries: Entry[] = [];
  const imports: Parsed['imports'] = [];
  const heading: string[] = [];
  let meta: Record<string, string> | undefined;
  let i = 0;

  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      meta = {};
      let key = '';
      for (const line of lines.slice(1, end)) {
        const m = /^([\w-]+):\s*(.*)$/.exec(line);
        if (m) meta[(key = m[1])] = m[2].replace(/^["']|["']$/g, '');
        else if (key && /^\s+-\s+/.test(line)) meta[key] = [meta[key], line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '')].filter(Boolean).join(', ');
      }
      i = end + 1;
    }
  }

  let open: Entry | undefined;
  const close = () => {
    if (!open) return;
    open.text = open.text.replace(/\s+$/, '');
    if (open.text) entries.push(open);
    open = undefined;
  };
  const start = (kind: Entry['kind'], n: number, text: string) => {
    close();
    open = { start: n, end: n, kind, heading: [...heading], text };
  };
  const scanImports = (line: string, n: number) => {
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(IMPORT)) imports.push({ target: m[1], line: n });
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (FENCE.test(line)) {
      const mark = FENCE.exec(line)![1];
      // A fence nested in a bullet stays part of that bullet.
      const nested = open?.kind === 'bullet' && /^\s+/.test(line);
      if (!nested) start('code', n, line);
      else { open!.text += '\n' + line; open!.end = n; }
      while (++i < lines.length) {
        open!.text += '\n' + lines[i];
        open!.end = i + 1;
        if (lines[i].trim().startsWith(mark)) break;
      }
      if (!nested) close();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      close();
      heading.length = h[1].length - 1;
      for (let d = 0; d < heading.length; d++) heading[d] ??= '';
      heading.push(h[2]);
      continue;
    }
    if (!line.trim()) {
      // A blank line ends a paragraph; a bullet continues if indented text follows.
      if (open?.kind === 'bullet' && /^\s+\S/.test(lines[i + 1] ?? '')) { open.text += '\n'; continue; }
      close();
      continue;
    }
    if (/^<!--.*-->\s*$/.test(line)) { close(); continue; }
    scanImports(line, n);
    if (BULLET.test(line)) start('bullet', n, line);
    else if (open && (open.kind === 'text' || /^\s+/.test(line) || open.kind === 'bullet')) { open.text += '\n' + line; open.end = n; }
    else start('text', n, line);
  }
  close();
  return { meta, entries, imports };
}

const eol = (content: string) => (content.includes('\r\n') ? '\r\n' : '\n');

/** Replace lines [start, end] (1-based, inclusive) with text; empty text deletes them. */
export function replaceLines(content: string, start: number, end: number, text: string): string {
  const nl = eol(content);
  const lines = content.split(/\r?\n/);
  if (start < 1 || end < start || end > lines.length) throw new Error('行范围已失效，请刷新后重试');
  const next = text === '' ? [] : text.replace(/\s+$/, '').split(/\r?\n/);
  lines.splice(start - 1, end - start + 1, ...next);
  // Deleting an item should not leave a double blank line behind.
  if (!next.length && lines[start - 2]?.trim() === '' && (lines[start - 1] ?? '').trim() === '') lines.splice(start - 1, 1);
  return lines.join(nl);
}

/** Append an item, under the given heading when there is one (created if missing). */
export function appendEntry(content: string, text: string, heading?: string): string {
  const nl = eol(content);
  const item = text.replace(/\s+$/, '').split(/\r?\n/);
  const lines = content.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  const bullet = BULLET.test(item[0]);
  if (!heading) {
    const tight = bullet && BULLET.test(lines[lines.length - 1] ?? '');
    return [...lines, ...(lines.length && !tight ? [''] : []), ...item, ''].join(nl);
  }
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, '').trim() === heading);
  if (at < 0) return [...lines, ...(lines.length ? [''] : []), `## ${heading}`, '', ...item, ''].join(nl);
  const level = /^#+/.exec(lines[at])![0].length;
  let end = lines.length;
  for (let j = at + 1; j < lines.length; j++) {
    const m = /^(#{1,6})\s/.exec(lines[j]);
    if (m && m[1].length <= level) { end = j; break; }
  }
  while (end > at + 1 && !lines[end - 1].trim()) end--;
  const tight = bullet && BULLET.test(lines[end - 1] ?? '');
  lines.splice(end, 0, ...(tight ? [] : ['']), ...item);
  return [...lines, ''].join(nl).replace(/(\r?\n){3,}/g, nl + nl);
}
