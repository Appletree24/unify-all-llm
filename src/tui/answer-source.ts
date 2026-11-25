import { resolve } from 'node:path';
import { answerPassages } from '../core/answer-passages.js';
import type { RunRecord } from '../core/store.js';
import { synthesisFormatter } from '../core/synth.js';
import type { Key } from './keys.js';
import { layout } from './markdown.js';
import { rgb, toCells, truncate, type Cell, type Screen } from './screen.js';
import { BRANCH_SOURCE, branchRepository, parseBranchSource, sourceCells, type SourceReference } from './source.js';

export interface AnswerReference {
  name: string;
  blocks: string[];
  passage?: number;
}

export function synthesisText(record: RunRecord) {
  const format = synthesisFormatter(record);
  const answers = new Map(record.results.filter(r => r.ok && r.text.trim()).map(r => [r.targetId, r.text]));
  const passages = new Map<string, string[]>();
  function blocksFor(targetId: string): string[] | undefined {
    const answer = answers.get(targetId);
    if (!answer) return;
    let blocks = passages.get(targetId);
    if (!blocks) {
      blocks = answerPassages(answer).filter(p => p.number !== undefined).map(p => p.token.raw.trimEnd());
      if (!blocks.length) blocks = [answer];
      passages.set(targetId, blocks);
    }
    return blocks;
  }

  return {
    format,
    branchSource(cwd: string, text: string, ref: SourceReference): SourceReference | undefined {
      const path = resolve(cwd, ref.path);
      const matches = new Map<string, SourceReference>();
      format(text, (citation, raw) => {
        const blocks = blocksFor(citation.targetId);
        if (!blocks) return raw;
        const cited = citation.passage === undefined ? blocks : blocks.slice(citation.passage - 1, citation.passage);
        for (const block of cited) {
          for (const match of block.matchAll(BRANCH_SOURCE)) {
            const { reference } = parseBranchSource(match[0]);
            if (!reference) continue;
            const repo = branchRepository(cwd, reference.git.repository);
            if (resolve(repo, reference.path) === path) {
              matches.set(`${repo}\0${reference.git.branch}`, { ...ref, path: reference.path, git: reference.git });
            }
          }
        }
        return raw;
      });
      if (matches.size === 1) return matches.values().next().value;
    },
    cells(text: string, style: string): Cell[] {
      const cells: Cell[] = [];
      let end = 0;
      format(text, (ref, raw, offset) => {
        const blocks = blocksFor(ref.targetId);
        if (!blocks) return raw;
        const passage = ref.passage !== undefined && ref.passage <= blocks.length ? ref.passage : undefined;
        const source: AnswerReference = { name: ref.name, blocks, passage };
        const label = passage === undefined ? ref.name : `${ref.name}（第${passage}段）`;
        const underline = style ? `${style};4` : '4';
        cells.push(...sourceCells(text.slice(end, offset), style), ...toCells(label, underline).map(cell => ({ ...cell, source })));
        end = offset + raw.length;
        return raw;
      });
      cells.push(...sourceCells(text.slice(end), style));
      return cells;
    },
  };
}

const DIM = rgb(120, 125, 135);
const ACCENT = rgb(232, 196, 104);

export class AnswerSourceView {
  private top = 0;
  private page = 1;
  private content?: { width: number; lines: Cell[][] };

  constructor(private readonly ref: AnswerReference) {}

  handleKey(key: Key): void {
    switch (key.name) {
      case 'up': this.top--; break;
      case 'down': this.top++; break;
      case 'wheelup': this.top -= 3; break;
      case 'wheeldown': this.top += 3; break;
      case 'pgup': this.top -= this.page; break;
      case 'pgdn': this.top += this.page; break;
      case 'home': this.top = 0; break;
      case 'end': this.top = this.content?.lines.length ?? 0; break;
    }
  }

  draw(s: Screen): void {
    const width = s.cols - 4;
    if (this.content?.width !== width) {
      const lines: Cell[][] = [];
      this.ref.blocks.forEach((block, i) => {
        if (i) lines.push([]);
        const cited = this.ref.passage === i + 1;
        if (cited && !this.content) this.top = lines.length;
        layout(block, width, ACCENT).forEach((line, row) => {
          const gutter = cited ? row === 0 ? '› ' : '│ ' : '  ';
          lines.push([...toCells(gutter, ACCENT), ...line]);
        });
      });
      this.content = { width, lines };
    }
    const { lines } = this.content;
    this.page = s.rows - 3;
    this.top = Math.max(0, Math.min(this.top, lines.length - this.page));
    const heading = `${this.ref.name} · ${this.ref.passage === undefined ? '回答原文' : `第${this.ref.passage}段原文`}`;
    s.put(1, 0, truncate(heading, s.cols - 2), `1;${ACCENT}`);
    lines.slice(this.top, this.top + this.page).forEach((line, i) => s.putCells(1, i + 2, line, s.cols - 1));
    s.put(1, s.rows - 1, 'Esc 返回 · ↑↓ 滚动', DIM);
  }
}
