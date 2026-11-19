import type { ReasoningEffort } from '../core/config.js';
import type { ModelTarget } from '../core/types.js';

const standard = ['low', 'medium', 'high'] as const;
const budgets = { low: 1024, medium: 4096, high: 8192 };

export function effortChoices({ adapter, model }: ModelTarget): readonly ReasoningEffort[] {
  const config = adapter.configuration;
  if (!config && adapter.id === 'codex') return [...standard, 'xhigh'];
  if (!config && adapter.id === 'claude') return [...standard, 'xhigh', 'max'];
  if (config?.type !== 'openai') return [];
  const host = new URL(config.baseUrl).hostname;
  const name = model ?? config.model;
  if (host === 'api.deepseek.com') return ['none', 'low', 'high', 'max'];
  if (host === 'api.anthropic.com') {
    // These models accept explicit thinking budgets through the compatibility API.
    return /^claude-(haiku-4-5|sonnet-4(?:-5|-6)?|opus-4(?:-1|-5)?)(?:-\d{8})?$/.test(name) ? standard : [];
  }
  if (host === 'generativelanguage.googleapis.com') return standard;
  if (host === 'api.openai.com') {
    if (/^gpt-(?:[34]|.*-chat)/.test(name)) return [];
    if (/^o[1-4](?:-|$)/.test(name)) return standard;
    if (/^gpt-5(?:$|-(?:mini|nano|20))/.test(name)) return ['minimal', ...standard];
    return ['none', ...standard, 'xhigh'];
  }
  return ['minimal', ...standard, 'xhigh'];
}

export function httpEffort(baseUrl: string, effort?: ReasoningEffort): Record<string, unknown> {
  if (!effort) return {};
  const host = new URL(baseUrl).hostname;
  if (host === 'api.deepseek.com') {
    return effort === 'none' ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, reasoning_effort: effort };
  }
  if (host === 'api.anthropic.com') {
    const budget = budgets[effort as keyof typeof budgets];
    if (!budget) throw new Error('该 Claude 模型支持 low、medium、high 思考预算');
    return { thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: budget + 4096 };
  }
  return { reasoning_effort: effort };
}
