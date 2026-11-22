import { openJsonl, probeVersion, runJsonl } from '../core/proc.js';
import type { InteractionQuestion, ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';
import type { BinaryTarget } from './codex.js';

const DEFAULT_CLAUDE_BIN: BinaryTarget = { cmd: 'claude' };

function formatToolInputDetail(input: Record<string, any>): string | undefined {
  if (typeof input.command === 'string' && input.command.trim()) {
    return `$ ${input.command}`;
  }
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    return `文件: ${input.file_path}`;
  }
  if (typeof input.path === 'string' && input.path.trim()) {
    return `路径: ${input.path}`;
  }
  const keys = Object.keys(input);
  if (!keys.length) return undefined;
  return JSON.stringify(input, null, 2).slice(0, 1200);
}

function mapClaudeResult(ev: Record<string, any>, req: RunRequest, acc: string): ProviderEvent {
  if (ev.is_error) {
    return { type: 'error', message: String(ev.result ?? ev.subtype ?? 'unknown error') };
  }
  return {
    type: 'done',
    // In ask mode the final message is the answer; in exec mode keep the whole narration.
    text: req.mode === 'ask' ? String(ev.result || acc) : acc || String(ev.result ?? ''),
    usage: {
      inputTokens: ev.usage?.input_tokens,
      outputTokens: ev.usage?.output_tokens,
      ...(ev.usage?.cache_read_input_tokens !== undefined ? { cachedInputTokens: ev.usage.cache_read_input_tokens } : {}),
      ...(ev.usage?.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: ev.usage.cache_creation_input_tokens } : {}),
    },
  };
}

async function* runClaudeInteractive(req: RunRequest, bin: BinaryTarget): AsyncGenerator<ProviderEvent> {
  const interact = req.interact!;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompts', 'host',
  ];
  if (req.mode === 'ask') {
    args.push('--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--no-session-persistence');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  if (req.reasoningEffort) args.push('--effort', req.reasoningEffort);
  if (req.model) args.push('--model', req.model);

  const session = openJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
    cwd: req.cwd,
    signal: req.signal,
    nativeExecutable: bin.nativeExecutable,
  });

  session.send({ type: 'user', message: { role: 'user', content: req.prompt } });

  let acc = '';
  try {
    for await (const ev of session.events) {
      if (ev.type === 'control_request') {
        const requestId = ev.request_id;
        const inner = (ev.request && typeof ev.request === 'object') ? ev.request : {};
        if (inner.subtype === 'can_use_tool') {
          const toolName = String(inner.tool_name ?? 'tool');
          const input = (inner.input && typeof inner.input === 'object') ? inner.input : {};

          if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
            const questions: InteractionQuestion[] = input.questions.map((q: any, idx: number) => ({
              id: String(q.question ?? q.id ?? `q_${idx}`),
              header: typeof q.header === 'string' ? q.header : undefined,
              question: String(q.question ?? ''),
              options: Array.isArray(q.options)
                ? q.options.map((o: any) => ({
                    label: String(o.label ?? ''),
                    description: typeof o.description === 'string' ? o.description : undefined,
                  }))
                : undefined,
              allowOther: true,
            }));
            const res = await interact({
              kind: 'question',
              title: 'Claude 请求补充信息',
              tool: toolName,
              questions,
            });
            if (res.cancelled) {
              session.send({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: requestId,
                  response: { behavior: 'deny', message: '用户取消了回答' },
                },
              });
            } else {
              const answers: Record<string, string> = {};
              for (const q of questions) {
                const picked = res.answers?.[q.id] ?? [];
                if (picked.length) answers[q.id] = picked.join(', ');
              }
              session.send({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: requestId,
                  response: { behavior: 'allow', updatedInput: { ...input, answers } },
                },
              });
            }
          } else {
            const res = await interact({
              kind: 'approval',
              title: `Claude 请求调用 ${toolName}`,
              tool: toolName,
              detail: formatToolInputDetail(input),
              options: [
                { id: 'allow', label: '允许', tone: 'primary' },
                { id: 'deny', label: '拒绝', tone: 'danger' },
              ],
            });
            const allowed = !res.cancelled && res.optionId === 'allow';
            session.send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: requestId,
                response: allowed
                  ? { behavior: 'allow', updatedInput: input }
                  : { behavior: 'deny', message: '用户拒绝了此操作' },
              },
            });
          }
        } else {
          session.send({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: requestId,
              error: `Unsupported control_request subtype: ${String(inner.subtype ?? 'unknown')}`,
            },
          });
        }
        continue;
      }

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
        yield mapClaudeResult(ev, req, acc);
        break;
      }
    }
  } finally {
    await session.close();
  }
}

// Verified against Claude Code 2.1.x `-p --output-format stream-json` and bidirectional `--input-format stream-json --permission-prompts host`.
export function createClaudeAdapter(bin: BinaryTarget = DEFAULT_CLAUDE_BIN): ProviderAdapter {
  return {
    id: 'claude',
    label: 'Claude',
    capabilities: { askPolicy: 'read-tools', exec: true },

    async detect(signal) {
      const version = await probeVersion(bin.cmd, signal, { nativeExecutable: bin.nativeExecutable });
      return { installed: !!version, version };
    },

    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      if (req.interact) {
        yield* runClaudeInteractive(req, bin);
        return;
      }

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
      for await (const ev of runJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
        cwd: req.cwd,
        stdin: req.prompt,
        signal: req.signal,
        nativeExecutable: bin.nativeExecutable,
      })) {
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
          yield mapClaudeResult(ev, req, acc);
        }
      }
    },
  };
}

export const claude: ProviderAdapter = createClaudeAdapter();
