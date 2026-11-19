import { z } from 'zod';
import { runText } from '../core/proc.js';
import type { QuotaReader } from './types.js';

const text = z.string().trim().min(1).max(180).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);
const timestamp = z.iso.datetime({ offset: true });
const resultSchema = z.object({
  limits: z.array(z.object({
    label: text, remaining: z.number(), unit: text, total: z.number().nonnegative().optional(),
    resetsAt: timestamp.optional(),
  }).refine(item => item.unit !== '%' || (item.remaining >= 0 && item.remaining <= 100))).min(1),
  observedAt: timestamp.optional(),
});

export function commandQuota(command: string, args: string[] = []): QuotaReader {
  return async ({ cwd, signal }) => {
    let stdout = '';
    try {
      for await (const chunk of runText(command, args, { cwd, signal })) {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 65_536) return { status: 'error', message: '额度命令输出超过 64 KiB' };
      }
    } catch {
      signal.throwIfAborted();
      return { status: 'error', message: '额度命令执行失败，请检查可执行文件及退出码' };
    }
    try {
      return { status: 'ok', ...resultSchema.parse(JSON.parse(stdout)) };
    } catch {
      return { status: 'error', message: '额度命令需返回 JSON，其中 limits 包含 label、remaining、unit' };
    }
  };
}
