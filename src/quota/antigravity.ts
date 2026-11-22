import { z } from 'zod';
import { probeVersion, runJsonl } from '../core/proc.js';
import type { QuotaLimit, QuotaReader } from './types.js';

const label = z.string().trim().min(1).max(180).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);
const group = z.object({ name: label, buckets: z.array(z.unknown()) });
const bucket = z.object({
  name: label,
  window: z.string().optional(),
  remaining_fraction: z.number().min(0).max(1),
  reset_time: z.iso.datetime({ offset: true }).optional(),
});
const result = z.object({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  command: z.object({ name: z.literal('usage'), data: z.object({ groups: z.array(z.unknown()) }) }),
});

function supportsHeadlessUsage(version: string) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)(?:[+\s]|$)/.exec(version);
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

export const readAntigravityQuota: QuotaReader = async (ctx) => {
  const options = { nativeExecutable: true };
  const version = await probeVersion('agy', ctx.signal, options);
  ctx.signal.throwIfAborted();
  if (!version) return { status: 'unavailable', message: '未检测到 Antigravity CLI（agy）' };
  if (!supportsHeadlessUsage(version)) {
    return { status: 'unavailable', message: '请将 agy 更新到 1.1.11 或更高版本后查询套餐额度' };
  }

  // Pin slash-command handling for this invocation so /usage cannot become a model prompt.
  const args = ['--settings', JSON.stringify({ disableSlashCommands: false }), '--disable-slash-commands=false',
    '-p', '/usage', '--output-format', 'json', '--print-timeout', '10s'];
  try {
    const limits: QuotaLimit[] = [];
    for await (const event of runJsonl('agy', args, { ...ctx, ...options })) {
      for (const rawGroup of result.parse(event).command.data.groups) {
        const parsedGroup = group.safeParse(rawGroup);
        if (!parsedGroup.success) continue;
        const { name, buckets } = parsedGroup.data;
        for (const rawBucket of buckets) {
          const parsedBucket = bucket.safeParse(rawBucket);
          if (!parsedBucket.success) continue;
          const { window, remaining_fraction, reset_time } = parsedBucket.data;
          const duration = window === 'weekly' ? '7 天' : window === '5h' ? '5 小时' : parsedBucket.data.name;
          limits.push({
            label: `${name} · ${duration}`,
            remaining: Number((remaining_fraction * 100).toFixed(4)),
            unit: '%',
            ...(reset_time ? { resetsAt: reset_time } : {}),
          });
        }
      }
    }
    return limits.length ? { status: 'ok', limits } : { status: 'unavailable', message: 'Antigravity 未返回可读的套餐额度' };
  } catch {
    ctx.signal.throwIfAborted();
    return { status: 'error', message: 'Antigravity 额度查询失败，请检查 agy 的 Google 登录及网络连接' };
  }
};
