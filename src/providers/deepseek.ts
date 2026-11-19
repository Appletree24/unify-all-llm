import type { ProviderAdapter } from '../core/types.js';
import { customAdapter } from './custom.js';

export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';

export const deepseekApi = {
  id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: DEEPSEEK_KEY_ENV,
} as const;

export function deepseekAdapter(baseUrl: string = deepseekApi.baseUrl): ProviderAdapter {
  const { id, ...config } = deepseekApi;
  return customAdapter(id, { ...config, type: 'openai', baseUrl });
}

export const deepseek = deepseekAdapter();
