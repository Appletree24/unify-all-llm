import { openJsonl, probeVersion, runJsonl } from '../core/proc.js';
import type { InteractionOption, ProviderAdapter, ProviderEvent, RunRequest, Usage } from '../core/types.js';
import type { BinaryTarget } from './codex.js';

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

function mapAcpOptionTone(kind: unknown): InteractionOption['tone'] {
  if (kind === 'allow_once') return 'primary';
  if (kind === 'allow_always') return 'secondary';
  if (kind === 'reject_once' || kind === 'reject_always') return 'danger';
  return 'secondary';
}

function formatAcpToolDetail(toolCall: Record<string, any> | undefined): string | undefined {
  if (!toolCall) return undefined;
  const parts: string[] = [];
  if (toolCall.rawInput && typeof toolCall.rawInput === 'object') {
    if (typeof toolCall.rawInput.command === 'string') parts.push(`$ ${toolCall.rawInput.command}`);
    else parts.push(JSON.stringify(toolCall.rawInput, null, 2).slice(0, 1200));
  }
  if (Array.isArray(toolCall.locations) && toolCall.locations.length) {
    parts.push('路径: ' + toolCall.locations.map((l: any) => l?.path ?? String(l)).filter(Boolean).join(', '));
  }
  return parts.join('\n') || undefined;
}

/**
 * Interactive Gemini CLI session via ACP (`gemini --experimental-acp`).
 * Falls back cleanly to `--output-format stream-json` if the installed CLI
 * does not support ACP (fails before `initialize` completes).
 */
async function* runGeminiInteractive(req: RunRequest, bin: BinaryTarget): AsyncGenerator<ProviderEvent> {
  const interact = req.interact!;
  const args = ['--experimental-acp'];
  if (req.mode === 'exec') args.push('--approval-mode', 'auto_edit');
  else args.push('--approval-mode', 'plan');
  if (req.model) args.push('-m', req.model);

  const session = openJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
    cwd: req.cwd,
    signal: req.signal,
    nativeExecutable: bin.nativeExecutable,
  });

  let initialized = false;
  let acc = '';
  let usage: Usage | undefined;

  session.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'unify_llm', version: '0.1.0' },
      clientCapabilities: {},
    },
  });

  try {
    for await (const ev of session.events) {
      if (ev.id === 1 && !ev.method) {
        if (ev.error) throw new Error(String(ev.error.message ?? 'Gemini ACP 初始化失败'));
        initialized = true;
        session.send({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: req.cwd, mcpServers: [] },
        });
        continue;
      }
      if (ev.id === 2 && !ev.method) {
        if (ev.error) throw new Error(String(ev.error.message ?? 'Gemini ACP 创建会话失败'));
        const sessionId = ev.result?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('Gemini ACP 未返回 sessionId');
        session.send({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: {
            sessionId,
            prompt: [{ type: 'text', text: req.prompt }],
          },
        });
        continue;
      }
      if (ev.id === 3 && !ev.method) {
        if (ev.error) throw new Error(String(ev.error.message ?? 'Gemini ACP 执行失败'));
        const stats = ev.result?.usage ?? ev.result?.stats;
        if (stats && typeof stats === 'object') {
          usage = {
            inputTokens: stats.inputTokens ?? stats.input_tokens,
            outputTokens: stats.outputTokens ?? stats.output_tokens,
            ...(stats.cachedInputTokens !== undefined || stats.cached !== undefined
              ? { cachedInputTokens: stats.cachedInputTokens ?? stats.cached }
              : {}),
          };
        }
        yield { type: 'done', text: acc, usage };
        break;
      }

      // Server -> Client interactive permission request
      if (ev.id !== undefined && ev.method === 'session/request_permission') {
        const params = ev.params ?? {};
        const toolCall = params.toolCall;
        const rawOptions = Array.isArray(params.options) ? params.options : [];
        const options: InteractionOption[] = rawOptions.length
          ? rawOptions.map((o: any) => ({
              id: String(o.optionId ?? o.id ?? ''),
              label: String(o.name ?? o.label ?? o.optionId ?? ''),
              tone: mapAcpOptionTone(o.kind),
            }))
          : [
              { id: 'allow_once', label: '允许一次', tone: 'primary' },
              { id: 'reject_once', label: '拒绝', tone: 'danger' },
            ];
        const res = await interact({
          kind: 'approval',
          title: String(toolCall?.title || 'Gemini 请求权限确认'),
          tool: typeof toolCall?.kind === 'string' ? toolCall.kind : 'tool',
          detail: formatAcpToolDetail(toolCall),
          options,
        });
        session.send({
          jsonrpc: '2.0',
          id: ev.id,
          result: {
            outcome: res.cancelled || !res.optionId
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: res.optionId },
          },
        });
        continue;
      }

      if (ev.id !== undefined && typeof ev.method === 'string') {
        session.send({
          jsonrpc: '2.0',
          id: ev.id,
          error: { code: -32601, message: `Unsupported ACP client method: ${ev.method}` },
        });
        continue;
      }

      if (ev.method === 'session/update') {
        const update = ev.params?.update ?? {};
        const kind = update.sessionUpdate;
        if (kind === 'agent_message_chunk') {
          const text = typeof update.content === 'string'
            ? update.content
            : update.content?.type === 'text' && typeof update.content.text === 'string'
              ? update.content.text
              : '';
          if (text) {
            acc += text;
            yield { type: 'delta', text };
          }
        } else if (kind === 'agent_thought_chunk') {
          const text = typeof update.content === 'string'
            ? update.content
            : typeof update.content?.text === 'string'
              ? update.content.text
              : '';
          if (text) yield { type: 'reasoning', text };
        } else if (kind === 'tool_call') {
          yield { type: 'tool', name: String(update.title ?? update.kind ?? 'tool') };
        }
      }
    }
  } catch (err) {
    if (!initialized && !req.signal?.aborted) {
      await session.close();
      yield* runGeminiStreamJson(req, bin);
      return;
    }
    throw err;
  } finally {
    await session.close();
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
        yield* runGeminiInteractive(req, bin);
        return;
      }
      yield* runGeminiStreamJson(req, bin);
    },
  };
}

export const gemini: ProviderAdapter = createGeminiAdapter();
