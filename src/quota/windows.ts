import type { QuotaLimit } from './types.js';

/** Codex reports Unix seconds; Claude also returns ISO timestamps. */
export function addUsageWindow(limits: QuotaLimit[], label: string, used: unknown, reset: unknown) {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return;
  const remaining = Number(Math.max(0, 100 - used).toFixed(4));
  const limit: QuotaLimit = { label, remaining, unit: '%' };
  const date = typeof reset === 'number' ? new Date(reset * 1000) : typeof reset === 'string' ? new Date(reset) : undefined;
  if (date && Number.isFinite(date.getTime())) limit.resetsAt = date.toISOString();
  limits.push(limit);
}
