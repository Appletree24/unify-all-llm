import { loadTrial, trialDiff } from '../core/trial.js';
import type { Key } from './keys.js';
import { wrap } from './markdown.js';
import { Screen, toCells, truncate } from './screen.js';

export class TrialView {
  private selected = 0;
  private offset = 0;
  private page = 1;
  private diff = false;
  private readonly trial;
  private readonly patches: string[];
  constructor(cwd: string, id: string, private apply: (slot: number) => void, private close: () => void) {
    this.trial = loadTrial(cwd, id);
    this.patches = this.trial.variants.map((r, i) => {
      if (!r.hash) return '没有补丁';
      const patch = trialDiff(cwd, id, i + 1);
      return patch.length > 16000 ? patch.slice(0, 16000) + '\n完整补丁：unify trial diff ' + id + ' ' + (i + 1) : patch || '无改动';
    });
  }
  handleKey(k: Key) {
    if (k.name === 'esc' || k.name === 'ctrl+c') return this.close();
    if (k.name === 'enter') return this.apply(this.selected + 1);
    if (k.name === 'tab' || k.name === 'left' || k.name === 'right') this.selected = 1 - this.selected;
    if (k.name === 'char' && k.text?.toLowerCase() === 'd') { this.diff = !this.diff; this.offset = 0; }
    if (k.name === 'down' || k.name === 'wheeldown') this.offset++;
    if (k.name === 'up' || k.name === 'wheelup') this.offset--;
    if (k.name === 'pgdn') this.offset += this.page;
    if (k.name === 'pgup') this.offset -= this.page;
  }
  draw(s: Screen) {
    const states = { passed: '验证通过', failed: '验证失败', error: '运行错误', running: '运行中', pending: '等待' };
    const wide = s.cols >= 72;
    const width = wide ? Math.floor(s.cols / 2) - 2 : s.cols - 2;
    s.put(1, 0, truncate('方案试跑 · ' + this.trial.check, s.cols - 2), '1');
    const columns = this.trial.variants.map((r,i) => (this.diff ? this.patches[i] :
      [states[r.state], ...r.files, '', r.log].join('\n')).split(/\r?\n/).flatMap(line => {
        const cells = wrap(toCells(line), width);
        return cells.length ? cells : [[]];
      }));
    this.page = s.rows - 5;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(...columns.map(lines => lines.length)) - this.page));
    columns.forEach((lines,i) => {
      if (!wide && i !== this.selected) return;
      const x = wide ? 1 + i * (width + 2) : 1;
      s.put(x, 2, truncate((this.selected === i ? '❯ ' : '  ') + (i+1) + '. ' + this.trial.variants[i].from, width), '1');
      lines.slice(this.offset, this.offset + this.page).forEach((line,j) => s.putCells(x, 3+j, line, x + width));
    });
    s.put(1, s.rows - 1, truncate('←→ 选方案 · ↑↓ 滚动 · D 切换补丁 · Enter 采纳 · Esc 返回', s.cols - 2));
  }
}
