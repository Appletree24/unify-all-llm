import type { InteractionResponse, PendingInteraction } from '../core/types.js';
import { Editor } from './editor.js';
import type { Key } from './keys.js';
import { wrap } from './markdown.js';
import { Screen, textWidth, toCells, truncate } from './screen.js';

/** One model request has its own input buffer, separate from the conversation draft. */
export class InteractionView {
  private input = new Editor();
  private answers = new Map<string, string[]>();
  private field = 0;
  private other?: string[];
  private scroll = 0;
  private pageSize = 1;
  private error = '';

  constructor(readonly turnId: string, readonly model: string, readonly request: PendingInteraction) {}

  private get question() {
    return this.request.kind === 'question' ? this.request.questions?.[this.field] : undefined;
  }

  private get approvals() {
    return this.request.options?.length ? this.request.options : [{ id: 'accept', label: '允许' }, { id: 'decline', label: '拒绝' }];
  }

  handleKey(key: Key): InteractionResponse | undefined {
    switch (key.name) {
      case 'esc': return { cancelled: true };
      case 'pgup': this.scroll = Math.max(0, this.scroll - this.pageSize); break;
      case 'pgdn': this.scroll += this.pageSize; break;
      case 'up': case 'wheelup': this.scroll = Math.max(0, this.scroll - 1); break;
      case 'down': case 'wheeldown': this.scroll++; break;
      case 'char': case 'paste': this.input.insert(key.text ?? ''); this.error = ''; break;
      case 'backspace': this.input.backspace(); break;
      case 'delete': this.input.del(); break;
      case 'left': this.input.left(); break;
      case 'right': this.input.right(); break;
      case 'home': case 'ctrl+a': this.input.home(); break;
      case 'end': case 'ctrl+e': this.input.end(); break;
      case 'ctrl+u': this.input.clear(); break;
      case 'enter': return this.submit();
    }
  }

  private submit(): InteractionResponse | undefined {
    const text = this.input.text;
    const value = text.trim();
    if (!value) { this.error = '请填写后再提交'; return; }
    if (this.request.kind === 'approval') {
      const option = /^[1-9]\d*$/.test(value) ? this.approvals[Number(value) - 1] : undefined;
      if (option) return { optionId: option.id };
      this.error = '请输入一个有效的选项编号';
      return;
    }
    const q = this.question;
    if (!q) return { text };
    let values: string[];
    if (!q.options?.length) values = [text];
    else if (this.other) values = [...this.other, text];
    else {
      const parts = value.split(/[\s,，、]+/);
      const ids = [...new Set(parts.map(Number))];
      if (parts.some(p => !/^\d+$/.test(p)) || ids.some(i => i > q.options!.length || (i === 0 && !q.allowOther))
        || (!q.multiSelect && ids.length !== 1)) {
        this.error = q.multiSelect ? '请输入有效编号，多个编号用空格隔开' : '请输入一个有效的选项编号';
        return;
      }
      values = ids.filter(i => i > 0).map(i => q.options![i - 1].label);
      if (ids.includes(0)) {
        this.other = values;
        this.input.clear();
        this.error = '';
        return;
      }
    }
    this.answers.set(q.id, values);
    this.field++;
    this.other = undefined;
    this.scroll = 0;
    this.error = '';
    this.input.clear();
    if (!this.question) return { answers: Object.fromEntries(this.answers) };
  }

  draw(s: Screen, pending: number): { x: number; y: number } {
    const width = s.cols - 4;
    const { request, question: q } = this;
    s.put(1, 0, truncate(`等待交互 · ${this.model} · ${pending} 项待处理`, width), '1');
    const body = [request.title];
    if (request.tool) body.push(request.tool);
    if (request.detail) body.push(request.detail);
    if (q) body.push(`${this.field + 1}/${request.questions!.length} ${q.header ?? ''} ${q.question}`);
    const choices = request.kind === 'approval' ? this.approvals : q?.options;
    if (choices && !this.other) {
      choices.forEach((o, i) => body.push(`${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`));
      if (q?.allowOther) body.push('0. 自定义回答');
    }
    const lines = body.join('\n').split('\n').flatMap(line => wrap(toCells(line), width));
    this.pageSize = s.rows - 6;
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - this.pageSize));
    lines.slice(this.scroll, this.scroll + this.pageSize).forEach((line, i) => s.putCells(2, i + 2, line));
    const hint = this.other ? '输入自定义回答' : choices ? (q?.multiSelect ? '输入编号，可用空格多选' : '输入选项编号') : request.placeholder || '输入回答';
    s.put(1, s.rows - 3, truncate(this.error || hint, width), '1');
    const secret = request.secret || q?.secret;
    const chars = this.input.chars.map(ch => secret ? '•' : ch === '\n' ? '↵' : ch);
    let left = this.input.caret;
    let used = 0;
    while (left > 0 && used + textWidth(chars[left - 1]) < width) used += textWidth(chars[--left]);
    s.put(1, s.rows - 2, '❯');
    s.put(3, s.rows - 2, chars.slice(left).join(''));
    s.put(1, s.rows - 1, truncate('Enter 提交 · Esc 取消此项 · ↑↓ / PgUp/PgDn 阅读详情 · Ctrl+C 中断本轮', s.cols - 2));
    return { x: 3 + used, y: s.rows - 2 };
  }
}
