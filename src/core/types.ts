import type { CustomProviderConfig, ReasoningEffort } from './config.js';
import type { QuotaReader } from '../quota/types.js';
import type { MemoryReference } from '../memory/report.js';

/** ask requests an answer using the provider's declared policy; exec permits edits. */
export type RunMode = 'ask' | 'exec';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolUse {
  name: string;
  detail?: string;
}

const MAX_TOOL_RECORDS = 200;
const MAX_TOOL_DETAIL = 500;

export function appendToolUse(result: RunResult, tool: ToolUse): void {
  const list = (result.tools ??= []);
  if (list.length >= MAX_TOOL_RECORDS) return;
  const detail = tool.detail?.trim();
  list.push({ name: tool.name, ...(detail ? { detail: detail.slice(0, MAX_TOOL_DETAIL) } : {}) });
}

/** The single event vocabulary every provider is translated into. */
export type ProviderEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'done'; text: string; usage?: Usage; memoryReferences?: MemoryReference[] }
  | { type: 'error'; message: string; status?: 'failed' | 'cancelled' | 'timed_out' };

export interface Capabilities {
  askPolicy: 'read-tools' | 'sandbox-read-only' | 'provider-plan' | 'text-only' | 'unrestricted-command';
  exec: boolean;
}

export interface RunRequest {
  prompt: string;
  /** Structured append-only messages for OpenAI-compatible API targets (preferred over prompt when present). */
  messages?: ChatMessage[];
  cwd: string;
  mode: RunMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  defaultModel?: string;
  autoSelect?: boolean;
  capabilities: Capabilities;
  configuration?: CustomProviderConfig;
  readQuota?: QuotaReader;
  detect(signal?: AbortSignal): Promise<DetectResult>;
  run(req: RunRequest): AsyncGenerator<ProviderEvent>;
}

/** A selectable model configuration; several targets may share one adapter. */
export interface ModelTarget {
  id: string;
  label: string;
  adapter: ProviderAdapter;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface TargetSnapshot {
  id: string;
  label: string;
  provider: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  capabilities: Capabilities;
  configuration?: CustomProviderConfig;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface RunResult {
  runId: string;
  targetId: string;
  provider: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  status: RunStatus;
  ok: boolean;
  text: string;
  reasoning: string;
  error?: string;
  durationMs: number;
  usage?: Usage;
  tools?: ToolUse[];
  memoryReferences?: MemoryReference[];
  /** Display failures never change the provider's outcome. */
  observerErrors?: string[];
}

export function snapshotTarget(target: ModelTarget): TargetSnapshot {
  return { id: target.id, label: target.label, provider: target.adapter.id, model: target.model, reasoningEffort: target.reasoningEffort, capabilities: { ...target.adapter.capabilities }, configuration: target.adapter.configuration ? structuredClone(target.adapter.configuration) : undefined };
}
