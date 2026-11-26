import type { Config } from './config.js';
import type { ModelTarget, ProviderAdapter } from './types.js';

/** Targets sharing an adapter share one availability probe within an operation. */
export async function detectTargets(targets: ModelTarget[], signal?: AbortSignal, cache?: WeakMap<ProviderAdapter, number>): Promise<Map<string, boolean>> {
  const probes = new Map<ProviderAdapter, Promise<boolean>>();
  for (const { adapter } of targets) {
    if (probes.has(adapter)) continue;
    if (!signal?.aborted && (cache?.get(adapter) ?? 0) > Date.now()) probes.set(adapter, Promise.resolve(true));
    else probes.set(adapter, adapter.detect(signal).then(r => {
      if (r.installed && !signal?.aborted) cache?.set(adapter, Date.now() + 60_000);
      return r.installed;
    }).catch(() => false));
  }
  return new Map(await Promise.all(targets.map(async (t) => [t.id, await probes.get(t.adapter)!] as const)));
}

export function defaultTargetIds(cfg: Config, targets: ModelTarget[]): string[] {
  return cfg.providers ?? targets.filter((t) => t.id !== cfg.decider && t.adapter.autoSelect !== false).map((t) => t.id);
}
