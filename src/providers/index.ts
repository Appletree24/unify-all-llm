import { parseConfig, type Config } from '../core/config.js';
import type { ModelTarget, ProviderAdapter } from '../core/types.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { customAdapter } from './custom.js';
import { officialAdapter, officialApis, readApiProfile } from './official.js';
import { geminiPro } from './antigravity.js';
import { readClaudeQuota } from '../quota/claude.js';
import { readCodexQuota } from '../quota/codex.js';
import { commandQuota } from '../quota/command.js';

import { effortChoices } from './effort.js';

const builtin: Record<string, ProviderAdapter> = {
  claude: { ...claude, readQuota: readClaudeQuota },
  codex: { ...codex, readQuota: readCodexQuota },
};
export const RESERVED: Record<string, string> = { jev: 'Jev（System One 决策模型）' };

/** Resolve adapter capabilities and model configuration once, before running anything. */
export function buildRegistry(config: Config, readProfile = readApiProfile): Record<string, ModelTarget> {
  const cfg = parseConfig(config);
  const adapters = { ...builtin };
  if (!cfg.custom?.[geminiPro.id] && !cfg.targets?.[geminiPro.id]) adapters[geminiPro.id] = geminiPro;
  for (const api of officialApis) {
    // Existing user transports and target aliases keep their IDs across upgrades.
    if (cfg.custom?.[api.id] || (api.id !== 'deepseek' && cfg.targets?.[api.id])) continue;
    const profile = readProfile(api);
    if (profile || api.id === 'deepseek') adapters[api.id] = officialAdapter(api, profile);
  }
  for (const [id, c] of Object.entries(cfg.custom ?? {})) {
    if (Object.hasOwn(builtin, id)) throw new Error(`自定义模型 ${id} 与内置模型重名`);
    adapters[id] = customAdapter(id, RESERVED[id] ? { label: 'Jev', ...c } : c);
  }
  for (const [id, c] of Object.entries(cfg.quotaCommands ?? {})) {
    if (!Object.hasOwn(adapters, id)) throw new Error(`quotaCommands 引用了未知 provider ${id}`);
    adapters[id] = { ...adapters[id], readQuota: commandQuota(c.command, c.args) };
  }
  if (cfg.disableClaude) adapters.claude = {
    ...claude,
    async readQuota() { return { status: 'unavailable', message: 'Claude Code 已通过 disableClaude 禁用' }; },
    async detect() { return { installed: false }; },
    async *run() { throw new Error('Claude Code 已通过 disableClaude 禁用'); },
  };
  const targets: Record<string, ModelTarget> = {};
  for (const a of Object.values(adapters)) targets[a.id] = { id: a.id, label: a.label, adapter: a, model: cfg.models?.[a.id] };
  for (const [id, t] of Object.entries(cfg.targets ?? {})) {
    if (Object.hasOwn(adapters, id)) throw new Error(`目标 ${id} 与 provider 重名，请使用独立目标 id`);
    const adapter = adapters[t.provider];
    if (!adapter) throw new Error(`目标 ${id} 引用了未知 provider ${t.provider}`);
    targets[id] = { id, adapter, label: t.label ?? id, model: t.model ?? cfg.models?.[t.provider] };
  }
  for (const id of [...(cfg.providers ?? []), ...Object.keys(cfg.models ?? {}), ...Object.keys(cfg.reasoningEffort ?? {}), ...[cfg.synthesizer, cfg.executor, cfg.decider].filter((s): s is string => !!s)]) {
    if (!Object.hasOwn(targets, id)) throw new Error(`配置引用了未知目标 ${id}`);
  }
  for (const [id, model] of Object.entries(cfg.models ?? {})) targets[id].model = model;
  for (const target of Object.values(targets)) {
    target.model ??= target.adapter.defaultModel;
    const effort = cfg.reasoningEffort?.[target.id] ?? cfg.targets?.[target.id]?.reasoningEffort;
    if (effort === 'default') continue;
    if (effort && !effortChoices(target).includes(effort)) throw new Error(`目标 ${target.id} 不支持思考强度 ${effort}`);
    target.reasoningEffort = effort;
  }
  if (cfg.executor && !targets[cfg.executor].adapter.capabilities.exec) throw new Error(`执行目标 ${cfg.executor} 不支持实施`);
  return targets;
}
