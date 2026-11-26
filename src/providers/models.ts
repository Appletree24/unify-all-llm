import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { effortSchema, readJson } from '../core/config.js';
import { requestJsonl, runText } from '../core/proc.js';
import type { ModelTarget } from '../core/types.js';
import { parseAgyModels, type AgyModel } from './agy-models.js';
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
  models: z.array(z.object({
    slug: z.string().regex(/^\S+$/), visibility: z.string(),
    default_reasoning_level: z.string().nullish(),
    supported_reasoning_levels: z.array(z.object({ effort: z.string() })).nullish(),
  })),
});

function readCodexCatalog() {
  try {
    const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
    return codexCache.safeParse(readJson(path)).data?.models ?? [];
  } catch { return []; }
}

export function applyCodexEfforts(targets: ModelTarget[]) {
  const catalog = readCodexCatalog();
  for (const target of targets) {
    if (target.adapter.id !== 'codex' || !target.model) continue;
    const entry = catalog.find(model => model.slug === target.model);
    if (!entry) continue;
    target.defaultEffort = effortSchema.safeParse(entry.default_reasoning_level).data;
    if (entry.supported_reasoning_levels) {
      target.supportedEfforts = entry.supported_reasoning_levels.flatMap(({ effort }) => {
        const level = effortSchema.safeParse(effort).data;
        return level ? [level] : [];
      });
    }
  }
}

// Keep successful CLI discovery local to the host. Explicit refreshes bypass this cache.
type CachedCatalog<T> = { cwd: string; expires: number; data: T };
const agyCatalogs = new WeakMap<object, CachedCatalog<AgyModel[]>>();
const codexCatalogs = new WeakMap<object, CachedCatalog<Awaited<ReturnType<typeof readCodexEfforts>>>>();
async function cachedCatalog<T>(cache: WeakMap<object, CachedCatalog<T>>, owner: object | undefined, cwd: string, read: () => Promise<T>) {
  const cached = owner && cache.get(owner);
  if (cached && cached.cwd === cwd && cached.expires > Date.now()) return cached.data;
  const data = await read();
  if (owner) cache.set(owner, { cwd, expires: Date.now() + 60_000, data });
  return data;
}

async function readCodexEfforts(cwd: string, signal: AbortSignal) {
  const opts = { cwd, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) };
  const initialize = { id: 1, method: 'initialize', params: { clientInfo: { name: 'unify_llm', version: '0.1.0' } } };
  let inherited: string | undefined;
  const models: { model: string; supportedEfforts: NonNullable<ModelTarget['supportedEfforts']>; isDefault: boolean }[] = [];
  const levelList = z.array(z.object({ reasoningEffort: z.string() }));
  const list = (cursor?: string) => ({ id: 3, method: 'model/list', params: { includeHidden: true, limit: 100, cursor } });
  return requestJsonl('codex', ['app-server'], opts, initialize, (event, send) => {
    if (event.error) throw new Error(event.error.message ?? '无法读取 Codex 模型目录');
    if (event.id === 1) {
      send({ method: 'initialized' });
      send({ id: 2, method: 'config/read', params: { cwd } });
    } else if (event.id === 2) {
      inherited = event.result?.config?.model ?? undefined;
      send(list());
    } else if (event.id === 3) {
      for (const entry of event.result?.data ?? []) {
        const levels = levelList.safeParse(entry.supportedReasoningEfforts);
        if (typeof entry.model !== 'string' || !levels.success) continue;
        const supportedEfforts = levels.data.flatMap(({ reasoningEffort }) => {
          const parsed = effortSchema.safeParse(reasoningEffort);
          return parsed.success ? [parsed.data] : [];
        });
        models.push({ model: entry.model, supportedEfforts, isDefault: entry.isDefault === true });
      }
      if (event.result?.nextCursor) { send(list(event.result.nextCursor)); return; }
      return { inherited, models };
    }
  });
}

export async function resolveCodexEffortModels(targets: ModelTarget[], cwd: string, signal: AbortSignal, owner?: object): Promise<ModelTarget[]> {
  const { inherited, models } = await cachedCatalog(codexCatalogs, owner, cwd, () => readCodexEfforts(cwd, signal));
  return targets.map(t => {
    if (t.adapter.id !== 'codex' || t.supportedEfforts) return t;
    const name = t.model ?? inherited;
    const entry = models.find(m => name ? m.model === name : m.isDefault);
    return entry ? { ...t, model: entry.model, supportedEfforts: entry.supportedEfforts } : t;
  });
}

export function readAgyModels(cwd: string, signal?: AbortSignal, owner?: object) {
  return cachedCatalog(agyCatalogs, owner, cwd, () => fetchAgyModels(cwd, signal));
}

async function fetchAgyModels(cwd: string, signal?: AbortSignal) {
  let output = '';
  const timeout = AbortSignal.timeout(20_000);
  const opts = { cwd, nativeExecutable: true, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  for await (const chunk of runText('agy', ['models'], opts)) output += chunk;
  return parseAgyModels(output);
}

export function modelIds(provider: string, configured: readonly string[] = []): string[] {
  let ids = Object.hasOwn(modelsByProvider, provider) ? modelsByProvider[provider] : [];
  if (provider === 'codex') {
    const visible = readCodexCatalog().filter(model => model.visibility === 'list').map(model => model.slug);
    if (visible.length) ids = visible;
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
