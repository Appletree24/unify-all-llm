import type { HarnessPool } from './harness-pool.js';
import type { CustomProviderConfig, ReasoningEffort } from './config.js';
import type { QuotaReader } from '../quota/types.js';
import type { MemoryReference } from '../memory/report.js';
import type { RunRecord } from './store.js';

export const runningStatus = (status: RunRecord['status']) =>
  status === 'created' || status === 'deciding' || status === 'answering' || status === 'synthesizing';

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

export function httpMessages(input: { prompt: string; messages?: ChatMessage[] }, system?: string): ChatMessage[] {
  if (input.messages?.length) return input.messages;
  return [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user', content: input.prompt }];
}

export const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'denied'] as const;

export interface ToolUse {
  id?: string;
  name: string;
  detail?: string;
  status?: typeof TOOL_STATUSES[number];
  error?: string;
}

const MAX_TOOL_RECORDS = 200;
const MAX_TOOL_DETAIL = 4000;

function toolDetail(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > MAX_TOOL_DETAIL ? text.slice(0, MAX_TOOL_DETAIL - 1) + '…' : text;
}

export function appendToolUse(result: RunResult, tool: ToolUse): void {
  const list = (result.tools ??= []);
  const current = tool.id ? list.find((item) => item.id === tool.id) : undefined;
  if (!current && list.length >= MAX_TOOL_RECORDS) return;
  const detail = toolDetail(tool.detail);
  const error = toolDetail(tool.error);
  const next = {
    name: tool.name,
    ...(tool.id && { id: tool.id }),
    ...(tool.status && { status: tool.status }),
    ...(detail && { detail }),
    ...(error && { error }),
  };
  if (current) Object.assign(current, next);
  else list.push(next);
}

/** The single event vocabulary every provider is translated into. */
export interface NativeSession {
  id: string;
  /** A provider that can fork this immutable turn even after the original thread advances. */
  turnId?: string;
  forkable?: boolean;
}

export type ProviderEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | ({ type: 'tool' } & ToolUse)
  | { type: 'done'; text: string; usage?: Usage; memoryReferences?: MemoryReference[]; nativeSession?: NativeSession }
  | { type: 'error'; message: string; status?: 'failed' | 'cancelled' | 'timed_out' };

export interface Capabilities {
  askPolicy: 'read-tools' | 'sandbox-read-only' | 'provider-plan' | 'text-only' | 'unrestricted-command';
  exec: boolean;
}

export const SESSION_TITLE_LIMIT = 120;

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
  tone?: 'primary' | 'secondary' | 'danger';
}

export interface InteractionQuestion {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  allowOther?: boolean;
  secret?: boolean;
}

export interface InteractionRequest {
  id?: string;
  kind: 'approval' | 'question' | 'input';
  title: string;
  detail?: string;
  tool?: string;
  options?: InteractionOption[];
  questions?: InteractionQuestion[];
  placeholder?: string;
  secret?: boolean;
}

export interface PendingInteraction extends InteractionRequest {
  id: string;
}

export interface InteractionResponse {
  optionId?: string;
  answers?: Record<string, string[]>;
  text?: string;
  cancelled?: boolean;
}

export type InteractionHandler = (request: InteractionRequest) => Promise<InteractionResponse>;

export interface RunRequest {
  harnesses?: HarnessPool;
  sessionId?: string;
  prompt: string;
  /** Report a transport-level fallback before submitting the full public history. */
  onPublicReplay?: () => void;
  /** Full public replay is always in prompt. Send only this turn after a confirmed native resume. */
  conversation?: { turnPrompt: string; resumeId?: string; fork?: boolean; turnId?: string };
  /** Structured append-only messages for OpenAI-compatible API targets (preferred over prompt when present). */
  messages?: ChatMessage[];
  cwd: string;
  mode: RunMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** Present when the host (Desktop / interactive CLI / TUI) can answer mid-turn approval or input prompts. */
  interact?: InteractionHandler;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
}

export interface ProviderAdapter {
  id: string;
  nativeConversation?: boolean;
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
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
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
  cacheWarnings?: string[];
  tools?: ToolUse[];
  memoryReferences?: MemoryReference[];
  /** Display failures never change the provider's outcome. */
  observerErrors?: string[];
}

export function snapshotTarget(target: ModelTarget): TargetSnapshot {
  return { id: target.id, label: target.label, provider: target.adapter.id, model: target.model, reasoningEffort: target.reasoningEffort, capabilities: { ...target.adapter.capabilities }, configuration: target.adapter.configuration ? structuredClone(target.adapter.configuration) : undefined };
}
