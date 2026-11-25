import { openJsonl } from '../core/proc.js';
import { TOOL_STATUSES, type InteractionOption, type InteractionResponse, type ProviderEvent, type RunRequest, type ToolUse, type Usage } from '../core/types.js';
import type { BinaryTarget } from './codex.js';

interface AcpOptions {
  args: string[];
  label: string;
  modeId?: string;
  modelId?: string;
  emptyAnswerPrompt?: string;
  fallback: () => AsyncGenerator<ProviderEvent>;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

export function formatToolDetail(input: unknown, locations?: unknown): string | undefined {
  const params = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = text(input) ?? text(params.CommandLine) ?? text(params.command);
  const paths = Array.isArray(locations)
    ? locations.map((location) => text(location?.path)).filter((path): path is string => !!path)
    : [];
  const target = text(params.TargetDirectory) ?? text(params.DirectoryPath) ?? text(params.TargetFile)
    ?? text(params.FilePath) ?? text(params.AbsolutePath) ?? text(params.Path) ?? text(params.path);
  if (target && !paths.length) paths.push(target);
  const cwd = text(params.Cwd) ?? text(params.cwd);
  const query = text(params.Query) ?? text(params.Pattern) ?? text(params.query);
  return [command, cwd && '工作目录 ' + cwd, ...new Set(paths), query].filter(Boolean).join('\n') || undefined;
}

function optionsFor(raw: unknown): InteractionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option) => {
    const id = text(option?.optionId);
    if (!id) return [];
    const kind = option.kind;
    const tone = kind === 'allow_once' ? 'primary' : kind === 'reject_once' || kind === 'reject_always' ? 'danger' : 'secondary';
    return [{ id, label: text(option.name) ?? id, tone }];
  });
}

function messageChunk(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') return content.text;
  return '';
}

