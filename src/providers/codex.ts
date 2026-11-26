import { openHarness } from '../core/harness-pool.js';
import { probeVersion, runJsonl } from '../core/proc.js';
import type { InteractionOption, InteractionQuestion, ProviderAdapter, ProviderEvent, RunRequest, Usage } from '../core/types.js';

export interface BinaryTarget {
  cmd: string;
  prefixArgs?: string[];
  nativeExecutable?: boolean;
}

const DEFAULT_CODEX_BIN: BinaryTarget = { cmd: 'codex' };

async function* codexExecEvents(args: string[], req: RunRequest, bin: BinaryTarget) {
  let diagnostic: string | undefined;
  try {
    for await (const ev of runJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
      cwd: req.cwd,
      stdin: req.prompt,
      signal: req.signal,
      nativeExecutable: bin.nativeExecutable,
    })) {
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

const APPROVAL_OPTIONS: InteractionOption[] = [
  { id: 'accept', label: '允许', tone: 'primary' },
  { id: 'acceptForSession', label: '本会话始终允许', tone: 'secondary' },
  { id: 'decline', label: '拒绝', tone: 'danger' },
  { id: 'cancel', label: '中止本轮', tone: 'danger' },
];

function normalizeDecision(optionId: string | undefined, cancelled: boolean | undefined): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  if (cancelled) return 'cancel';
  if (optionId === 'accept' || optionId === 'acceptForSession' || optionId === 'decline' || optionId === 'cancel') {
    return optionId;
  }
  return 'decline';
}

function formatCommandApprovalDetail(params: Record<string, any>): string {
  const lines: string[] = [];
  const command = Array.isArray(params.command) ? params.command.join(' ') : typeof params.command === 'string' ? params.command : '';
  if (command) lines.push(`$ ${command}`);
  if (params.cwd) lines.push(`目录: ${params.cwd}`);
  if (params.networkApprovalContext?.host) {
    const proto = params.networkApprovalContext.protocol ?? 'https';
    lines.push(`网络访问: ${proto}://${params.networkApprovalContext.host}`);
  }
  if (params.reason) lines.push(`原因: ${params.reason}`);
  return lines.join('\n');
}

function formatFileChangeApprovalDetail(params: Record<string, any>, trackedPaths?: string[]): string {
  const lines: string[] = [];
  if (params.fileChanges && typeof params.fileChanges === 'object') {
    const entries = Object.entries(params.fileChanges as Record<string, any>);
    if (entries.length) {
      lines.push('变更文件:');
      for (const [filePath, change] of entries.slice(0, 20)) {
        const kind = change?.type ? `[${change.type}] ` : '';
        lines.push(`- ${kind}${filePath}`);
      }
      if (entries.length > 20) lines.push(`… 以及另外 ${entries.length - 20} 个文件`);
    }
  } else if (trackedPaths?.length) {
    lines.push('变更文件:');
    for (const p of trackedPaths.slice(0, 20)) lines.push(`- ${p}`);
  }
  if (params.grantRoot) lines.push(`授权根目录: ${params.grantRoot}`);
  if (params.reason) lines.push(`原因: ${params.reason}`);
  return lines.join('\n');
}

function parseAppServerUsage(total: Record<string, any> | undefined): Usage | undefined {
  if (!total || typeof total !== 'object') return undefined;
  return {
    ...(typeof total.inputTokens === 'number' ? { inputTokens: total.inputTokens } : {}),
    ...(typeof total.outputTokens === 'number' ? { outputTokens: total.outputTokens } : {}),
    ...(typeof total.cachedInputTokens === 'number' ? { cachedInputTokens: total.cachedInputTokens } : {}),
    ...(typeof total.cacheWriteInputTokens === 'number' && total.cacheWriteInputTokens > 0
      ? { cacheWriteTokens: total.cacheWriteInputTokens }
      : {}),
  };
}

function usageSince(total: Usage, previous: Usage): Usage {
  const usage: Usage = {};
  for (const key of Object.keys(total) as (keyof Usage)[]) {
    usage[key] = Math.max(0, total[key]! - (previous[key] ?? 0));
  }
  return usage;
}

class CodexStartupError extends Error {}

/**
 * Interactive Codex execution over `codex app-server` JSON-RPC 2.0.
 * Streams deltas, reasoning, tools, cached token usage, and bridges all
 * mid-turn approval and user-input requests through `req.interact`.
 */
