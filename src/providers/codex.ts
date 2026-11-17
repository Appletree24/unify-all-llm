import { probeVersion, runJsonl } from '../core/proc.js';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';

// Verified against codex-cli 0.167 `exec --json`. Codex emits whole items, not token deltas.
export const codex: ProviderAdapter = {
  id: 'codex',
  label: 'Codex',

  async detect() {
    const version = await probeVersion('codex');
    return { installed: !!version, version };
  },

  async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (req.mode === 'ask') args.push('--sandbox', 'read-only', '--ephemeral');
    else args.push('--sandbox', 'workspace-write');
    if (req.model) args.push('-m', req.model);
    args.push('-'); // prompt from stdin

    let acc = '';
    let last = '';
    for await (const ev of runJsonl('codex', args, { cwd: req.cwd, stdin: req.prompt, signal: req.signal })) {
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
        return;
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        yield { type: 'error', message: String(ev.error?.message ?? ev.message ?? 'unknown error') };
        return;
      }
    }
  },
};
