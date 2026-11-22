// The contract between the Electron main process and the renderer. Types only.
import type { Config, ReasoningEffort } from '../../../src/core/config.js';
import type { RunRecord } from '../../../src/core/store.js';
import type { ModelTestState } from '../../../src/core/model-tests.js';
import type { TargetQuota } from '../../../src/quota/types.js';
import type { QuotaNotice } from '../../../src/quota/reminders.js';
import type { DistillApplyResult, DistillCandidate, DistillPreparation, DistillSaveRequest, DistillSourceRef, DuplicateCheckResult } from '../../../src/memory/distill.js';

export type { Config, DistillApplyResult, DistillCandidate, DistillPreparation, DistillSaveRequest, DistillSourceRef, DuplicateCheckResult, QuotaNotice, ReasoningEffort, RunRecord, TargetQuota };
export type RunResultRecord = RunRecord['results'][number];
export type CallRecord = RunRecord['calls'][number];

export interface TargetInfo {
  id: string;
  label: string;
  provider: string;
  /** The model actually sent, after config layers and API profiles. */
  model?: string;
  /** Explicit `models.<id>` override; undefined means "inherit". */
  modelOverride?: string;
  reasoningEffort?: ReasoningEffort;
  /** undefined while detection is still running. */
  installed?: boolean;
  test?: ModelTestState;
  exec: boolean;
  askPolicy: string;
  models: string[];
  efforts: ReasoningEffort[];
}

export interface WorkspaceInfo {
  cwd: string;
  name: string;
  branch?: string;
  targets: TargetInfo[];
  /** The selection the CLI/TUI would use when the user picks nothing. */
  defaults: string[];
  synthesizer?: string;
  executor?: string;
  decider?: string;
  showReasoning: boolean;
  configError?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  status: RunRecord['status'];
  hasExec: boolean;
}

export interface AskRequest {
  question: string;
  selected: string[];
  manual: boolean;
  synthesize: boolean;
  synthesizer?: string;
  /** Continue this session's latest comparison; omit to start a new one. */
  sessionId?: string;
  /** Optional targetId (or 'synthesis') from the previous turn to carry into follow-up history. */
  continueFrom?: string;
  /** Optional newly distilled memory items appended to the next API turn without mutating cached system prefix. */
  memoryUpdates?: string[];
}

export interface ExecPreview {
  turnId: string;
  question: string;
  from?: string;
  source: { targetId: string; scope: 'answer' | 'synthesis'; label: string };
  sources: { id?: string; label: string }[];
  executor: { id: string; label: string };
  executors: { id: string; label: string }[];
  cwd: string;
}

export interface ApiInfo {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  configured: boolean;
  model: string;
  hasKey: boolean;
  envKey: boolean;
  models: string[];
  blocked?: string;
}

export interface SettingsInfo {
  project: Config;
  user: Config;
  merged: Config;
  projectPath: string;
  userPath: string;
  apis: ApiInfo[];
}

export type Push =
  | { type: 'run'; record: RunRecord }
  | { type: 'activity'; turnId: string; runId: string; name: string; detail?: string }
  | { type: 'notice'; turnId: string; message: string }
  | { type: 'end'; turnId: string; sessionId: string; status: RunRecord['status'] }
  | { type: 'quota'; cwd: string; quotas: TargetQuota[] }
  | { type: 'quota-notice'; notice: QuotaNotice }
  | { type: 'open-quota' }
  | { type: 'workspace'; info: WorkspaceInfo };

export interface UnifyApi {
  platform(): Promise<NodeJS.Platform>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
  workspace(): Promise<WorkspaceInfo | null>;
  openWorkspace(dir?: string): Promise<WorkspaceInfo | null>;
  recentWorkspaces(): Promise<string[]>;
  sessions(): Promise<SessionSummary[]>;
  session(id: string): Promise<RunRecord[]>;
  ask(req: AskRequest): Promise<{ turnId: string; sessionId: string }>;
  retry(turnId: string, targetIds?: string[]): Promise<{ turnId: string; sessionId: string }>;
  cancel(turnId: string): Promise<void>;
  cancelTarget(turnId: string, targetId: string): Promise<boolean>;
  previewExec(turnId: string, from?: string, executor?: string): Promise<ExecPreview>;
  exec(turnId: string, from: string | undefined, executor: string): Promise<{ turnId: string; sessionId: string }>;
  quota(force?: boolean): Promise<TargetQuota[]>;
  settings(): Promise<SettingsInfo>;
  testTarget(id: string): Promise<void>;
  setSetting(key: keyof Config, value: unknown, entry?: string): Promise<WorkspaceInfo>;
  saveApi(id: string, model: string, apiKey?: string): Promise<WorkspaceInfo>;
  memoryUrl(): Promise<string>;
  prepareDistill(source: DistillSourceRef): Promise<DistillPreparation>;
  distillCandidates(source: DistillSourceRef, targetId?: string): Promise<DistillCandidate[]>;
  checkDistillDuplicate(targetPath: string, text: string): Promise<DuplicateCheckResult>;
  applyDistill(req: DistillSaveRequest): Promise<DistillApplyResult>;
  reveal(what: 'project' | 'run' | 'user-config' | 'project-config', id?: string): Promise<void>;
  copy(text: string): Promise<void>;
}

export type Method = keyof UnifyApi;
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** What the sandboxed preload exposes on window.unifyBridge. */
export interface Bridge {
  invoke(method: Method, ...args: unknown[]): Promise<Reply>;
  onPush(listener: (push: Push) => void): () => void;
}
