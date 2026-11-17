import { probeVersion, runJsonl } from '../core/proc.js';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';

// UNVERIFIED: written from memory of Gemini CLI's headless `--output-format stream-json`
// because the CLI was not installed when this was written. Check the flags and event
// shapes against `gemini --help` and a real run before trusting this adapter.
export const gemini: ProviderAdapter = {
  id: 'gemini',
  label: 'Gemini',

  async detect() {
    const version = await probeVersion('gemini');
    return { installed: !!version, version };
  },

  async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
    const args = ['--output-format', 'stream-json'];
    if (req.mode === 'exec') args.push('--approval-mode', 'auto_edit');
    if (req.model) args.push('-m', req.model);

    let acc = '';
    for await (const ev of runJsonl('gemini', args, { cwd: req.cwd, stdin: req.prompt, signal: req.signal })) {
      if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
        acc += ev.content;
        yield { type: 'delta', text: ev.content };
      } else if (ev.type === 'thought' && typeof ev.content === 'string') {
        yield { type: 'reasoning', text: ev.content };
      } else if (ev.type === 'tool_use') {
        yield { type: 'tool', name: String(ev.tool_name ?? ev.name ?? 'tool') };
      } else if (ev.type === 'error') {
        yield { type: 'error', message: String(ev.message ?? 'unknown error') };
        return;
      } else if (ev.type === 'result') {
        if (ev.status && ev.status !== 'success') {
          yield { type: 'error', message: String(ev.error?.message ?? ev.status) };
        } else {
          yield {
            type: 'done',
            text: acc,
            usage: { inputTokens: ev.stats?.input_tokens, outputTokens: ev.stats?.output_tokens },
          };
        }
        return;
      }
    }
  },
};
