import type { Key } from './keys.js';
import { Screen, truncate } from './screen.js';

interface Choice { id: string; label: string; detail: string }

/** Keyboard selection shared by saved templates and project sessions. */
export class Picker {
  private index: number;
  constructor(private title: string, private items: Choice[], selected: string | undefined,
    private choose: (id: string) => void, private close: () => void) {
    this.index = Math.max(0, items.findIndex(item => item.id === selected));
  }

  handleKey(k: Key): void {
    if (k.name === 'esc' || k.name === 'ctrl+c') return this.close();
    if (k.name === 'up' || k.name === 'wheelup') this.index = Math.max(0, this.index - 1);
    if (k.name === 'down' || k.name === 'wheeldown') this.index = Math.min(this.items.length - 1, this.index + 1);
    if (k.name === 'enter' && this.items[this.index]) {
      this.close();
      this.choose(this.items[this.index].id);
    }
  }

  draw(s: Screen): void {
    s.put(1, 0, this.title, '1');
    const height = s.rows - 5;
    const first = Math.max(0, this.index - height + 1);
    this.items.slice(first, first + height).forEach((item, row) => {
      const selected = row + first === this.index;
      s.put(1, row + 2, truncate((selected ? '❯ ' : '  ') + item.label, s.cols - 2), selected ? '1;7' : '');
    });
    const item = this.items[this.index];
    if (item) s.put(1, s.rows - 2, truncate(item.detail, s.cols - 2));
    s.put(1, s.rows - 1, '↑↓ 选择 · Enter 打开 · Esc 返回');
  }
}
