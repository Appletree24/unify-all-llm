import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { QuotaReading } from '../../../src/quota/types.js';
import type { RunRecord, RunResultRecord } from '../shared/api.js';
import { unify } from './api.js';
import { renderMarkdown } from './markdown.js';

// ── icons ─────────────────────────────────────────────────────────────────
const paths: Record<string, ReactNode> = {
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20 14a8.5 8.5 0 0 1-10-10 8.6 8.6 0 1 0 10 10Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  edit: <path d="m14 6 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z" />,
  pin: <path d="m16 3 5 5-3 1-3 4v3l-2 2-7-7 2-2h3l4-3 1-3Zm-6 12-6 6" />,
  trash: <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />,
  send: <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  expand: <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />,
  shrink: <path d="M4 14h6v6M20 10h-6V4M14 10l6-6M10 14l-6 6" />,
  retry: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  run: <path d="m5 17 5-5-5-5M12 19h7" />,
  gauge: <><path d="M4.2 17.5a9 9 0 1 1 15.6 0" /><path d="m12 13 4-4" /></>,
  layers: <><path d="m12 3 9 4.5-9 4.5-9-4.5z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></>,
  sliders: <path d="M4 20v-6M4 10V4M12 20v-8M12 8V4M20 20v-4M20 12V4M2 14h4M10 8h4M18 16h4" />,
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  spark: <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.9L12 18.5l-1.8-5.8-5.7-1.9L10.2 9z" />,
  branch: <><circle cx="6" cy="5.5" r="2" /><circle cx="6" cy="18.5" r="2" /><circle cx="18" cy="7.5" r="2" /><path d="M6 7.5v9M18 9.5c0 4.5-6 3.5-11 7" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  chat: <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />,
  bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4z" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

// ── formatting ────────────────────────────────────────────────────────────
export const ACTIVE: RunRecord['status'][] = ['created', 'deciding', 'answering', 'synthesizing'];
export const isActive = (r: RunRecord) => ACTIVE.includes(r.status);

/** A stable hue per target id so the same model has the same color everywhere. */
export function hue(id: string): number {
  const hues = [222, 18, 152, 266, 38, 190, 330, 96];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[h % hues.length];
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export function kilo(n?: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function until(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return '即将重置';
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分钟后重置`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时后重置`;
  return `${new Date(iso).toLocaleDateString('zh-CN')} 重置`;
}

export const statusText: Record<RunResultRecord['status'], string> = {
  running: '生成中', succeeded: '完成', failed: '失败', cancelled: '已取消', timed_out: '超时', interrupted: '中断',
};

const FIVE_HOUR_LIMIT = /(?:^|[^\d])(?:5\s*小时|5\s*h(?:ours?)?\b|5-hour\b|five[_ -]?hour\b)/i;
const GEMINI_GROUP_LIMIT = /^gemini(?:\s+models?)?(?:\s*·|\b)/i;
const CLAUDE_GPT_GROUP_LIMIT = /\b(?:claude|gpt)\b/i;

/** The representative limit of a quota reading, for compact display. */
export function quotaSummary(
  reading?: QuotaReading,
  target?: { provider?: string; model?: string },
): { text: string; ratio?: number; title: string } | undefined {
  if (!reading) return undefined;
  if (reading.status !== 'ok') return { text: '', title: reading.message };
  const scored = reading.limits.map((l) => ({
    l, ratio: l.unit === '%' ? l.remaining / 100 : l.total ? l.remaining / l.total : undefined,
  }));
  let pool = scored;
  let preferFiveHour = false;
  if (target?.provider === 'gemini-pro' || (!!target?.model && /\bgemini\b/i.test(target.model))) {
    const wantsClaudeGpt = !!target?.model && CLAUDE_GPT_GROUP_LIMIT.test(target.model);
    const matched = scored.filter((s) =>
      wantsClaudeGpt ? CLAUDE_GPT_GROUP_LIMIT.test(s.l.label) : GEMINI_GROUP_LIMIT.test(s.l.label),
    );
    if (matched.length) {
      pool = matched;
      preferFiveHour = true;
    }
  }
  const pick = (preferFiveHour ? pool.find((s) => FIVE_HOUR_LIMIT.test(s.l.label)) : undefined)
    ?? pool.filter((s) => s.ratio !== undefined).sort((a, b) => a.ratio! - b.ratio!)[0]
    ?? pool[0];
  if (!pick) return { text: '', title: '没有额度信息' };
  const { l } = pick;
  const text = l.unit === '%' ? `${Math.round(l.remaining)}%` : l.total ? `${Math.round((l.remaining / l.total) * 100)}%` : `${l.remaining}${l.unit === '%' ? '' : ' ' + l.unit}`;
  const title = reading.limits.map((x) => `${x.label} 剩余 ${x.remaining}${x.total !== undefined ? ` / ${x.total}` : ''}${x.unit === '%' ? '%' : ' ' + x.unit}`).join('\n');
  return { text, ratio: pick.ratio, title };
}

// ── components ────────────────────────────────────────────────────────────
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const button = (e.target as HTMLElement).closest('.code-copy');
        if (!button) return;
        const code = button.closest('.code')?.querySelector('code')?.textContent ?? '';
        void unify.copy(code).then(() => {
          button.textContent = '已复制';
          setTimeout(() => { button.textContent = '复制'; }, 1400);
        });
      }}
    />
  );
});

/** Re-render on a timer while something is running, for elapsed-time labels. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="进行中" />;
}