async function* runCodexAppServer(req: RunRequest, bin: BinaryTarget): AsyncGenerator<ProviderEvent> {
  const interact: NonNullable<RunRequest['interact']> = req.interact ?? (async () => ({ cancelled: true }));
  const session = openHarness(req, bin, ['app-server'], 'codex', 'rpc');

  let acc = '';
  let lastMessage = '';
  let currentMessageId: string | undefined;
  let currentMessageText = '';
  const deltaSeenIds = new Set<string>();
  const fileChangesByItemId = new Map<string, string[]>();
  let usage: Usage | undefined;
  let diagnostic: string | undefined;
  let completed = false;
  let resumeId = req.conversation?.resumeId;
  let fork = req.conversation?.fork;
  let activeThread: string | undefined;
  let activeTurn: string | undefined;
  let previousUsage: Usage | undefined;
  const openThread = () => session.send({
    id: 2, method: resumeId ? (fork ? 'thread/fork' : 'thread/resume') : 'thread/start',
    params: {
      cwd: req.cwd, sandbox: req.mode === 'ask' ? 'read-only' : 'workspace-write',
      approvalPolicy: req.interact ? 'on-request' : 'never',
      ...(resumeId ? { threadId: resumeId } : { ephemeral: req.mode === 'ask' && !req.conversation }),
      ...(resumeId && fork ? { lastTurnId: req.conversation?.turnId } : {}),
      ...(req.model ? { model: req.model } : {}),
    },
  });

  const startTurn = (threadId: string) => session.send({
    id: 3, method: 'turn/start',
    params: { threadId, input: [{ type: 'text', text: resumeId ? req.conversation!.turnPrompt : req.prompt }],
      ...(req.reasoningEffort ? { effort: req.reasoningEffort } : {}) },
  });
  try {
    if (session.reused) {
      const previousThread = session.worker.initialized?.threadId;
      if (previousThread && previousThread !== resumeId) session.send({ id: 4, method: 'thread/unsubscribe', params: { threadId: previousThread } });
      openThread();
    }
    else session.send({ id: 1, method: 'initialize',
      params: { clientInfo: { name: 'unify_llm', title: 'Unify LLM', version: '0.1.0' } } });
    for await (const ev of session.events) {
      // 1. Responses to our client->server JSON-RPC requests
      if (ev.id === 1 && !ev.method) {
        if (ev.error) throw new Error(String(ev.error.message ?? 'Codex app-server 初始化失败'));
        session.send({ method: 'initialized' });
        openThread();
        continue;
      }
      if (ev.id === 2 && !ev.method) {
        if (ev.error && resumeId) {
          resumeId = undefined;
          openThread();
          continue;
        }
        if (ev.error) throw new Error(String(ev.error.message ?? 'Codex 创建会话失败'));
        const anchor = req.conversation?.turnId;
        if (resumeId && anchor && ev.result?.thread?.turns?.at(-1)?.id !== anchor) {
          // Another client advanced the thread, or this server cannot fork at an exact turn.
          if (fork) resumeId = undefined;
          fork = true;
          openThread();
          continue;
        }
        const threadId = ev.result?.thread?.id ?? ev.result?.threadId;
        if (typeof threadId !== 'string' || !threadId) throw new Error('Codex 未返回 threadId');
        activeThread = threadId;
        if (req.conversation?.resumeId && !resumeId) req.onPublicReplay?.();
        startTurn(threadId);
        continue;
      }
      if (ev.id === 3 && !ev.method) {
        if (ev.error) throw new Error(String(ev.error.message ?? 'Codex 启动回合失败'));
        activeTurn = ev.result?.turn?.id ?? activeTurn;
        continue;
      }

      // 2. Server->Client interactive requests (have both id and method)
      if (ev.id !== undefined && typeof ev.method === 'string') {
        const params = (ev.params && typeof ev.params === 'object') ? ev.params : {};
        const origin = params.threadId ?? params.conversationId;
        if (session.reused && (!activeThread || origin !== activeThread || (params.turnId && activeTurn && params.turnId !== activeTurn))) {
          session.send({ id: ev.id, error: { code: -32600, message: 'Request outside the active turn' } });
          continue;
        }
        if (ev.method === 'item/commandExecution/requestApproval' || ev.method === 'execCommandApproval') {
          const response = await interact({
            kind: 'approval',
            title: params.kind === 'writeStdin' ? 'Codex 请求向终端发送输入' : 'Codex 请求执行命令',
            tool: 'shell',
            detail: formatCommandApprovalDetail(params) || undefined,
            options: APPROVAL_OPTIONS,
          });
          session.send({ id: ev.id, result: { decision: normalizeDecision(response.optionId, response.cancelled) } });
          continue;
        }
        if (ev.method === 'item/fileChange/requestApproval' || ev.method === 'applyPatchApproval') {
          const tracked = typeof params.itemId === 'string' ? fileChangesByItemId.get(params.itemId) : undefined;
          const response = await interact({
            kind: 'approval',
            title: 'Codex 请求修改文件',
            tool: 'edit',
            detail: formatFileChangeApprovalDetail(params, tracked) || undefined,
            options: APPROVAL_OPTIONS,
          });
          session.send({ id: ev.id, result: { decision: normalizeDecision(response.optionId, response.cancelled) } });
          continue;
        }
        if (ev.method === 'item/permissions/requestApproval') {
          const detailParts: string[] = [];
          if (params.reason) detailParts.push(String(params.reason));
          if (params.permissions) detailParts.push(JSON.stringify(params.permissions, null, 2));
          const response = await interact({
            kind: 'approval',
            title: 'Codex 请求额外权限',
            tool: 'permissions',
            detail: detailParts.join('\n') || undefined,
            options: [
              { id: 'turn', label: '本轮授权', tone: 'primary' },
              { id: 'session', label: '本会话授权', tone: 'secondary' },
              { id: 'decline', label: '拒绝', tone: 'danger' },
            ],
          });
          const granted = !response.cancelled && (response.optionId === 'turn' || response.optionId === 'session');
          session.send({
            id: ev.id,
            result: {
              permissions: granted ? (params.permissions ?? {}) : {},
              scope: response.optionId === 'session' ? 'session' : 'turn',
            },
          });
          continue;
        }
        if (ev.method === 'item/tool/requestUserInput') {
          const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
          const questions: InteractionQuestion[] = rawQuestions.map((q: any, idx: number) => ({
            id: String(q.id ?? `q_${idx}`),
            header: typeof q.header === 'string' ? q.header : undefined,
            question: String(q.question ?? ''),
            options: Array.isArray(q.options)
              ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined }))
              : undefined,
            allowOther: Boolean(q.isOther),
            secret: Boolean(q.isSecret),
          }));
          const response = await interact({
            kind: 'question',
            title: 'Codex 请求补充信息',
            tool: 'requestUserInput',
            questions,
          });
          const answers: Record<string, { answers: string[] }> = {};
          for (const q of questions) {
            answers[q.id] = { answers: response.cancelled ? [] : (response.answers?.[q.id] ?? []) };
          }
          session.send({ id: ev.id, result: { answers } });
          continue;
        }
        if (ev.method === 'mcpServer/elicitation/request') {
          const serverName = typeof params.serverName === 'string' ? params.serverName : 'MCP';
          const detail = typeof params.message === 'string' ? params.message : undefined;
          const response = await interact({
            kind: 'input',
            title: `MCP 服务请求输入 (${serverName})`,
            tool: serverName,
            detail,
            placeholder: '输入内容提交，或取消拒绝',
          });
          if (response.cancelled) {
            session.send({ id: ev.id, result: { action: 'cancel', content: null } });
          } else if (response.text && response.text.trim()) {
            session.send({ id: ev.id, result: { action: 'accept', content: { value: response.text } } });
          } else {
            session.send({ id: ev.id, result: { action: 'decline', content: null } });
          }
          continue;
        }
        // Fallback: never leave the server hanging on an unrecognized client request.
        session.send({
          id: ev.id,
          error: { code: -32601, message: `Unsupported client request: ${ev.method}` },
        });
        continue;
      }

      // 3. Server->Client streaming notifications
      const method = ev.method;
      const params = ev.params ?? {};
      if (!activeThread || (params.threadId && params.threadId !== activeThread)) continue;
      if (method === 'turn/started' && !activeTurn) activeTurn = params.turn?.id;
      const eventTurn = params.turnId ?? params.turn?.id;
      if (eventTurn && activeTurn && eventTurn !== activeTurn) continue;
      if (session.reused && !activeTurn) continue;
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && params.delta) {
        const itemId = typeof params.itemId === 'string' ? params.itemId : '__default__';
        let chunk = params.delta;
        if (currentMessageId && currentMessageId !== itemId && acc) {
          chunk = '\n\n' + chunk;
          currentMessageText = '';
        }
        currentMessageId = itemId;
        deltaSeenIds.add(itemId);
        currentMessageText += params.delta;
        lastMessage = currentMessageText;
        acc += chunk;
        yield { type: 'delta', text: chunk };
      } else if ((method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') && typeof params.delta === 'string' && params.delta) {
        yield { type: 'reasoning', text: params.delta };
      } else if (method === 'item/started' && params.item) {
        const item = params.item;
        if (item.type === 'commandExecution' || item.type === 'command_execution') {
          const cmdText = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
          yield { type: 'tool', name: 'shell', detail: cmdText };
        } else if (item.type === 'fileChange' || item.type === 'file_change') {
          const paths = (item.changes ?? []).map((c: any) => String(c.path ?? '')).filter(Boolean);
          if (typeof item.id === 'string' && paths.length) fileChangesByItemId.set(item.id, paths);
        } else if (item.type === 'mcpToolCall') {
          yield { type: 'tool', name: String(item.tool ?? item.server ?? 'mcp') };
        }
      } else if (method === 'item/completed' && params.item) {
        const item = params.item;
        if ((item.type === 'agentMessage' || item.type === 'agent_message') && typeof item.text === 'string' && item.text) {
          const itemId = typeof item.id === 'string' ? item.id : undefined;
          if (!itemId || !deltaSeenIds.has(itemId)) {
            const chunk = (acc ? '\n\n' : '') + item.text;
            acc += chunk;
            yield { type: 'delta', text: chunk };
          }
          lastMessage = item.text;
        } else if (item.type === 'fileChange' || item.type === 'file_change') {
          const paths = (item.changes ?? []).map((c: any) => String(c.path ?? '')).filter(Boolean);
          yield { type: 'tool', name: 'edit', detail: paths.join(', ') };
        }
      } else if (method === 'thread/tokenUsage/updated') {
        const total = parseAppServerUsage(params.tokenUsage?.total);
        if (!total) continue;
        if (!resumeId) usage = total;
        else if (activeTurn && params.turnId === activeTurn) {
          const last = parseAppServerUsage(params.tokenUsage?.last);
          if (!previousUsage && last) previousUsage = usageSince(total, last);
          if (previousUsage) usage = usageSince(total, previousUsage);
        }
      } else if (method === 'error') {
        diagnostic = String(params.error?.message ?? params.message ?? 'Codex 请求失败');
      } else if (method === 'turn/completed') {
        const turn = params.turn ?? {};
        const status = turn.status;
        if (status === 'failed') {
          throw new Error(String(turn.error?.message ?? diagnostic ?? 'Codex 执行失败'));
        }
        if (status === 'interrupted') {
          yield { type: 'error', message: String(turn.error?.message ?? 'Codex 本轮已中断'), status: 'cancelled' };
          break;
        }
        completed = true;
        session.worker.initialized = { threadId: activeThread, turnId: turn.id };
        yield {
          type: 'done',
          nativeSession: req.conversation && activeThread ? { id: activeThread, turnId: turn.id, forkable: !!turn.id } : undefined,
          text: req.mode === 'ask' ? lastMessage || acc : acc,
          usage,
        };
        break;
      }
    }
  } catch (err) {
    if (!activeThread) throw new CodexStartupError(String(err), { cause: err });
    throw err;
  } finally {
    await session.release(completed ? 'rpc' : undefined);
  }

  if (!completed && diagnostic) throw new Error(diagnostic);
  if (!activeThread) throw new CodexStartupError('Codex app-server 未创建会话');
}

