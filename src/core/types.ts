/** ask: read-only Q&A. exec: the agent may modify files in cwd. */
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
  | { type: 'error'; message: string };

export interface RunRequest {
  prompt: string;
  cwd: string;
  mode: RunMode;
  model?: string;
  signal?: AbortSignal;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  detect(): Promise<DetectResult>;
  run(req: RunRequest): AsyncGenerator<ProviderEvent>;
}

export interface RunResult {
  provider: string;
  ok: boolean;
  text: string;
  reasoning: string;
  error?: string;
  durationMs: number;
  usage?: Usage;
}
