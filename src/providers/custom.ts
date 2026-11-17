import { commandExists, runText } from '../core/proc.js';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';

/**
 * A model plugged in from config, with no code change. Two transports:
 *
 *  - "openai":  any server speaking the OpenAI chat-completions protocol
 *               (vLLM, Ollama, LM Studio, most self-hosted gateways).
 *  - "command": any executable that reads the prompt on stdin and writes the
 *               answer to stdout.
 *
 * Custom models are answer-only: they cannot be the executor.
 */
export type CustomProviderConfig =
  | { type: 'openai'; label?: string; baseUrl: string; model: string; apiKeyEnv?: string; system?: string }
  | { type: 'command'; label?: string; command: string; args?: string[] };

function openaiAdapter(id: string, c: Extract<CustomProviderConfig, { type: 'openai' }>): ProviderAdapter {
  return {
    id,
    label: c.label ?? id,
    async detect() {
      // Configuration only; reachability is discovered on first use.
      return { installed: !!(c.baseUrl && c.model), version: c.model };
    },
    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      const key = c.apiKeyEnv ? process.env[c.apiKeyEnv] : undefined;
      if (c.apiKeyEnv && !key) {
        yield { type: 'error', message: `环境变量 ${c.apiKeyEnv} 未设置` };
        return;
      }
      const res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: req.model ?? c.model,
          stream: true,
          messages: [...(c.system ? [{ role: 'system', content: c.system }] : []), { role: 'user', content: req.prompt }],
        }),
      });
      if (!res.ok || !res.body) {
        yield { type: 'error', message: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
        return;
      }
      let acc = '';
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let delta: any;
          try {
            delta = JSON.parse(data).choices?.[0]?.delta;
          } catch {
            continue;
          }
          const thought = delta?.reasoning_content ?? delta?.reasoning;
          if (typeof thought === 'string' && thought) yield { type: 'reasoning', text: thought };
          if (typeof delta?.content === 'string' && delta.content) {
            acc += delta.content;
            yield { type: 'delta', text: delta.content };
          }
        }
      }
      yield { type: 'done', text: acc };
    },
  };
}

function commandAdapter(id: string, c: Extract<CustomProviderConfig, { type: 'command' }>): ProviderAdapter {
  return {
    id,
    label: c.label ?? id,
    async detect() {
      return { installed: await commandExists(c.command) };
    },
    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      let acc = '';
      for await (const chunk of runText(c.command, c.args ?? [], { cwd: req.cwd, stdin: req.prompt, signal: req.signal })) {
        acc += chunk;
        yield { type: 'delta', text: chunk };
      }
      yield { type: 'done', text: acc.trim() };
    },
  };
}

export function customAdapter(id: string, c: CustomProviderConfig): ProviderAdapter {
  const inner = c.type === 'openai' ? openaiAdapter(id, c) : c.type === 'command' ? commandAdapter(id, c) : undefined;
  if (!inner) throw new Error(`自定义模型 "${id}" 的 type 必须是 "openai" 或 "command"`);
  return {
    ...inner,
    async *run(req) {
      if (req.mode === 'exec') {
        yield { type: 'error', message: `${inner.label} 是只回答的自定义模型，不能用来实施` };
        return;
      }
      yield* inner.run(req);
    },
  };
}
