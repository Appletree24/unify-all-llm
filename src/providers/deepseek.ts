import type { ProviderAdapter } from '../core/types.js';
import { customAdapter } from './custom.js';

export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * DeepSeek's official API speaks the OpenAI chat-completions protocol, so the
 * built-in target is the "openai" transport with a fixed endpoint. Unlike
 * `custom`, the endpoint cannot be redirected by configuration, which keeps it
 * safe to select from project config. It is available once the key is in the
 * environment and, like every HTTP target, is answer-only.
 */
export function deepseekAdapter(baseUrl = 'https://api.deepseek.com'): ProviderAdapter {
  return customAdapter('deepseek', { type: 'openai', label: 'DeepSeek', baseUrl, model: 'deepseek-flash', apiKeyEnv: DEEPSEEK_KEY_ENV });
}

export const deepseek = deepseekAdapter();
