import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson } from '../core/config.js';
import type { ModelTarget } from '../core/types.js';
import { officialApis } from './official.js';

// Text models for each transport. The CLI and HTTP catalogs differ even for the same vendor.
const modelsByProvider: Readonly<Record<string, readonly string[]>> = {
  codex: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
  claude: ['sonnet', 'opus', 'haiku'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  openai: ['gpt-6.2-astra', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1-mini', 'o3'],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'gemini-api': ['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.6-flash'],
};

const codexCache = z.object({
  models: z.array(z.object({ slug: z.string().regex(/^\S+$/), visibility: z.string() })),
});

export function modelIds(provider: string, configured: readonly string[] = []): string[] {
  let ids = Object.hasOwn(modelsByProvider, provider) ? modelsByProvider[provider] : [];
  if (provider === 'codex') {
    try {
      const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
      const cache = codexCache.safeParse(readJson(path));
      if (cache.success) {
        const visible = cache.data.models.filter(model => model.visibility === 'list').map(model => model.slug);
        if (visible.length) ids = visible;
      }
    } catch { /* Missing or unreadable cache: use the bundled catalog. */ }
  }
  return [...new Set([...configured, ...ids])];
}

export function targetModelIds(target: ModelTarget, targets: ModelTarget[]): string[] {
  const { adapter } = target;
  const config = adapter.configuration;
  const ids = targets.filter(item => item.adapter === adapter).flatMap(item => item.model ? [item.model] : []);
  if (!config) return modelIds(adapter.id, ids);
  if (config.type !== 'openai') return ids;
  const official = officialApis.find(api => config.baseUrl.replace(/\/+$/, '') === api.baseUrl);
  return modelIds(official?.id ?? '', [config.model, ...ids]);
}
