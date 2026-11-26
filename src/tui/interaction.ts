import type { InteractionResponse, PendingInteraction } from '../core/types.js';
import { ApprovalSelection } from '../ui/approval.js';
import { Editor } from './editor.js';
import type { Key } from './keys.js';
import { wrap } from './markdown.js';
import { Screen, textWidth, truncate } from './screen.js';
import { sourceCells } from './source.js';

/** One model request has its own input buffer, separate from the conversation draft. */
export class InteractionView {
  private input = new Editor();
  private answers = new Map<string, string[]>();
  private field = 0;
  private other?: string[];
  private scroll = 0;
  private pageSize = 1;
  private error = '';
  private approval?: ApprovalSelection;

  constructor(readonly turnId: string, readonly paneId: string, readonly model: string, readonly request: PendingInteraction) {
    if (request.kind === 'approval') this.approval = new ApprovalSelection(request.options);
  }

  get summary(): string {
    const { kind, detail, tool, title } = this.request;
    if (kind !== 'approval') return `Ctrl+G · ${this.model} 等待交互 · ${title}`;
    const operation = detail?.trim().split('\n', 1)[0] || tool || title;
    return `Ctrl+G · ${this.model} 待授权 · ${operation}`;
  }

  private get question() {
    return this.request.kind === 'question' ? this.request.questions?.[this.field] : undefined;
  }

  handleKey(key: Key): InteractionResponse | undefined {
    switch (key.name) {
      case 'pgup': this.scroll = Math.max(0, this.scroll - this.pageSize); return;
      case 'pgdn': this.scroll += this.pageSize; return;
      case 'wheelup': this.scroll = Math.max(0, this.scroll - 1); return;
      case 'wheeldown': this.scroll++; return;
    }
    if (this.approval) return this.approval.handleKey(key);

    switch (key.name) {
      case 'esc': return { cancelled: true };
      case 'up': this.scroll = Math.max(0, this.scroll - 1); break;
      case 'down': this.scroll++; break;
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

  draw(s: Screen, x: number, bottom: number, width: number, maxHeight: number, focused: boolean, color: string) {
    const { request, approval, question: q } = this;
    const showTitle = maxHeight >= 4;
    const body: string[] = [];
    const operation = request.detail || request.tool;
    if (operation) body.push(operation);
    if (q) body.push(`${this.field + 1}/${request.questions!.length} ${q.header ?? ''} ${q.question}`);
    if (!showTitle && !body.length) body.push(request.title);
    const choices = q?.options;
    if (choices && !this.other) {
      body.push(...choices.map((o, i) => `${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`));
      if (q?.allowOther) body.push('0. 自定义回答');
    }
    const lines = body.flatMap(block => block.split('\n').flatMap(line => wrap(sourceCells(line, ''), width)));
    const footer = !approval || !focused;
    const room = maxHeight - Number(showTitle) - Number(footer);
    const options = approval?.rows(Math.max(Number(focused), room - Number(lines.length > 0))) ?? [];
    this.pageSize = Math.min(lines.length, room - options.length);
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - this.pageSize));
    const top = bottom - this.pageSize - options.length - Number(showTitle) - Number(footer);
    const inputY = bottom - 1;
    if (showTitle) {
      const position = lines.length > this.pageSize ? ` ${this.scroll + this.pageSize}/${lines.length}` : '';
      s.put(x, top, '─'.repeat(width), color);
      s.put(x, top, truncate(` ${request.title} `, width - textWidth(position)), `1;${color}`);
      s.put(x + width - textWidth(position), top, position, color);
    }
    const bodyY = top + Number(showTitle);
    lines.slice(this.scroll, this.scroll + this.pageSize).forEach((line, i) => s.putCells(x, bodyY + i, line, x + width));
    options.forEach(({ text, selected }, i) => {
      s.put(x, bodyY + this.pageSize + i, truncate(text, width), focused && selected ? '1;7' : '');
    });
    if (!focused) {
      s.put(x, inputY, 'Ctrl+G 回答', color);
      return { top };
    }
    if (approval) return { top };
    const hint = this.other ? '输入自定义回答' : choices ? (q?.multiSelect ? '输入编号，可用空格多选' : '输入选项编号') : request.placeholder || '输入回答';
    const secret = request.secret || q?.secret;
    const chars = this.input.chars.map(ch => secret ? '•' : ch === '\n' ? '↵' : ch);
    const inputWidth = width - 2;
    let left = this.input.caret;
    let used = 0;
    while (left > 0 && used + textWidth(chars[left - 1]) < inputWidth) used += textWidth(chars[--left]);
    s.put(x, inputY, '❯', color);
    s.put(x + 2, inputY, chars.length ? chars.slice(left).join('') : truncate(hint, inputWidth), chars.length ? '' : color, x + width);
    return { top, cursor: { x: x + 2 + used, y: inputY } };
  }

  get keyHint(): string {
    return this.error || (this.approval
      ? '↑↓ 选择 · Enter 确认 · Esc 取消 · PgUp/PgDn 详情 · Tab 返回'
      : 'Enter 提交 · Esc 取消 · ↑↓ 详情 · Tab 返回');
  }
}
