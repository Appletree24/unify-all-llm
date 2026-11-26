import type { InteractionOption, InteractionRequest, InteractionResponse } from '../core/types.js';
import { KeyParser, type Key } from '../tui/keys.js';
import { truncate } from '../tui/screen.js';
import { bold } from './term.js';

export class ApprovalSelection {
  readonly options: readonly InteractionOption[];
  index: number;

  constructor(options: InteractionRequest['options']) {
    this.options = options?.length ? options : [
      { id: 'accept', label: '允许' }, { id: 'decline', label: '拒绝', tone: 'danger' },
    ];
    const danger = this.options.findIndex(option => option.tone === 'danger');
    this.index = danger >= 0 ? danger : this.options.findIndex(option => /^(deny|decline|reject|cancel)$/i.test(option.id));
  }

  handleKey(key: Key): InteractionResponse | undefined {
    if (key.name === 'up') this.index = Math.max(0, this.index - 1);
    if (key.name === 'down') this.index = Math.min(this.options.length - 1, this.index + 1);
    if (key.name === 'esc') return { cancelled: true };
    if (key.name === 'enter') {
      const option = this.options[this.index];
      return option ? { optionId: option.id } : { cancelled: true };
    }
  }

  rows(count: number) {
    const first = Math.max(0, this.index - count + 1);
    return this.options.slice(first, first + count).map((option, row) => {
      const selected = first + row === this.index;
      const label = option.description ? `${option.label} — ${option.description}` : option.label;
      return { selected, text: `${selected ? '❯ ' : '  '}${label.replace(/\s+/g, ' ')}` };
    });
  }
}

export async function promptApproval(request: InteractionRequest, signal: AbortSignal): Promise<InteractionResponse> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  const parser = new KeyParser();
  const selection = new ApprovalSelection(request.options);
  const count = Math.min(selection.options.length, Math.max(1, (output.rows || 24) - 2));
  const hint = '↑↓ 选择 · Enter 确认 · Esc 取消';
  const draw = () => {
    const width = (output.columns || 80) - 1;
    const rows = selection.rows(count).map(({ text, selected }) => selected ? bold(truncate(text, width)) : truncate(text, width));
    output.write([...rows, truncate(hint, width)].join('\n'));
  };

  if (signal.aborted || input.readableEnded) return { cancelled: true };
  input.setRawMode(true);
  try {
    return await new Promise<InteractionResponse>(resolve => {
      const finish = (response: InteractionResponse) => {
        input.off('data', onData);
        input.off('end', cancel);
        signal.removeEventListener('abort', cancel);
        output.write('\n');
        resolve(response);
      };
      const cancel = () => finish({ cancelled: true });
      const onData = (chunk: Buffer | string) => {
        for (const key of parser.feed(String(chunk))) {
          if (key.name === 'ctrl+c' || key.name === 'ctrl+d' || (key.name === 'char' && key.text?.toLowerCase() === 'q')) return cancel();
          const previous = selection.index;
          const response = selection.handleKey(key);
          if (response) return finish(response);
          if (previous !== selection.index) {
            output.moveCursor(0, -count);
            output.cursorTo(0);
            output.clearScreenDown();
            draw();
          }
        }
      };
      input.on('data', onData);
      input.once('end', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      draw();
      input.resume();
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}
