import { commandExists, openText, runText } from '../core/proc.js';
import type { InteractionRequest, ProviderAdapter, ProviderEvent, RunRequest } from '../core/types.js';
import { z } from 'zod';
import type { CustomProviderConfig } from '../core/config.js';
import { httpEffort } from './effort.js';
import { sseData } from './sse.js';
export type { CustomProviderConfig } from '../core/config.js';

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
const usageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  prompt_cache_hit_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).passthrough().optional(),
}).passthrough();

const chunkSchema = z.object({
  error: z.object({ message: z.string() }).passthrough().optional(),
  choices: z.array(z.object({
    index: z.number().optional(), finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullish(), reasoning_content: z.string().nullish(), reasoning: z.string().nullish(),
    }).optional(),
  })).optional(),
  usage: usageSchema.nullable().optional(),
});

function parseHttpUsage(u: z.infer<typeof usageSchema>) {
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens;
  const write = u.cache_creation_input_tokens;
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(write !== undefined ? { cacheWriteTokens: write } : {}),
  };
}

function openaiAdapter(id: string, c: Extract<CustomProviderConfig, { type: 'openai' }>, getKey = () => c.apiKeyEnv ? process.env[c.apiKeyEnv] : undefined): ProviderAdapter {
  return {
    id,
    label: c.label ?? id,
    capabilities: { askPolicy: 'text-only', exec: false },
    async detect() {
      // Configuration only; reachability is discovered on first use.
      return { installed: !c.apiKeyEnv || !!getKey(), version: c.model };
    },
    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      const key = getKey();
      if (c.apiKeyEnv && !key) {
        yield { type: 'error', message: `环境变量 ${c.apiKeyEnv} 未设置` };
        return;
      }
      const messages = req.messages?.length
        ? req.messages
        : [...(c.system ? [{ role: 'system' as const, content: c.system }] : []), { role: 'user' as const, content: req.prompt }];
      const res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: req.model ?? c.model,
          stream: true,
          ...httpEffort(c.baseUrl, req.reasoningEffort),
          messages,
        }),
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        yield { type: 'error', message: `HTTP ${res.status}` };
        return;
      }
      let acc = '';
      let finished = false;
      let usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number } | undefined;
      for await (const data of sseData(res.body)) {
        if (data.trim() === '[DONE]') {
          finished = true;
          break;
        }
        const chunk = chunkSchema.parse(JSON.parse(data));
        if (chunk.error) throw new Error(chunk.error.message);
        if (chunk.usage) usage = parseHttpUsage(chunk.usage);
        const choice = chunk.choices?.find((v) => (v.index ?? 0) === 0);
        if (!choice) continue;
        const delta = choice.delta;
        if (finished && (delta?.content || delta?.reasoning || delta?.reasoning_content)) throw new Error('SSE 在完成后继续返回正文');
        const thought = delta?.reasoning_content ?? delta?.reasoning;
        if (thought) yield { type: 'reasoning', text: thought };
        if (delta?.content) {
          acc += delta.content;
          yield { type: 'delta', text: delta.content };
        }
        if (choice.finish_reason != null) {
          if (choice.finish_reason !== 'stop') throw new Error(`模型未完整回答: finish_reason=${choice.finish_reason}`);
          finished = true;
        }
      }
      if (!finished) throw new Error('SSE 输出被截断：缺少 [DONE] 或 finish_reason');
      yield { type: 'done', text: acc, usage };
    },
  };
}

const INTERACT_PREFIX = '__UNIFY_INTERACT__:';

function commandAdapter(id: string, c: Extract<CustomProviderConfig, { type: 'command' }>): ProviderAdapter {
  return {
    id,
    label: c.label ?? id,
    capabilities: { askPolicy: 'unrestricted-command', exec: false },
    async detect(signal) {
      return { installed: await commandExists(c.command, signal) };
    },
    async *run(req: RunRequest): AsyncGenerator<ProviderEvent> {
      if (c.interactive && req.interact) {
        const session = openText(c.command, c.args ?? [], { cwd: req.cwd, signal: req.signal });
        session.write(req.prompt + '\n');
        let acc = '';
        let buf = '';
        try {
          for await (const chunk of session.chunks) {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const rawLine = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              const trimmed = rawLine.replace(/\r$/, '');
              if (trimmed.startsWith(INTERACT_PREFIX)) {
                const payload = JSON.parse(trimmed.slice(INTERACT_PREFIX.length)) as InteractionRequest;
                const response = await req.interact(payload);
                session.write(JSON.stringify(response) + '\n');
              } else {
                const line = rawLine + '\n';
                acc += line;
                yield { type: 'delta', text: line };
              }
            }
          }
          if (buf) {
            const trimmed = buf.replace(/\r$/, '');
            if (trimmed.startsWith(INTERACT_PREFIX)) {
              const payload = JSON.parse(trimmed.slice(INTERACT_PREFIX.length)) as InteractionRequest;
              const response = await req.interact(payload);
              session.write(JSON.stringify(response) + '\n');
            } else {
              acc += buf;
              yield { type: 'delta', text: buf };
            }
          }
        } finally {
          await session.close();
        }
        yield { type: 'done', text: acc.trim() };
        return;
      }

      let acc = '';
      for await (const chunk of runText(c.command, c.args ?? [], { cwd: req.cwd, stdin: req.prompt, signal: req.signal })) {
        acc += chunk;
        yield { type: 'delta', text: chunk };
      }
      yield { type: 'done', text: acc.trim() };
    },
  };
}

export function customAdapter(id: string, c: CustomProviderConfig, getKey?: () => string | undefined): ProviderAdapter {
  const inner = c.type === 'openai' ? openaiAdapter(id, c, getKey) : c.type === 'command' ? commandAdapter(id, c) : undefined;
  if (!inner) throw new Error(`自定义模型 "${id}" 的 type 必须是 "openai" 或 "command"`);
  return {
    ...inner,
    configuration: c,
    async *run(req) {
      if (req.mode === 'exec') {
        yield { type: 'error', message: `${inner.label} 是只回答的自定义模型，不能用来实施` };
        return;
      }
      yield* inner.run(req);
    },
  };
}
