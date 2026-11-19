import { probeVersion, runJsonl } from '../core/proc.js';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';

// Verified against Claude Code 2.1.x `-p --output-format stream-json`.
export const claude: ProviderAdapter = {
  id: 'claude',
  label: 'Claude',
  capabilities: { askPolicy: 'read-tools', exec: true },

  async detect(signal) {
    const version = await probeVersion('claude', signal);
    return { installed: !!version, version };
  },

  async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (req.mode === 'ask') {
      // Read-only: can inspect the repo and search the web, cannot change anything.
      args.push('--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--permission-prompts', 'none', '--no-session-persistence');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }
    if (req.reasoningEffort) args.push('--effort', req.reasoningEffort);
    if (req.model) args.push('--model', req.model);

    let acc = '';
    for await (const ev of runJsonl('claude', args, { cwd: req.cwd, stdin: req.prompt, signal: req.signal })) {
      if (ev.parent_tool_use_id) continue; // subagent chatter

      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'message_start' && acc) {
          acc += '\n\n';
          yield { type: 'delta', text: '\n\n' };
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          yield { type: 'tool', name: String(e.content_block.name ?? 'tool') };
        } else if (e?.type === 'content_block_delta') {
          const d = e.delta;
          if (d?.type === 'text_delta' && d.text) {
            acc += d.text;
            yield { type: 'delta', text: d.text };
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            yield { type: 'reasoning', text: d.thinking };
          }
        }
      } else if (ev.type === 'result') {
        if (ev.is_error) {
          yield { type: 'error', message: String(ev.result ?? ev.subtype ?? 'unknown error') };
        } else {
          yield {
            type: 'done',
            // In ask mode the final message is the answer; in exec mode keep the whole narration.
            text: req.mode === 'ask' ? String(ev.result || acc) : acc || String(ev.result ?? ''),
            usage: { inputTokens: ev.usage?.input_tokens, outputTokens: ev.usage?.output_tokens },
          };
        }
      }
    }
  },
};