export async function* runAcp(req: RunRequest, bin: BinaryTarget, options: AcpOptions): AsyncGenerator<ProviderEvent> {
  const interact: NonNullable<RunRequest['interact']> = req.interact ?? (async () => ({ cancelled: true }));
  const session = openJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...options.args], {
    cwd: req.cwd, signal: req.signal, nativeExecutable: bin.nativeExecutable,
  });
  const send = (id: number, method: string, params: object) => session.send({ jsonrpc: '2.0', id, method, params });
  let initialized = false;
  let sessionId = '';
  let resumeId: string | undefined;
  let supportsResume = false;
  let canFork = false;
  let prompting = false;
  let promptId = 5;
  let answer = '';
  const tools = new Map<string, Pick<ToolUse, 'name' | 'detail'>>();
  const rejected = new Set<string>();

  const prompt = (content: string) => {
    prompting = true;
    send(promptId, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: content }] });
  };
  const currentPrompt = () => {
    if (req.conversation?.resumeId && !resumeId) req.onPublicReplay?.();
    return resumeId ? req.conversation!.turnPrompt : req.prompt;
  };
  const setModelOrPrompt = () => {
    if (options.modelId) send(4, 'session/set_model', { sessionId, modelId: options.modelId });
    else prompt(currentPrompt());
  };
  const toolEvent = (update: Record<string, any>): Extract<ProviderEvent, { type: 'tool' }> => {
    const id = text(update.toolCallId);
    const previous = id ? tools.get(id) : undefined;
    const command = update.kind === 'execute';
    const name = text(update.name) ?? previous?.name ?? (command ? 'run_command' : text(update.title) ?? text(update.kind) ?? 'tool');
    const detail = formatToolDetail(update.rawInput ?? update.args, update.locations) ?? previous?.detail ?? (command ? text(update.title) : undefined);
    if (id) tools.set(id, { name, detail });
    const status: ToolUse['status'] = id && rejected.has(id) ? 'denied' : TOOL_STATUSES.find((state) => state === update.status);
    return {
      type: 'tool', id, name, status, detail,
      error: status === 'failed' || status === 'denied' ? text(update.rawOutput?.error?.message) ?? text(update.rawOutput?.error) : undefined,
    };
  };

  try {
    send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'unify_llm', version: '0.1.0' }, clientCapabilities: {} });
    for await (const ev of session.events) {
      if (!ev.method) {
        if (ev.id === 2 && ev.error && resumeId) {
          resumeId = undefined;
          send(2, 'session/new', { cwd: req.cwd, mcpServers: [] });
          continue;
        }
        if (ev.error) throw new Error(text(ev.error.message) ?? options.label + ' ACP 请求失败');
        if (ev.id === 1) {
          if (ev.result?.protocolVersion !== 1) throw new Error(options.label + ' ACP 协议版本不受支持');
          initialized = true;
          const caps = ev.result?.agentCapabilities;
          canFork = !!caps?.sessionCapabilities?.fork;
          const method = req.conversation?.fork
            ? (canFork ? 'session/fork' : undefined)
            : caps?.sessionCapabilities?.resume ? 'session/resume' : caps?.loadSession ? 'session/load' : undefined;
          supportsResume = !!(caps?.sessionCapabilities?.resume || caps?.loadSession);
          resumeId = method ? req.conversation?.resumeId : undefined;
          if (method && resumeId) send(2, method, { cwd: req.cwd, mcpServers: [], sessionId: resumeId });
          else send(2, 'session/new', { cwd: req.cwd, mcpServers: [] });
        } else if (ev.id === 2) {
          sessionId = ev.result?.sessionId ?? (req.conversation?.fork ? undefined : resumeId);
          if (!text(sessionId)) throw new Error(options.label + ' ACP 未返回会话 ID');
          if (options.modeId) send(3, 'session/set_mode', { sessionId, modeId: options.modeId });
          else setModelOrPrompt();
        } else if (ev.id === 3) {
          setModelOrPrompt();
        } else if (ev.id === 4) {
          prompt(currentPrompt());
        } else if (ev.id === promptId) {
          if (ev.result?.stopReason === 'cancelled') throw new Error(options.label + ' 已取消本轮请求');
          if (!answer.trim() && options.emptyAnswerPrompt && promptId === 5) {
            answer = '';
            promptId++;
            prompt(options.emptyAnswerPrompt);
            continue;
          }
          const stats = ev.result?.usage ?? ev.result?.stats;
          const usage: Usage | undefined = stats && {
            inputTokens: stats.inputTokens ?? stats.input_tokens,
            outputTokens: stats.outputTokens ?? stats.output_tokens,
            cachedInputTokens: stats.cachedReadTokens ?? stats.cachedInputTokens ?? stats.cached,
            cacheWriteTokens: stats.cachedWriteTokens,
          };
          yield { type: 'done', text: answer, usage, nativeSession: (supportsResume || canFork) && req.conversation ? { id: sessionId, forkable: canFork } : undefined };
          break;
        }
        continue;
      }

      if (ev.id !== undefined && ev.method === 'session/request_permission') {
        const call = ev.params?.toolCall ?? {};
        const choices = optionsFor(ev.params?.options);
        const tool = toolEvent(call);
        if (tool.id) yield { ...tool, status: 'pending' };
        const response: InteractionResponse = choices.length ? await interact({
          kind: 'approval',
          title: options.label + ' 请求权限确认',
          tool: tool.name,
          detail: tool.detail ?? (call.rawInput && typeof call.rawInput === 'object' ? JSON.stringify(call.rawInput, null, 2).slice(0, 1200) : text(call.title)),
          options: choices,
        }) : { cancelled: true };
        const selected = !response.cancelled ? choices.find((choice) => choice.id === response.optionId) : undefined;
        if (tool.id && (!selected || selected.tone === 'danger')) {
          rejected.add(tool.id);
          yield { ...tool, status: 'denied', error: selected ? '用户拒绝了此操作' : '未批准此操作' };
        }
        session.send({ jsonrpc: '2.0', id: ev.id, result: {
          outcome: selected ? { outcome: 'selected', optionId: selected.id } : { outcome: 'cancelled' },
        } });
      } else if (ev.id !== undefined) {
        session.send({ jsonrpc: '2.0', id: ev.id, error: { code: -32601, message: 'Unsupported ACP client method: ' + ev.method } });
      } else if (ev.method === 'session/update' && prompting && (!ev.params?.sessionId || ev.params.sessionId === sessionId)) {
        const update = ev.params?.update ?? {};
        if (update.sessionUpdate === 'agent_message_chunk') {
          const chunk = messageChunk(update.content);
          if (chunk) { answer += chunk; yield { type: 'delta', text: chunk }; }
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          const chunk = messageChunk(update.content);
          if (chunk) yield { type: 'reasoning', text: chunk };
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          yield toolEvent(update);
        }
      }
    }
    if (!initialized) throw new Error(options.label + ' ACP 未初始化');
  } catch (err) {
    if (!initialized && !req.signal?.aborted) {
      await session.close();
      yield* options.fallback();
      return;
    }
    throw err;
  } finally {
    await session.close();
  }
}
