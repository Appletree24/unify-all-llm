import { openJsonl, probeVersion } from '../core/proc.js';
import type { InteractionOption, InteractionQuestion, ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';
import { readAntigravityQuota } from '../quota/antigravity.js';
import type { BinaryTarget } from './codex.js';
import { formatToolDetail, runAcp } from './acp.js';

const DEFAULT_AGY_BIN: BinaryTarget = { cmd: 'agy' };
const ANSWER_PROMPT = '上轮已经结束。请直接根据已取得的信息，在这条回复中给出原问题的答案或具体实施步骤。不要再次调用工具、写入文件或请求确认。';
const INSPECT_PROMPT = '如果需要查看项目文件或目录，请优先用原生文件查看、目录列表和搜索工具完成只读检查。没有合适的原生工具时，再使用终端。';

async function handleAgyInteraction(
  ev: Record<string, any>,
  interact: NonNullable<RunRequest['interact']>,
  send: (value: object) => void,
): Promise<boolean> {
  // 1. Claude-style control_request (if emitted)
  if (ev.type === 'control_request' && ev.request_id !== undefined) {
    const inner = ev.request ?? {};
    const toolName = String(inner.tool_name ?? inner.name ?? 'tool');
    const detail = inner.input ? JSON.stringify(inner.input, null, 2).slice(0, 1200) : undefined;
    const res = await interact({
      kind: 'approval',
      title: `Antigravity 请求调用 ${toolName}`,
      tool: toolName,
      detail,
      options: [
        { id: 'allow', label: '允许', tone: 'primary' },
        { id: 'deny', label: '拒绝', tone: 'danger' },
      ],
    });
    const allowed = !res.cancelled && res.optionId === 'allow';
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: ev.request_id,
        response: allowed
          ? { behavior: 'allow', updatedInput: inner.input ?? {} }
          : { behavior: 'deny', message: '用户拒绝了此操作' },
      },
    });
    return true;
  }

  // 2. Explicit Antigravity approval / permission / user-input events
  if (ev.event === 'approval_request' || ev.event === 'permission_request') {
    const payload = ev.approval_request ?? ev.permission_request ?? ev;
    const rawOptions: InteractionOption[] = Array.isArray(payload.options) && payload.options.length
      ? payload.options.map((o: any) => ({
          id: String(o.id ?? o.value ?? o.label ?? ''),
          label: String(o.label ?? o.id ?? ''),
          tone: o.tone,
        }))
      : [
          { id: 'approve', label: '允许', tone: 'primary' },
          { id: 'deny', label: '拒绝', tone: 'danger' },
        ];
    const res = await interact({
      kind: 'approval',
      title: String(payload.title || 'Antigravity 请求确认'),
      tool: typeof payload.tool_name === 'string' ? payload.tool_name : typeof payload.tool === 'string' ? payload.tool : undefined,
      detail: typeof payload.detail === 'string' ? payload.detail : typeof payload.command === 'string' ? `$ ${payload.command}` : undefined,
      options: rawOptions,
    });
    const approved = !res.cancelled && res.optionId !== 'deny' && res.optionId !== 'reject' && res.optionId !== 'cancel';
    send({
      event: ev.event === 'permission_request' ? 'permission_response' : 'approval_response',
      request_id: payload.request_id ?? ev.request_id,
      approved,
      decision: res.cancelled ? 'cancel' : (res.optionId ?? (approved ? 'approve' : 'deny')),
    });
    return true;
  }

  if (ev.event === 'user_input_request' || ev.event === 'question') {
    const payload = ev.user_input_request ?? ev.question ?? ev;
    if (Array.isArray(payload.questions) && payload.questions.length) {
      const questions: InteractionQuestion[] = payload.questions.map((q: any, idx: number) => ({
        id: String(q.id ?? `q_${idx}`),
        header: typeof q.header === 'string' ? q.header : undefined,
        question: String(q.question ?? q.prompt ?? ''),
        options: Array.isArray(q.options)
          ? q.options.map((o: any) => typeof o === 'string' ? { label: o } : { label: String(o.label ?? ''), description: o.description })
          : undefined,
        multiSelect: q.multiSelect === true,
        allowOther: q.allowOther ?? true,
      }));
      const res = await interact({
        kind: 'question',
        title: String(payload.title || 'Antigravity 请求补充信息'),
        questions,
      });
      const content = res.cancelled
        ? ''
        : questions.map((q) => `${q.header || q.question}: ${(res.answers?.[q.id] ?? []).join(', ')}`).join('\n');
      send({ event: 'user', request_id: payload.request_id ?? ev.request_id, message: { content }, answers: res.answers ?? {}, cancelled: !!res.cancelled });
    } else {
      const res = await interact({
        kind: 'input',
        title: String(payload.title || 'Antigravity 请求输入'),
        detail: typeof payload.prompt === 'string' ? payload.prompt : typeof payload.message === 'string' ? payload.message : undefined,
      });
      send({ event: 'user', request_id: payload.request_id ?? ev.request_id, message: { content: res.cancelled ? '' : (res.text ?? '') }, cancelled: !!res.cancelled });
    }
    return true;
  }

  return false;
}

