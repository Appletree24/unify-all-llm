import type { BenchIndex, BenchCase, Candidate, Collection, Publication, Repository } from '../../../src/bench/cases.js';
import type { BenchResult } from '../../../src/bench/workflow.js';
export type { BenchIndex, BenchCase, Candidate, Collection, Publication, Repository, BenchResult };
// The contract between the Electron main process and the renderer. Types only.
import type { Config, ReasoningEffort } from '../../../src/core/config.js';
import type { InteractionOption, InteractionQuestion, InteractionRequest, InteractionResponse, PendingInteraction } from '../../../src/core/types.js';
import type { RunRecord } from '../../../src/core/store.js';
import type { ModelTestState } from '../../../src/core/model-tests.js';
import type { AgyModel } from '../../../src/providers/agy-models.js';
import type { TargetQuota } from '../../../src/quota/types.js';
import type { QuotaNotice } from '../../../src/quota/reminders.js';
import type { CacheReport } from '../../../src/core/cache-monitor.js';
import type { MobileNetwork, MobileShareInfo } from '../../../src/mobile/types.js';
export type { CacheReport };
import type { DistillApplyResult, DistillCandidate, DistillPreparation, DistillSaveRequest, DistillSourceRef, DuplicateCheckResult } from '../../../src/memory/distill.js';

export type { Config, DistillApplyResult, DistillCandidate, DistillPreparation, DistillSaveRequest, DistillSourceRef, DuplicateCheckResult, InteractionOption, InteractionQuestion, InteractionRequest, InteractionResponse, PendingInteraction, QuotaNotice, ReasoningEffort, RunRecord, TargetQuota };
export type RunResultRecord = RunRecord['results'][number];
export type Material = NonNullable<RunRecord['input']['materials']>[number];
export type Feedback = NonNullable<Candidate['feedback']>;
export type StagedMaterial = Omit<Material, 'file' | 'note'> & { id: string };
export type MaterialSelection = { id: string; note: string };
export interface Evidence {
  question: string; answer: string; followUp: string; record: RunRecord;
}
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
  branch?: string | null;
  targets: TargetInfo[];
  /** The selection the CLI/TUI would use when the user picks nothing. */
  defaults: string[];
  synthesizer?: string;
  executor?: string;
  decider?: string;
  collaborationGraphs: NonNullable<Config['collaborationGraphs']>;
  showReasoning: boolean;
  configError?: string;
}

export interface ComposerSelection {
  /** Omit to follow the project defaults. An empty array is a manual selection. */
  selected?: string[];
  synth?: string;
  graph?: string;
}

export function resolveComposerSelection(workspace: WorkspaceInfo | null | undefined, selection?: ComposerSelection) {
  const available = new Set(workspace?.targets.filter(target => target.installed !== false).map(target => target.id));
  const selected = (selection?.selected ?? workspace?.defaults ?? []).filter(id => available.has(id));
  const synth = selection?.synth ?? '';
  return {
    selected, synth: synth === 'off' || available.has(synth) ? synth : '',
    graph: selection?.graph && workspace && Object.hasOwn(workspace.collaborationGraphs, selection.graph) ? selection.graph : undefined,
  };
}

export interface OpenedWorkspace {
  info: WorkspaceInfo;
  selection?: ComposerSelection;
}

export interface SessionSummary {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  turns: number;
  status: RunRecord['status'];
  hasExec: boolean;
}

export interface SessionChanges {
  title?: string;
  pinned?: boolean;
}

export { SESSION_TITLE_LIMIT } from '../../../src/core/types.js';

export interface AskRequest {
  materials?: MaterialSelection[];
  materialWorkspace?: string;
  graph?: string;
  reviseTurn?: string;
  question: string;
  selected: string[];
  manual: boolean;
  synthesize: boolean;
  synthesizer?: string;
  /** Continue this session's latest comparison; omit to start a new one. */
  sessionId?: string;
  /** Latest visible turn when submitting from a shared conversation. */
  expectedTurnId?: string;
  /** The turn whose decision form the user is answering. */
  replyTo?: string;
  /** Optional targetId (or 'synthesis') from the previous turn to carry into follow-up history. */
  continueFrom?: string;
  /** Optional newly distilled memory items appended to the next API turn without mutating cached system prefix. */
  memoryUpdates?: string[];
}

