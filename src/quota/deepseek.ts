import { z } from 'zod';
import type { QuotaReading, QuotaContext } from './types.js';

const balance = z.object({
  balance_infos: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    total_balance: z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number).pipe(z.number()),
  })).min(1),
});

// https://api-docs.deepseek.com/api/get-user-balance/
export async function readDeepseekQuota({ signal }: QuotaContext, key = process.env.DEEPSEEK_API_KEY): Promise<QuotaReading> {
  if (!key) return { status: 'unavailable', message: '使用 /settings 配置密钥或设置 DEEPSEEK_API_KEY' };
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    return { status: 'error', message: `DeepSeek 余额接口返回 HTTP ${res.status}` };
  }
  const parsed = balance.safeParse(await res.json());
  if (!parsed.success) return { status: 'error', message: 'DeepSeek 未返回有效的账户余额' };
  return {
    status: 'ok',
    limits: parsed.data.balance_infos.map(info => ({
      label: '账户余额', remaining: info.total_balance, unit: info.currency,
    })),
  };
}
