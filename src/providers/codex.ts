import { probeVersion, runJsonl } from '../core/proc.js';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';

async function* codexEvents(args: string[], req: RunRequest) {
  let diagnostic: string | undefined;
  try {
    for await (const ev of runJsonl('codex', args, { cwd: req.cwd, stdin: req.prompt, signal: req.signal })) {
      // Codex also emits error events while reconnecting. The turn can still succeed.
      if (ev.type === 'error') {
        diagnostic = String(ev.error?.message ?? ev.message ?? 'Codex 请求失败');
        continue;
      }
      if (ev.type === 'turn.failed') {
        const message = ev.error?.message ?? ev.message ?? diagnostic ?? 'Codex 请求失败';
        diagnostic = undefined;
        throw new Error(String(message));
      }
      if (ev.type === 'turn.completed') diagnostic = undefined;
      yield ev;
    }
  } catch (err) {
    if (!diagnostic) throw err;
    throw new Error(`${diagnostic}\n${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (diagnostic) throw new Error(diagnostic);
}

// Verified against codex-cli 0.167 `exec --json`. Codex emits whole items, not token deltas.
export const codex: ProviderAdapter = {
  id: 'codex',
  label: 'Codex',
  capabilities: { askPolicy: 'sandbox-read-only', exec: true },

  async detect(signal) {
    const version = await probeVersion('codex', signal);
    return { installed: !!version, version };
  },

  async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (req.mode === 'ask') args.push('--sandbox', 'read-only', '--ephemeral');
    else args.push('--sandbox', 'workspace-write');
    // Codex treats bare effort names as strings; they can pass through Windows cmd shims unchanged.
    if (req.reasoningEffort) args.push('-c', `model_reasoning_effort=${req.reasoningEffort}`);
    if (req.model) args.push('-m', req.model);
    args.push('-'); // prompt from stdin

    let acc = '';
    let last = '';
    for await (const ev of codexEvents(args, req)) {
      const item = ev.item;
      if (ev.type === 'item.started' && item?.type === 'command_execution') {
        yield { type: 'tool', name: 'shell', detail: String(item.command ?? '') };
      } else if (ev.type === 'item.completed' && item) {
        if (item.type === 'agent_message' && item.text) {
          const chunk = (acc ? '\n\n' : '') + item.text;
          acc += chunk;
          last = item.text;
          yield { type: 'delta', text: chunk };
        } else if (item.type === 'reasoning' && item.text) {
          yield { type: 'reasoning', text: item.text + '\n' };
        } else if (item.type === 'file_change') {
          yield { type: 'tool', name: 'edit', detail: (item.changes ?? []).map((c: any) => c.path).join(', ') };
        }
      } else if (ev.type === 'turn.completed') {
        yield {
          type: 'done',
          text: req.mode === 'ask' ? last || acc : acc,
          usage: { inputTokens: ev.usage?.input_tokens, outputTokens: ev.usage?.output_tokens },
        };
      }
    }
  },
};
