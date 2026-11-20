import type { CustomProviderConfig, ReasoningEffort } from './config.js';
import type { QuotaReader } from '../quota/types.js';

/** ask requests an answer using the provider's declared policy; exec permits edits. */
export type RunMode = 'ask' | 'exec';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** The single event vocabulary every provider is translated into. */
export type ProviderEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'done'; text: string; usage?: Usage }
  | { type: 'error'; message: string; status?: 'failed' | 'cancelled' | 'timed_out' };

export interface Capabilities {
  askPolicy: 'read-tools' | 'sandbox-read-only' | 'provider-plan' | 'text-only' | 'unrestricted-command';
  exec: boolean;
}

export interface RunRequest {
  prompt: string;
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
  /** Display failures never change the provider's outcome. */
  observerErrors?: string[];
}

export function snapshotTarget(target: ModelTarget): TargetSnapshot {
  return { id: target.id, label: target.label, provider: target.adapter.id, model: target.model, reasoningEffort: target.reasoningEffort, capabilities: { ...target.adapter.capabilities }, configuration: target.adapter.configuration ? structuredClone(target.adapter.configuration) : undefined };
}
