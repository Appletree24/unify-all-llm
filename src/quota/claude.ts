import { requestJsonl } from '../core/proc.js';
import type { QuotaLimit, QuotaReader, QuotaReading } from './types.js';
import { addUsageWindow } from './windows.js';

function quotaFromResponse(data: Record<string, any>): QuotaReading {
  const usage = data.rate_limits;
  if (data.rate_limits_available === false) return { status: 'unavailable', message: '当前 Claude 登录方式未提供套餐额度，请用 claude auth status 查看账户' };
  const limits: QuotaLimit[] = [];
  for (const [key, window] of Object.entries<Record<string, any> | null>(usage ?? {})) {
    if (!window) continue;
    const match = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
    if (!match) continue;
    const duration = match[1] === 'five_hour' ? '5 小时' : '7 天';
    const label = match[2] ? `${duration} · ${match[2].replaceAll('_', ' ')}` : duration;
    addUsageWindow(limits, label, window.utilization, window.resets_at);
  }
  if (Array.isArray(usage?.model_scoped)) {
    for (const item of usage.model_scoped) {
      if (typeof item?.display_name === 'string') addUsageWindow(limits, `7 天 · ${item.display_name}`, item.utilization, item.resets_at);
    }
  }
  return limits.length ? { status: 'ok', limits } : { status: 'unavailable', message: 'Claude 未返回可计量的窗口，请在 Claude Code 中查看 /usage' };
}

/** Claude Code's Agent SDK control request. No user message or inference turn is sent. */
export const readClaudeQuota: QuotaReader = async (ctx) => {
  const args = ['-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const request = { type: 'control_request', request_id: 'quota', request: { subtype: 'get_usage', skip_behaviors: true } };
  try {
    return await requestJsonl<QuotaReading>('claude', args, ctx, request, (event) => {
      if (event.type !== 'control_response' || event.response?.request_id !== request.request_id) return;
      if (event.response.subtype !== 'success' || !event.response.response) throw new Error('get_usage');
      return quotaFromResponse(event.response.response);
    });
  } catch {
    ctx.signal.throwIfAborted();
    return { status: 'error', message: '请检查 Claude 登录状态、网络及 Claude Code 是否支持 get_usage 和 --safe-mode' };
  }
};