function toolStep(step: Record<string, any>): Extract<ProviderEvent, { type: 'tool' }> | undefined {
  const name = step.tool_name ?? step.tool_info?.name;
  if (step.step_type !== 'tool' || typeof name !== 'string') return undefined;
  const id = Number.isSafeInteger(step.step_index) ? 'step-' + step.step_index : undefined;
  if (!id && step.state !== 'ACTIVE') return undefined;
  const rawError = step.tool_info?.error;
  const error = typeof rawError?.message === 'string' ? rawError.message : undefined;
  const denied = rawError?.type === 'PERMISSION_DENIED' || !!error && /permission|access is denied/i.test(error);
  const status = denied ? 'denied' : error || step.state === 'ERROR' ? 'failed' : step.state === 'DONE' ? 'completed' : 'in_progress';
  return { type: 'tool', id, name, status, detail: formatToolDetail(step.tool_info?.parameters), error };
}

async function* runAntigravityHeadless(req: RunRequest, bin: BinaryTarget): AsyncGenerator<ProviderEvent> {
  const args = ['--mode', 'plan', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (req.model) args.push('--model', req.model);
  // The headless transport can advance a thread, but cannot fork an immutable ACP parent.
  const resumeId = req.conversation?.fork ? undefined : req.conversation?.resumeId;
  if (resumeId) args.push('--conversation', resumeId);

  const session = openJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
    cwd: req.cwd,
    signal: req.signal,
    nativeExecutable: bin.nativeExecutable,
  });
  const ask = (content: string) => session.send({ event: 'user', message: { content } });
  const interact = req.interact;
  let receivedText = false;
  let askedForAnswer = false;
  let finished = false;
  let reportedDenial = false;
  let sessionId = resumeId;
  let started = false;
  try {
    if (req.conversation?.resumeId && !resumeId) req.onPublicReplay?.();
    ask(resumeId ? req.conversation!.turnPrompt : req.prompt);
    for await (const ev of session.events) {
      if (finished) throw new Error('Antigravity 在结束后继续发送事件');
      const id = ev.conversation_id ?? ev.result?.conversation_id ?? ev.start?.conversation_id;
      if (typeof id === 'string') sessionId = id;
      if (ev.event === 'step_update' || ev.request_id !== undefined) started = true;
      if (interact && await handleAgyInteraction(ev, interact, (value) => session.send(value))) continue;
      if (ev.event === 'step_update') {
        const step = ev.step_update;
        if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          receivedText ||= !!step.text_delta.trim();
          yield { type: 'delta', text: step.text_delta };
        } else if (step) {
          const tool = toolStep(step);
          if (tool) {
            reportedDenial ||= tool.status === 'denied';
            yield tool;
          }
        }
      } else if (ev.event === 'result') {
        const result = ev.result;
        if (result?.status !== 'SUCCESS' || typeof result.response !== 'string') {
          throw new Error(String(result?.error || 'Antigravity 未返回成功回答'));
        }
        if (!reportedDenial && Array.isArray(result.denied_actions) && result.denied_actions.length) {
          reportedDenial = true;
          const names = result.denied_actions.map((action: any) => action?.display_name ?? action?.action).filter((name: unknown) => typeof name === 'string');
          yield { type: 'tool', name: '权限确认', status: 'denied', detail: [...new Set(names)].join('、'),
            error: 'Antigravity 无交互模式跳过了需要权限确认的操作' };
        }
        const response = result.response.trim() ? result.response : '';
        if (!response && !receivedText) {
          if (askedForAnswer) throw new Error('Antigravity 补答后仍未返回回答正文');
          askedForAnswer = true;
          // Headless plan runs can end successfully after a denied tool call, without a response.
          ask(ANSWER_PROMPT);
          continue;
        }
        finished = true;
        session.endInput();
        yield {
          type: 'done',
          text: response,
          nativeSession: req.conversation && sessionId ? { id: sessionId } : undefined,
          usage: {
            inputTokens: result.usage?.input_tokens,
            outputTokens: result.usage?.output_tokens,
            cachedInputTokens: result.usage?.cached_read_tokens ?? result.usage?.cached_input_tokens,
          },
        };
      }
    }
  } catch (err) {
    if (!resumeId || started || req.signal?.aborted || !/conversation.*(?:not found|does not exist)|unknown conversation/i.test(String(err))) throw err;
    req.onPublicReplay?.();
    await session.close();
    yield* runAntigravityHeadless({ ...req, conversation: { turnPrompt: req.conversation!.turnPrompt } }, bin);
  } finally {
    await session.close();
  }
}

/** Google AI subscriptions authenticate through the independently installed agy CLI. */
export function createAntigravityAdapter(bin: BinaryTarget = DEFAULT_AGY_BIN): ProviderAdapter {
  return {
    id: 'gemini-pro',
    nativeConversation: true,
    label: 'Gemini Pro',
    defaultModel: 'gemini-4-neon-medium',
    autoSelect: false,
    capabilities: { askPolicy: 'provider-plan', exec: false },
    readQuota: readAntigravityQuota,
    async detect(signal) {
      const version = await probeVersion(bin.cmd, signal, { nativeExecutable: bin.nativeExecutable });
      return { installed: !!version, version };
    },
    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      const request = { ...req, prompt: INSPECT_PROMPT + '\n\n' + req.prompt };
      if (req.interact || req.conversation) {
        yield* runAcp(request, bin, {
          args: ['acp'], label: 'Gemini Pro', modeId: 'plan', modelId: req.model, emptyAnswerPrompt: ANSWER_PROMPT,
          fallback: () => runAntigravityHeadless(request, bin),
        });
        return;
      }
      yield* runAntigravityHeadless(request, bin);
    },
  };
}

export const geminiPro: ProviderAdapter = createAntigravityAdapter();
