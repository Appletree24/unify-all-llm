import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../core/atomic-write.js';
import { readJson } from '../core/config.js';
import type { ProviderAdapter } from '../core/types.js';
import { readDeepseekQuota } from '../quota/deepseek.js';
import { customAdapter } from './custom.js';
import { deepseekApi } from './deepseek.js';

export const officialApis = [
  deepseekApi,
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'gemini-api', label: 'Gemini API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.6-flash', apiKeyEnv: 'GEMINI_API_KEY' },
] as const;

export type OfficialApi = typeof officialApis[number];
const profileSchema = z.strictObject({
  model: z.string().min(1).regex(/^\S+$/),
  apiKey: z.string().min(1).regex(/^[!-~]+$/).optional(),
});
export type ApiProfile = z.infer<typeof profileSchema>;

function profilePath(api: OfficialApi): string {
  return join(homedir(), '.unify', 'api', api.id + '.json');
}

export function readApiProfile(api: OfficialApi): ApiProfile | undefined {
  const path = profilePath(api);
  const value = readJson(path);
  if (value === undefined) return;
  const profile = profileSchema.safeParse(value);
  if (!profile.success) throw new Error(`无效的 API 配置文件 ${path}`);
  return profile.data;
}

export function saveApiProfile(api: OfficialApi, profile: ApiProfile): void {
  if (!profileSchema.safeParse(profile).success) throw new Error('请检查模型 ID 和 API Key 的格式');
  const path = profilePath(api);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, JSON.stringify(profile, null, 2) + '\n');
}

export function officialAdapter(api: OfficialApi, profile?: ApiProfile): ProviderAdapter {
  const getKey = () => profile?.apiKey ?? process.env[api.apiKeyEnv];
  const adapter = customAdapter(api.id, {
    type: 'openai', label: api.label, baseUrl: api.baseUrl, model: profile?.model ?? api.model, apiKeyEnv: api.apiKeyEnv,
  }, getKey);
  if (api.id === 'deepseek') adapter.readQuota = ctx => readDeepseekQuota(ctx, getKey());
  return adapter;
}