// Verified against codex-cli 0.167+ (`exec --json`) and 0.171 (`app-server`).
export function createCodexAdapter(bin: BinaryTarget = DEFAULT_CODEX_BIN): ProviderAdapter {
  return {
    id: 'codex',
    nativeConversation: true,
    label: 'Codex',
    capabilities: { askPolicy: 'sandbox-read-only', exec: true },

    async detect(signal) {
      const version = await probeVersion(bin.cmd, signal, { nativeExecutable: bin.nativeExecutable });
      return { installed: !!version, version };
    },

    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      if (req.harnesses || req.interact || req.conversation) {
        try {
          yield* runCodexAppServer(req, bin);
          return;
        } catch (err) {
          // Older headless installations may only support exec. No turn has started yet.
          if (req.interact || req.signal?.aborted || !(err instanceof CodexStartupError)) throw err;
          if (req.conversation?.resumeId) req.onPublicReplay?.();
        }
      }

      const args = ['exec', '--json', '--skip-git-repo-check'];
      if (req.mode === 'ask') args.push('--sandbox', 'read-only', '--ephemeral');
      else args.push('--sandbox', 'workspace-write');
      // Codex treats bare effort names as strings; they can pass through Windows cmd shims unchanged.
      if (req.reasoningEffort) args.push('-c', `model_reasoning_effort=${req.reasoningEffort}`);
      if (req.model) args.push('-m', req.model);
      args.push('-'); // prompt from stdin

      let acc = '';
      let last = '';
      for await (const ev of codexExecEvents(args, req, bin)) {
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
            usage: {
              inputTokens: ev.usage?.input_tokens,
              outputTokens: ev.usage?.output_tokens,
              ...(ev.usage?.cached_input_tokens !== undefined ? { cachedInputTokens: ev.usage.cached_input_tokens } : {}),
            },
          };
        }
      }
    },
  };
}

export const codex: ProviderAdapter = createCodexAdapter();