export interface ExecPreview {
  turnId: string;
  question: string;
  from?: string;
  source: { targetId: string; scope: 'answer' | 'synthesis' | 'plan-review'; label: string };
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

export type WorkspacePush =
  | { type: 'run'; record: RunRecord }
  | { type: 'interaction'; turnId: string; callId: string; scope: CallRecord['scope']; targetId: string; targetLabel: string; request: PendingInteraction }
  | { type: 'interaction-resolved'; turnId: string; callId: string; interactionId: string }
  | { type: 'notice'; turnId: string; message: string; category?: 'cache' }
  | { type: 'end'; turnId: string; sessionId: string; status: RunRecord['status'] }
  | { type: 'quota'; cwd: string; quotas: TargetQuota[] }
  | { type: 'workspace'; info: WorkspaceInfo };

export type Push = (WorkspacePush & { cwd: string })
  | { type: 'mobile-sharing'; share: MobileShareInfo | null }
  | { type: 'quota-notice'; notice: QuotaNotice }
  | { type: 'open-quota' };

export interface UnifyApi {
  platform(): Promise<NodeJS.Platform>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
  workspace(): Promise<OpenedWorkspace | null>;
  addWorkspace(): Promise<string | null>;
  openWorkspace(dir: string, sessionId?: string): Promise<OpenedWorkspace & { records: RunRecord[] }>;
  saveComposerSelection(cwd: string, selection: ComposerSelection): Promise<void>;
  recentWorkspaces(): Promise<string[]>;
  chooseGitBranch(cwd: string, x: number, y: number): Promise<void>;
  sessions(cwd: string): Promise<SessionSummary[]>;
  mobileSharing(): Promise<{ networks: MobileNetwork[]; share: MobileShareInfo | null }>;
  shareSession(cwd: string, id: string, address: string): Promise<MobileShareInfo>;
  stopSharing(cwd: string, id: string): Promise<void>;
  updateSession(cwd: string, id: string, changes: SessionChanges): Promise<void>;
  deleteSession(cwd: string, id: string): Promise<void>;
  ask(cwd: string, req: AskRequest): Promise<{ turnId: string; sessionId: string }>;
  retry(cwd: string, turnId: string, targetIds?: string[]): Promise<{ turnId: string; sessionId: string }>;
  cancel(cwd: string, turnId: string): Promise<void>;
  closeCollaboration(cwd: string, turnId: string): Promise<void>;
  cancelTarget(cwd: string, turnId: string, targetId: string): Promise<boolean>;
  respondInteraction(cwd: string, turnId: string, interactionId: string, response: InteractionResponse): Promise<boolean>;
  previewExec(cwd: string, turnId: string, from?: string, executor?: string): Promise<ExecPreview>;
  exec(cwd: string, turnId: string, from: string | undefined, executor: string): Promise<{ turnId: string; sessionId: string }>;
  quota(cwd: string, force?: boolean): Promise<TargetQuota[]>;
  cacheReport(): Promise<CacheReport>;
  settings(cwd: string): Promise<SettingsInfo>;
  agyModels(cwd: string): Promise<AgyModel[]>;
  testTarget(cwd: string, id: string): Promise<void>;
  setSetting(cwd: string, key: keyof Config, value: unknown, entry?: string): Promise<WorkspaceInfo>;
  saveCollaboration(cwd: string, id: string, graph: NonNullable<Config['collaborationGraphs']>[string] | undefined): Promise<void>;
  saveApi(cwd: string, id: string, model: string, apiKey?: string): Promise<WorkspaceInfo>;
  memoryUrl(cwd: string): Promise<string>;
  stageMaterial(cwd: string, name: string, mime: string, data: ArrayBuffer): Promise<StagedMaterial>;
  discardMaterial(cwd: string, id: string): Promise<void>;
  revealMaterial(cwd: string, turn: string, index: number): Promise<void>;
  captureBench(cwd: string, turn: string, call?: string, note?: string, feedback?: Feedback): Promise<Candidate>;
  benchIndex(cwd: string): Promise<BenchIndex>;
  benchSaveDraft(cwd: string, data: BenchCase, previous?: { id: string; data: BenchCase }): Promise<string>;
  benchSaveCollection(cwd: string, name: string, caseIds: string[], previous?: Collection): Promise<Collection>;
  benchDeleteCollection(cwd: string, previous: Collection): Promise<void>;
  benchDeleteEntry(cwd: string, kind: 'case' | 'draft' | 'candidate', id: string): Promise<void>;
  benchEvidence(cwd: string, id: string): Promise<Evidence>;
  benchDraft(cwd: string, id: string, target: string, note: string, repo?: Repository): Promise<{ id: string; data: BenchCase }>;
  benchRead(cwd: string, id: string, published: boolean): Promise<BenchCase>;
  benchPublish(cwd: string, data: BenchCase, judge?: string, options?: Publication): Promise<string>;
  benchRun(cwd: string, ids: string[], targets: string[], judge?: string, collectionId?: string): Promise<BenchResult[]>;
  prepareDistill(cwd: string, source: DistillSourceRef): Promise<DistillPreparation>;
  distillCandidates(cwd: string, source: DistillSourceRef, targetId?: string): Promise<DistillCandidate[]>;
  checkDistillDuplicate(cwd: string, targetPath: string, text: string): Promise<DuplicateCheckResult>;
  applyDistill(cwd: string, req: DistillSaveRequest): Promise<DistillApplyResult>;
  reveal(cwd: string, what: 'project' | 'run' | 'user-config' | 'project-config', id?: string): Promise<void>;
  copy(text: string): Promise<void>;
}

export type Method = keyof UnifyApi;
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** What the sandboxed preload exposes on window.unifyBridge. */
export interface Bridge {
  invoke(method: Method, ...args: unknown[]): Promise<Reply>;
  onPush(listener: (push: Push) => void): () => void;
}
