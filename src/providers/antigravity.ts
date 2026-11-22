import { probeVersion, runJsonl } from '../core/proc.js';
import type { ProviderAdapter } from '../core/types.js';
import { readAntigravityQuota } from '../quota/antigravity.js';

/** Google AI subscriptions authenticate through the independently installed agy CLI. */
export const geminiPro: ProviderAdapter = {
  id: 'gemini-pro',
  label: 'Gemini Pro',
  defaultModel: 'gemini-4-neon-medium',
  autoSelect: false,
  capabilities: { askPolicy: 'provider-plan', exec: false },
  readQuota: readAntigravityQuota,
  async detect(signal) {
    const version = await probeVersion('agy', signal);
    return { installed: !!version, version };
  },
  async *run(req) {
    const args = ['--mode', 'plan', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (req.model) args.push('--model', req.model);
    const stdin = JSON.stringify({ event: 'user', message: { content: req.prompt } }) + '\n';
    for await (const ev of runJsonl('agy', args, { cwd: req.cwd, signal: req.signal, stdin })) {
      if (ev.event === 'step_update') {
        const step = ev.step_update;
        if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          yield { type: 'delta', text: step.text_delta };
        } else if (step?.step_type === 'tool' && step.tool_name && step.state === 'ACTIVE') {
          yield { type: 'tool', name: String(step.tool_name) };
        }
      } else if (ev.event === 'result') {
        const result = ev.result;
        if (result?.status !== 'SUCCESS' || typeof result.response !== 'string') {
          throw new Error(String(result?.error || 'Antigravity 未返回成功回答'));
        }
        yield { type: 'done', text: result.response, usage: {
          inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens,
        } };
      }
    }
  },
};
