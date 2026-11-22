import type { ProviderEvent } from '../core/types.js';
import { formatMemoryReferences } from '../memory/report.js';

const tty = process.stdout.isTTY === true;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function header(title: string, note = ''): void {
  process.stdout.write(`\n${bold(cyan(`━━ ${title} `))}${dim(note)}\n\n`);
}

/**
 * Parallel answers cannot be interleaved readably in a terminal, so while the
 * providers run we show one live status line, and print each answer in full
 * the moment it completes.
 */
export class FanOutView {
  private state = new Map<string, { chars: number; start: number; status: 'run' | 'ok' | 'err'; tool?: string }>();
  private timer?: NodeJS.Timeout;
  private frame = 0;

  constructor(private labels: Record<string, string>) {
    for (const id of Object.keys(labels)) this.state.set(id, { chars: 0, start: Date.now(), status: 'run' });
  }

  start(): void {
    if (!tty) return;
    this.timer = setInterval(() => this.draw(), 120);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
  }

  private clear(): void {
    if (tty) process.stdout.write('\r\x1b[2K');
  }

  private draw(): void {
    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.frame++ % 10];
    const parts = [...this.state].map(([id, s]) => {
      const name = this.labels[id];
      if (s.status === 'ok') return green(`${name} ✓`);
      if (s.status === 'err') return red(`${name} ✗`);
      const extra = s.tool ? ` ${s.tool}` : s.chars ? ` ${s.chars}字` : '';
      return `${name} ${spin} ${secs(Date.now() - s.start)}${dim(extra)}`;
    });
    const line = parts.join(dim('  │  '));
    this.clear();
    process.stdout.write(line.slice(0, Math.max(20, (process.stdout.columns ?? 100) + 40)));
  }

  onEvent(id: string, ev: ProviderEvent): void {
    const s = this.state.get(id);
    if (!s) return;
    if (ev.type === 'delta') {
      s.chars += ev.text.length;
      s.tool = undefined;
    } else if (ev.type === 'tool') {
      s.tool = `[${ev.name}]`;
    } else if (ev.type === 'done') {
      s.status = 'ok';
      this.clear();
      header(this.labels[id], secs(Date.now() - s.start));
      process.stdout.write(ev.text.trim() + formatMemoryReferences(ev.memoryReferences) + '\n');
    } else if (ev.type === 'error') {
      s.status = 'err';
      this.clear();
      header(this.labels[id], secs(Date.now() - s.start));
      process.stdout.write(red(`失败: ${ev.message}`) + '\n');
    }
  }
}

/** A single provider streamed straight to the terminal (synthesis, exec). */
export function streamEvent(ev: ProviderEvent, showReasoning: boolean): void {
  if (ev.type === 'delta') process.stdout.write(ev.text);
  else if (ev.type === 'reasoning' && showReasoning) process.stdout.write(dim(ev.text));
  else if (ev.type === 'tool') process.stdout.write(dim(`\n  ⚙ ${ev.name}${ev.detail ? ` ${ev.detail}` : ''}\n`));
  else if (ev.type === 'error') process.stdout.write(red(`\n失败: ${ev.message}\n`));
  else if (ev.type === 'done') process.stdout.write(formatMemoryReferences(ev.memoryReferences) + '\n');
}
