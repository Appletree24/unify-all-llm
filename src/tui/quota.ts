import { formatQuota, QUOTA_REFRESH_MS, type TargetQuota } from '../quota/index.js';
import type { Key } from './keys.js';
import { wrap } from './markdown.js';
import { Screen, rgb, textWidth, toCells, truncate, type Cell } from './screen.js';

const GOLD = rgb(232, 196, 104);
const DIM = rgb(120, 125, 135);
const RED = rgb(240, 90, 90);

const resetTime = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function inlineLimits(row: TargetQuota) {
  if (row.reading.status !== 'ok') return [];
  const matchesModel = (label: string) => !!row.model && (label === row.model || label.startsWith(row.model + ' · '));
  const limits = [...row.reading.limits].sort((a, b) => Number(matchesModel(b.label)) - Number(matchesModel(a.label)));
  return limits.map(({ remaining, unit, label, resetsAt }) => {
    const name = label.toLowerCase().startsWith(row.provider.toLowerCase() + ' · ') ? label.slice(row.provider.length + 3) : label;
    const short = `${remaining}${unit === '%' ? '' : ' '}${unit} ${name}`;
    return { short, detail: resetsAt ? `${short}（${resetTime.format(new Date(resetsAt))} 重置）` : short };
  });
}

export class QuotaView {
  private results = new Map<string, TargetQuota & { inline: ReturnType<typeof inlineLimits> }>();
  private checked = '';
  private failed = false;
  private top = 0;
  private height = 1;
  private maxTop = 0;
  private request?: AbortController;
  private readonly timer: NodeJS.Timeout;

  constructor(private read: (signal: AbortSignal) => Promise<TargetQuota[]>, private redraw: () => void) {
    this.timer = setInterval(() => void this.refresh(), QUOTA_REFRESH_MS);
    void this.refresh();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.request?.abort();
  }

  private async refresh(): Promise<void> {
    if (this.request) return;
    const ctl = new AbortController();
    this.request = ctl;
    this.redraw();
    try {
      const results = await this.read(ctl.signal);
      if (ctl.signal.aborted) return;
      this.results = new Map(results.map(row => [row.targetId, { ...row, inline: inlineLimits(row) }]));
      this.checked = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.failed = false;
    } catch {
      if (ctl.signal.aborted) return;
      this.results.clear();
      this.failed = true;
    } finally {
      this.request = undefined;
      if (!ctl.signal.aborted) this.redraw();
    }
  }

  /** Keep the amount and unit visible even when the window name needs clipping. */
  summary(targetId: string, width: number): string {
    const row = this.results.get(targetId);
    if (!row) return truncate(this.failed ? '余量查询失败' : '余量查询中…', width);
    const reading = row.reading;
    if (reading.status !== 'ok') {
      const status = reading.status === 'error' ? '余量查询失败' : '余量不可用';
      return truncate(`${status} · ${reading.message}`, width);
    }
    const prefix = '剩余 ';
    const detailed = prefix + row.inline.map(limit => limit.detail).join(' · ');
    if (textWidth(detailed) <= width) return detailed;
    let shown = prefix;
    for (const [i, limit] of row.inline.entries()) {
      const next = shown + (i ? ' · ' : '') + limit.short;
      const hidden = row.inline.length - i - 1;
      if (textWidth(next + (hidden ? ` +${hidden}` : '')) > width) {
        const suffix = i ? ` +${hidden + 1}` : hidden ? ` +${hidden}` : '';
        return truncate(i ? shown : next, Math.max(0, width - textWidth(suffix))) + suffix;
      }
      shown = next;
    }
    return shown;
  }

  handleKey(k: Key): void {
    if (k.name === 'char' && k.text === 'r') void this.refresh();
    if (k.name === 'up') this.top--;
    if (k.name === 'down') this.top++;
    if (k.name === 'pgup') this.top -= this.height;
    if (k.name === 'pgdn') this.top += this.height;
    if (k.name === 'wheelup') this.top -= 3;
    if (k.name === 'wheeldown') this.top += 3;
    if (k.name === 'home') this.top = 0;
    if (k.name === 'end') this.top = this.maxTop;
    this.top = Math.max(0, Math.min(this.top, this.maxTop));
  }

  draw(s: Screen): void {
    s.put(1, 0, '套餐余量', `1;${GOLD}`);
    const status = this.request ? '查询中…' : this.failed ? '查询失败，按 r 重试' : `上次查询 ${this.checked}`;
    s.put(1, 1, `每 ${QUOTA_REFRESH_MS / 1000} 秒刷新 · ${status}`, this.failed ? RED : DIM);
    s.put(0, 2, '─'.repeat(s.cols), DIM);

    const lines: Cell[][] = [];
    for (const row of this.results.values()) {
      const name = row.label === row.targetId ? row.label : `${row.label} (${row.targetId})`;
      const detail = [row.provider !== row.targetId ? row.provider : '', row.model].filter(Boolean).join(' / ');
      const heading = [...toCells(name, '1'), ...toCells(detail ? '  ' + detail : '', DIM)];
      lines.push(...wrap(heading, s.cols - 2));
      const style = row.reading.status === 'error' ? RED : row.reading.status === 'unavailable' ? DIM : '';
      for (const line of formatQuota(row.reading)) {
        lines.push(...wrap(toCells('  ' + line, style), s.cols - 2, 2));
      }
      lines.push([]);
    }
    if (lines.length) lines.pop();
    if (!lines.length && !this.request && !this.failed) {
      lines.push(toCells('没有已配置的模型', DIM));
    }
    this.height = s.rows - 4;
    this.maxTop = Math.max(0, lines.length - this.height);
    this.top = Math.min(this.top, this.maxTop);
    lines.slice(this.top, this.top + this.height).forEach((line, i) => s.putCells(1, i + 3, line));
    const scroll = this.maxTop > 0 ? `  ↑↓ 滚动  ${this.top + 1}–${this.top + this.height}/${lines.length}` : '';
    s.put(1, s.rows - 1, `Esc 返回  r 刷新${scroll}`, DIM);
  }
}
