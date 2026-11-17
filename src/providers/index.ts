import type { Config } from '../core/store.js';
import type { ProviderAdapter } from '../core/types.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { customAdapter } from './custom.js';
import { gemini } from './gemini.js';

const builtin: Record<string, ProviderAdapter> = { claude, codex, gemini };

/**
 * Slots reserved for models that are planned but not wired up yet. They are
 * activated by adding a `custom.<id>` entry to the config — no code change.
 */
export const RESERVED: Record<string, string> = {
  jev: 'Jev（System One 决策模型）',
};

/** Built-in CLIs plus every model declared under `custom` in the config. */
export function buildRegistry(cfg: Config): Record<string, ProviderAdapter> {
  const reg = { ...builtin };
  for (const [id, c] of Object.entries(cfg.custom ?? {})) {
    if (!/^[a-z][\w-]*$/i.test(id)) throw new Error(`自定义模型 id "${id}" 只能包含字母、数字、- 和 _`);
    if (id in builtin) throw new Error(`自定义模型 id "${id}" 与内置模型重名`);
    reg[id] = customAdapter(id, { label: RESERVED[id] ? 'Jev' : undefined, ...c });
  }
  return reg;
}
