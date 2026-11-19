import { requestJsonl } from '../core/proc.js';
import type { QuotaLimit, QuotaReader, QuotaReading } from './types.js';
import { addUsageWindow } from './windows.js';

function durationLabel(minutes: unknown, fallback: string) {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

// account/rateLimits/read returns both a legacy view and, on newer clients, named buckets.
function quotaFromResponse(result: Record<string, any>): QuotaReading {
  const limits: QuotaLimit[] = [];
  const buckets: Record<string, any> = result.rateLimitsByLimitId ?? {};
  const snapshots = Object.keys(buckets).length ? Object.entries(buckets) : [['Codex', result.rateLimits] as const];
  for (const [id, snapshot] of snapshots) {
    if (!snapshot) continue;
    const name = snapshot.limitName || snapshot.limitId || id;
    for (const [key, fallback] of [['primary', '主窗口'], ['secondary', '次窗口']]) {
      const window = snapshot[key];
      if (window) addUsageWindow(limits, `${name} · ${durationLabel(window.windowDurationMins, fallback)}`, window.usedPercent, window.resetsAt);
    }
    const balance = snapshot.credits?.balance;
    if (!snapshot.credits?.unlimited && typeof balance === 'string' && balance.trim() && Number.isFinite(Number(balance))) {
      limits.push({ label: `${name} · 点数`, remaining: Number(balance), unit: 'credits' });
    }
  }
  return limits.length ? { status: 'ok', limits } : { status: 'unavailable', message: 'Codex 未返回可计量的额度，请用 /status 查看当前账户' };
}

export const readCodexQuota: QuotaReader = async (ctx) => {
  const initialize = { id: 1, method: 'initialize', params: { clientInfo: { name: 'unify_llm', title: 'Unify LLM', version: '0.1.0' } } };
  try {
    return await requestJsonl<QuotaReading>('codex', ['app-server'], ctx, initialize, (event, send) => {
      if (event.id === 1) {
        if (!event.result) throw new Error('initialize');
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      }
      if (event.id === 2) {
        if (!event.result) throw new Error('account/rateLimits/read');
        return quotaFromResponse(event.result);
      }
    });
  } catch {
    ctx.signal.throwIfAborted();
    return { status: 'error', message: '请检查 Codex CLI 版本、网络及 ChatGPT 登录状态（codex login status）' };
  }
};
