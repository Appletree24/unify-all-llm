import { probeVersion, runJsonl } from '../core/proc.js';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';
import type { BinaryTarget } from './codex.js';
import { runAcp } from './acp.js';

const DEFAULT_GEMINI_BIN: BinaryTarget = { cmd: 'gemini' };

async function* runGeminiStreamJson(req: RunRequest, bin: BinaryTarget): AsyncGenerator<ProviderEvent> {
  const args = ['--output-format', 'stream-json'];
  if (req.mode === 'exec') args.push('--approval-mode', 'auto_edit');
  else args.push('--approval-mode', 'plan');
  if (req.model) args.push('-m', req.model);

  let acc = '';
  for await (const ev of runJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
    cwd: req.cwd,
    stdin: req.prompt,
    signal: req.signal,
    nativeExecutable: bin.nativeExecutable,
  })) {
    if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      acc += ev.content;
      yield { type: 'delta', text: ev.content };
    } else if (ev.type === 'thought' && typeof ev.content === 'string') {
      yield { type: 'reasoning', text: ev.content };
    } else if (ev.type === 'tool_use') {
      yield { type: 'tool', name: String(ev.tool_name ?? ev.name ?? 'tool') };
    } else if (ev.type === 'error' && ev.severity !== 'warning') {
      yield { type: 'error', message: String(ev.message ?? 'unknown error') };
    } else if (ev.type === 'result') {
      if (ev.status !== 'success') {
        yield { type: 'error', message: String(ev.error?.message ?? ev.status) };
      } else {
        yield {
          type: 'done',
          text: acc,
          usage: {
            inputTokens: ev.stats?.input_tokens,
            outputTokens: ev.stats?.output_tokens,
            ...(ev.stats?.cached !== undefined ? { cachedInputTokens: ev.stats.cached } : {}),
          },
        };
      }
    }
  }
}

// Protocol and policy: geminicli.com/docs/cli/{headless,plan-mode}/ and ACP (`--experimental-acp`).
// Plan mode is provider policy, not an OS sandbox; it may write planning files.
export function createGeminiAdapter(bin: BinaryTarget = DEFAULT_GEMINI_BIN): ProviderAdapter {
  return {
    id: 'gemini',
    label: 'Gemini',
    capabilities: { askPolicy: 'provider-plan', exec: true },

    async detect(signal) {
      const version = await probeVersion(bin.cmd, signal, { nativeExecutable: bin.nativeExecutable });
      return { installed: !!version, version };
    },

    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      if (req.interact) {
        const args = ['--experimental-acp', '--approval-mode', req.mode === 'exec' ? 'auto_edit' : 'plan'];
        if (req.model) args.push('-m', req.model);
        yield* runAcp(req, bin, { args, label: 'Gemini', fallback: () => runGeminiStreamJson(req, bin) });
        return;
      }
      yield* runGeminiStreamJson(req, bin);
    },
  };
}

export const gemini: ProviderAdapter = createGeminiAdapter();
