import { openJsonl, probeVersion, runJsonl } from '../core/proc.js';
import type { InteractionOption, InteractionQuestion, ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';
import { readAntigravityQuota } from '../quota/antigravity.js';
import type { BinaryTarget } from './codex.js';

const DEFAULT_AGY_BIN: BinaryTarget = { cmd: 'agy' };

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

/** Google AI subscriptions authenticate through the independently installed agy CLI. */
export function createAntigravityAdapter(bin: BinaryTarget = DEFAULT_AGY_BIN): ProviderAdapter {
  return {
    id: 'gemini-pro',
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
      const args = ['--mode', 'plan', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json'];
      if (req.model) args.push('--model', req.model);

      if (req.interact) {
        const session = openJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
          cwd: req.cwd,
          signal: req.signal,
          nativeExecutable: bin.nativeExecutable,
        });
        session.send({ event: 'user', message: { content: req.prompt } });
        try {
          for await (const ev of session.events) {
            if (await handleAgyInteraction(ev, req.interact, (v) => session.send(v))) continue;
            if (ev.event === 'step_update') {
              const step = ev.step_update;
              if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') {
                yield { type: 'delta', text: step.text_delta };
              } else if (step?.step_type === 'tool' && step.tool_name && step.state === 'ACTIVE') {
                yield { type: 'tool', name: String(step.tool_name) };
              }
            } else if (ev.event === 'result') {
              const result = ev.result;
              if (result?.status !== 'SUCCESS' || typeof result.response !== 'string') {
                throw new Error(String(result?.error || 'Antigravity 未返回成功回答'));
              }
              yield {
                type: 'done',
                text: result.response,
                usage: {
                  inputTokens: result.usage?.input_tokens,
                  outputTokens: result.usage?.output_tokens,
                },
              };
              break;
            }
          }
        } finally {
          await session.close();
        }
        return;
      }

      const stdin = JSON.stringify({ event: 'user', message: { content: req.prompt } }) + '\n';
      for await (const ev of runJsonl(bin.cmd, [...(bin.prefixArgs ?? []), ...args], {
        cwd: req.cwd,
        signal: req.signal,
        stdin,
        nativeExecutable: bin.nativeExecutable,
      })) {
        if (ev.event === 'step_update') {
          const step = ev.step_update;
          if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') {
            yield { type: 'delta', text: step.text_delta };
          } else if (step?.step_type === 'tool' && step.tool_name && step.state === 'ACTIVE') {
            yield { type: 'tool', name: String(step.tool_name) };
          }
        } else if (ev.event === 'result') {
          const result = ev.result;
          if (result?.status !== 'SUCCESS' || typeof result.response !== 'string') {
            throw new Error(String(result?.error || 'Antigravity 未返回成功回答'));
          }
          yield {
            type: 'done',
            text: result.response,
            usage: {
              inputTokens: result.usage?.input_tokens,
              outputTokens: result.usage?.output_tokens,
            },
          };
        }
      }
    },
  };
}

export const geminiPro: ProviderAdapter = createAntigravityAdapter();
