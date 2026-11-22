import type { TargetQuota } from './types.js';

export const QUOTA_RESET_NOTICE_MINUTES = 30;
export const QUOTA_LOW_PERCENT = 10;

const RESET_LEAD_MS = QUOTA_RESET_NOTICE_MINUTES * 60_000;
const WITHOUT_RESET_TTL_MS = 30 * 86_400_000;
const amountFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });

export type QuotaReminderHistory = Record<string, number>;
export interface QuotaNotice { title: string; lines: string[] }

/** Mark each notification once per provider bucket and reset window, including across app restarts. */
export function collectQuotaReminders(quotas: TargetQuota[], previous: QuotaReminderHistory, now = Date.now()): {
  notice?: QuotaNotice; history: QuotaReminderHistory; changed: boolean;
} {
  const history = Object.fromEntries(Object.entries(previous).filter(([, expiry]) => Number.isFinite(expiry) && expiry > now));
  const lines: string[] = [];
  let hasLow = false;
  let hasReset = false;
  for (const { label, provider, reading } of quotas) {
    if (reading.status !== 'ok') continue;
    for (const limit of reading.limits) {
      const { remaining, unit, total, resetsAt } = limit;
      if (!Number.isFinite(remaining) || remaining < 0) continue;
      const timestamp = resetsAt ? Date.parse(resetsAt) : NaN;
      const reset = Number.isFinite(timestamp) ? timestamp : undefined;
      if (reset !== undefined && reset <= now) continue;

      const key = JSON.stringify([provider, limit.label, unit, reset]);
      const lowKey = key + '/low';
      const resetKey = key + '/reset';
      const percent = unit === '%' ? remaining : total && total > 0 ? remaining / total * 100 : undefined;
      // With no reset timestamp, wait for a genuine recovery before rearming a low alert.
      if (reset === undefined && percent !== undefined && percent > QUOTA_LOW_PERCENT + 5) delete history[lowKey];
      const low = percent !== undefined && percent <= QUOTA_LOW_PERCENT && !Object.hasOwn(history, lowKey);
      const minutes = reset === undefined ? undefined : Math.ceil((reset - now) / 60_000);
      const nearReset = reset !== undefined && reset - now <= RESET_LEAD_MS && remaining > 0 && !Object.hasOwn(history, resetKey);
      if (!low && !nearReset) continue;

      if (low) { history[lowKey] = reset ?? now + WITHOUT_RESET_TTL_MS; hasLow = true; }
      if (nearReset) { history[resetKey] = reset; hasReset = true; }
      const amount = `${amountFormat.format(remaining)}${unit === '%' ? '%' : ' ' + unit}`;
      const detail = remaining === 0 ? '额度已用完' : `剩余 ${amount}${nearReset ? `，约 ${minutes} 分钟后重置` : ''}`;
      const lowHint = low && nearReset ? '，额度快用完了' : '';
      lines.push(`${label} · ${limit.label} · ${detail}${lowHint}`);
    }
  }
  const title = hasLow && hasReset ? '套餐额度提醒' : hasReset ? '额度即将重置' : '额度快用完了';
  const changed = lines.length > 0 || Object.keys(history).length !== Object.keys(previous).length;
  return { notice: lines.length ? { title, lines } : undefined, history, changed };
}
