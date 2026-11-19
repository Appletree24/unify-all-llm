import type { ModelTarget, ProviderAdapter } from '../core/types.js';
import type { QuotaReading, TargetQuota } from './types.js';
export type { TargetQuota } from './types.js';

export const QUOTA_REFRESH_MS = 60_000;

async function check(adapter: ProviderAdapter, cwd: string, signal?: AbortSignal): Promise<QuotaReading> {
  signal?.throwIfAborted();
  if (!adapter.readQuota) {
    return { status: 'unavailable', message: `可在用户配置的 quotaCommands.${adapter.id} 接入额度查询命令` };
  }
  const ctl = new AbortController();
  const cancel = () => ctl.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  try {
    return await adapter.readQuota({ cwd, signal: ctl.signal });
  } catch {
    return { status: 'error', message: ctl.signal.aborted ? '额度查询超时' : '额度查询失败，请检查连接和登录状态' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    signal?.throwIfAborted();
  }
}

/** A provider reports all of its account/model buckets in one query, including for aliases. */
export async function readTargetQuotas(targets: ModelTarget[], cwd: string, signal?: AbortSignal): Promise<TargetQuota[]> {
  const checks = new Map<ProviderAdapter, Promise<{ checkedAt: string; reading: QuotaReading }>>();
  return Promise.all(targets.map(async ({ id, label, adapter, model }) => {
    let result = checks.get(adapter);
    if (!result) {
      result = check(adapter, cwd, signal).then(reading => ({ reading, checkedAt: new Date().toISOString() }));
      checks.set(adapter, result);
    }
    return { targetId: id, label, provider: adapter.id, model, ...await result };
  }));
}

export function formatQuota(reading: QuotaReading): string[] {
  if (reading.status !== 'ok') {
    return [`${reading.status === 'error' ? '查询失败' : '不可用'} · ${reading.message}`];
  }
  const lines = reading.limits.map(({ label, remaining, unit, total, resetsAt }) => {
    const amount = `${remaining}${total === undefined ? '' : ` / ${total}`}${unit === '%' ? '' : ' '}${unit}`;
    return `${label}　剩余 ${amount}${resetsAt ? ` · 重置 ${new Date(resetsAt).toLocaleString('zh-CN')}` : ''}`;
  });
  if (reading.observedAt) lines.push(`数据时间 ${new Date(reading.observedAt).toLocaleString('zh-CN')}`);
  return lines;
}
