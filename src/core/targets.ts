import type { Config } from './config.js';
import type { ModelTarget, ProviderAdapter } from './types.js';

/** Targets sharing an adapter share one availability probe within an operation. */
export async function detectTargets(targets: ModelTarget[], signal?: AbortSignal): Promise<Map<string, boolean>> {
  const probes = new Map<ProviderAdapter, Promise<boolean>>();
  for (const t of targets) if (!probes.has(t.adapter)) probes.set(t.adapter, t.adapter.detect(signal).then((r) => r.installed).catch(() => false));
  return new Map(await Promise.all(targets.map(async (t) => [t.id, await probes.get(t.adapter)!] as const)));
}

export function defaultTargetIds(cfg: Config, targets: ModelTarget[]): string[] {
  return cfg.providers ?? targets.filter((t) => t.id !== cfg.decider).map((t) => t.id);
}
