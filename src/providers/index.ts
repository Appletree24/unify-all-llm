import { parseConfig, type Config } from '../core/config.js';
import type { ModelTarget, ProviderAdapter } from '../core/types.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { customAdapter } from './custom.js';
import { deepseek } from './deepseek.js';
import { gemini } from './gemini.js';

const builtin: Record<string, ProviderAdapter> = { claude, codex, gemini, deepseek };
/** HTTP built-ins a user-level custom entry may replace, e.g. to route through a gateway. */
const replaceable = new Set(['deepseek']);
export const RESERVED: Record<string, string> = { jev: 'Jev（System One 决策模型）' };

/** Resolve adapter capabilities and model configuration once, before running anything. */
export function buildRegistry(config: Config): Record<string, ModelTarget> {
  const cfg = parseConfig(config);
  const adapters = { ...builtin };
  if (cfg.disableClaude) adapters.claude = {
    ...claude,
    async detect() { return { installed: false }; },
    async *run() { throw new Error('Claude Code 已通过 disableClaude 禁用'); },
  };
  for (const [id, c] of Object.entries(cfg.custom ?? {})) {
    if (Object.hasOwn(builtin, id) && !replaceable.has(id)) throw new Error(`自定义模型 ${id} 与内置模型重名`);
    adapters[id] = customAdapter(id, RESERVED[id] ? { label: 'Jev', ...c } : c);
  }
  const targets: Record<string, ModelTarget> = {};
  for (const a of Object.values(adapters)) targets[a.id] = { id: a.id, label: a.label, adapter: a, model: cfg.models?.[a.id] };
  for (const [id, t] of Object.entries(cfg.targets ?? {})) {
    if (Object.hasOwn(adapters, id)) throw new Error(`目标 ${id} 与 provider 重名，请使用独立目标 id`);
    const adapter = adapters[t.provider];
    if (!adapter) throw new Error(`目标 ${id} 引用了未知 provider ${t.provider}`);
    targets[id] = { id, adapter, label: t.label ?? id, model: t.model ?? cfg.models?.[t.provider] };
  }
  for (const id of [...(cfg.providers ?? []), ...Object.keys(cfg.models ?? {}), ...[cfg.synthesizer, cfg.executor, cfg.decider].filter((s): s is string => !!s)]) {
    if (!Object.hasOwn(targets, id)) throw new Error(`配置引用了未知目标 ${id}`);
  }
  for (const [id, model] of Object.entries(cfg.models ?? {})) targets[id].model = model;
  if (cfg.executor && !targets[cfg.executor].adapter.capabilities.exec) throw new Error(`执行目标 ${cfg.executor} 不支持实施`);
  return targets;
}
