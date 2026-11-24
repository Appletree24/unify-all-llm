import { repoSchema, type Publication, type Repository } from '../../../src/bench/cases.js';
import { draftCase, publish, runBench } from '../../../src/bench/workflow.js';
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { atomicWrite } from '../../../src/core/atomic-write.js';
import { loadConfig, parseConfig, timeoutMillis, readJson, type Config } from '../../../src/core/config.js';
import { currentGitBranch, listGitBranches, switchGitBranch } from '../../../src/core/git-branches.js';
import { projectConfigPath, userConfigPath, writeSetting } from '../../../src/core/settings.js';
import { listRunIds, loadRun, saveRun, type RunRecord } from '../../../src/core/store.js';
import { graphIssue } from '../../../src/core/collaboration.js';
import { discussionFormat } from '../shared/decision-format.js';
import { commitMaterials } from './materials.js';
import { defaultTargetIds, detectTargets } from '../../../src/core/targets.js';
import { ModelTests } from '../../../src/core/model-tests.js';
import type { ModelTarget } from '../../../src/core/types.js';
import { chooseExecutor, selectPlan, startComparison, startExecution, type WorkflowEvent, type WorkflowHandle } from '../../../src/core/workflow.js';
import { applyDistillSave, checkMemoryDuplicates, distillCandidates as runDistillCandidates, prepareDistill as buildDistillPrep, type DistillApplyResult, type DistillCandidate, type DistillPreparation, type DistillSaveRequest, type DistillSourceRef, type DuplicateCheckResult } from '../../../src/memory/distill.js';
import { defaultContext } from '../../../src/memory/scan.js';
import { startMemoryServer, type MemoryServer } from '../../../src/memory/server.js';
import { effortChoices } from '../../../src/providers/effort.js';
import { buildRegistry } from '../../../src/providers/index.js';
import { targetModelIds, modelIds } from '../../../src/providers/models.js';
import { officialApis, readApiProfile, saveApiProfile } from '../../../src/providers/official.js';
import { QUOTA_REFRESH_MS, readTargetQuotas, type TargetQuota } from '../../../src/quota/index.js';
import { SESSION_TITLE_LIMIT, type AskRequest, type ExecPreview, type InteractionResponse, type Push, type SessionChanges, type SessionSummary, type SettingsInfo, type TargetInfo, type WorkspaceInfo } from '../shared/api.js';

const ACTIVE = new Set<RunRecord['status']>(['created', 'deciding', 'answering', 'synthesizing']);
const SESSION_BUSY = '这个对话还有请求在进行，请等待完成或先取消';
const PUSH_INTERVAL_MS = 60;
const QUOTA_TTL_MS = 45_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One project directory: its merged config, targets, live workflows and caches.
 * Everything model-related goes through the same core functions the CLI and TUI use.
 */
export class Workspace {
  cfg: Config = {};
  targets: ModelTarget[] = [];
  configError?: string;
  private installed = new Map<string, boolean>();
  private detecting?: Promise<void>;
  private detectCtl = new AbortController();
  private branch?: string | null;
  private branchChange?: Promise<void>;
  private readonly handles = new Map<string, WorkflowHandle>();
  private readonly deletions = new Map<string, Promise<void>>();
  private readonly runCache = new Map<string, { mtime: number; run: RunRecord }>();
  private quotaCache?: { at: number; value: Promise<TargetQuota[]> };
  private quotaRun?: AbortController;
  private readonly quotaTimer: NodeJS.Timeout;
  private disposed = false;
  private readonly benchAbort = new AbortController();
  private memory?: Promise<MemoryServer>;
  private readonly modelTests: ModelTests;

  constructor(readonly cwd: string, private readonly push: (p: Push) => void, private readonly onQuota: (quotas: TargetQuota[]) => void) {
    this.modelTests = new ModelTests(cwd, () => this.pushInfo());
    this.reload();
    void this.refreshGitBranch();
    this.quotaTimer = setInterval(() => this.refreshQuota(), QUOTA_REFRESH_MS);
  }

  /** Re-read both config layers; an invalid file is reported instead of crashing the window. */
  reload(redetect = true): void {
    void this.modelTests.reset();
    try {
      this.cfg = loadConfig(this.cwd);
      this.targets = Object.values(buildRegistry(this.cfg));
      this.configError = undefined;
    } catch (err) {
      this.configError = message(err);
      this.cfg = {};
      try {
        const path = userConfigPath();
        this.cfg.disableClaude = parseConfig(readJson(path) ?? {}, path).disableClaude;
        this.targets = Object.values(buildRegistry(this.cfg));
      } catch { this.targets = []; }
    }
    this.invalidateQuota();
    if (redetect) this.detect();
  }

  private detect(): void {
    this.detectCtl.abort();
    const ctl = (this.detectCtl = new AbortController());
    const targets = this.targets;
    this.installed = new Map();
    this.detecting = detectTargets(targets, ctl.signal).then((found) => {
      if (ctl.signal.aborted) return;
      this.installed = found;
      this.pushInfo();
    }, () => undefined);
  }

  private pushInfo(): void {
    this.push({ type: 'workspace', info: this.info() });
  }

  info(): WorkspaceInfo {
    const targets: TargetInfo[] = this.targets.map((t) => {
      const config = t.adapter.configuration;
      return {
        id: t.id, label: t.label, provider: t.adapter.id,
        model: t.model ?? (config?.type === 'openai' ? config.model : undefined),
        modelOverride: this.cfg.models?.[t.id],
        reasoningEffort: t.reasoningEffort,
        installed: this.installed.get(t.id),
        test: this.modelTests.state(t),
        exec: t.adapter.capabilities.exec, askPolicy: t.adapter.capabilities.askPolicy,
        models: targetModelIds(t, this.targets), efforts: [...effortChoices(t)],
      };
    });
    const defaults = this.cfg.providers ?? defaultTargetIds(this.cfg, this.targets).filter((id) => this.installed.get(id));
    return {
      cwd: this.cwd, name: basename(this.cwd) || this.cwd, branch: this.branch, targets, defaults,
      synthesizer: this.cfg.synthesizer, executor: this.cfg.executor, decider: this.cfg.decider,
      collaborationGraphs: this.cfg.collaborationGraphs ?? {},
      showReasoning: this.cfg.showReasoning ?? false, configError: this.configError,
    };
  }

  get busy(): boolean {
    return !!this.branchChange || this.handles.size > 0 || this.deletions.size > 0;
  }

  private async refreshGitBranch(): Promise<void> {
    this.branch = await currentGitBranch(this.cwd).catch(() => undefined);
    if (!this.disposed) this.pushInfo();
  }

  async gitBranches() {
    const branches = await listGitBranches(this.cwd);
    if (!this.disposed && !this.branchChange && this.branch !== branches.current) {
      this.branch = branches.current;
      this.pushInfo();
    }
    return branches;
  }

  async switchBranch(branch: string): Promise<void> {
    if (this.disposed) throw new Error('项目已关闭');
    if (this.busy) throw new Error('当前项目还有操作在进行，请等待完成后再切换分支');
    const change = switchGitBranch(this.cwd, branch).finally(() => this.refreshGitBranch());
    this.branchChange = change;
    try { await change; }
    finally { this.branchChange = undefined; }
  }

  private assertBranchIdle(): void {
    if (this.branchChange) throw new Error('正在切换 Git 分支，请稍候');
  }

  // ── records ────────────────────────────────────────────────────────────

  /** run.json files are re-parsed only when they change on disk. */
  private load(id: string): RunRecord | undefined {
    const live = this.handles.get(id);
    if (live) return live.record;
    try {
      const mtime = statSync(join(this.cwd, '.unify', 'runs', id, 'run.json')).mtimeMs;
      const hit = this.runCache.get(id);
      if (hit && hit.mtime === mtime && !ACTIVE.has(hit.run.status)) return hit.run;
      const run = loadRun(this.cwd, id);
      this.runCache.set(id, { mtime, run });
      return run;
    } catch { return undefined; }
  }

  private runs(): RunRecord[] {
    return listRunIds(this.cwd).map((id) => this.load(id)).filter((r): r is RunRecord => !!r);
  }

  private sessionSettingsPath(first: RunRecord): string {
    return join(this.runDir(first.id), 'desktop-session.json');
  }

  private sessionSettings(first: RunRecord): SessionChanges {
    try {
      const data = readJson(this.sessionSettingsPath(first)) as SessionChanges | undefined;
      return { title: typeof data?.title === 'string' ? data.title : undefined, pinned: data?.pinned === true };
    } catch { return {}; }
  }

  sessions(): SessionSummary[] {
    const map = new Map<string, RunRecord[]>();
    for (const run of this.runs()) {
      const list = map.get(run.sessionId);
      if (list) list.push(run); else map.set(run.sessionId, [run]);
    }
    return [...map.entries()].map(([id, runs]) => {
      const first = runs[0];
      const last = runs[runs.length - 1];
      const { title, pinned } = this.sessionSettings(first);
      return {
        id, title: title ?? first.question.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_LIMIT),
        pinned: pinned ?? false, createdAt: first.createdAt,
        updatedAt: last.updatedAt, turns: runs.filter((r) => r.kind === 'comparison').length,
        status: runs.find((run) => ACTIVE.has(run.status))?.status ?? last.status,
        hasExec: runs.some((r) => r.kind === 'execution'),
      };
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  session(id: string): RunRecord[] {
    return this.runs().filter((r) => r.sessionId === id);
  }

  updateSession(id: string, changes: SessionChanges): void {
    if (this.deletions.has(id)) throw new Error('正在删除这段对话');
    const [first] = this.session(id);
    if (!first) throw new Error('找不到这段对话');
    const settings = this.sessionSettings(first);
    if (changes.title !== undefined) {
      const title = typeof changes.title === 'string' ? changes.title.replace(/\s+/g, ' ').trim() : '';
      if (!title || title.length > SESSION_TITLE_LIMIT) throw new Error(`请输入 1–${SESSION_TITLE_LIMIT} 字的对话标题`);
      settings.title = title;
    }
    if (changes.pinned !== undefined) {
      if (typeof changes.pinned !== 'boolean') throw new Error('无效的置顶设置');
      settings.pinned = changes.pinned;
    }
    atomicWrite(this.sessionSettingsPath(first), JSON.stringify(settings, null, 2) + '\n');
  }

  async deleteSession(id: string, trash: (path: string) => Promise<void>): Promise<void> {
    this.assertBranchIdle();
    this.assertSessionIdle(id);
    const runs = this.session(id);
    if (!runs.length) throw new Error('找不到这段对话');
    if (runs.some((r) => ACTIVE.has(r.status))) throw new Error(SESSION_BUSY);

    const root = realpathSync(join(this.cwd, '.unify', 'runs'));
    const fromProject = relative(realpathSync(this.cwd), root);
    if (!fromProject || fromProject === '..' || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
      throw new Error('对话记录目录必须位于当前项目内');
    }
    const pending = this.trashSessionRuns(root, runs, trash);
    this.deletions.set(id, pending);
    try { await pending; }
    finally { this.deletions.delete(id); }
  }

  private async trashSessionRuns(root: string, runs: RunRecord[], trash: (path: string) => Promise<void>): Promise<void> {
    // Stage the complete session on the same filesystem so the OS receives a single trash item.
    const staged = mkdtempSync(join(root, '.deleted-session-'));
    const moved: string[] = [];
    try {
      for (const run of runs) {
        const source = join(root, run.id);
        if (!lstatSync(source).isDirectory()) throw new Error('对话记录目录已更改');
        renameSync(source, join(staged, run.id));
        moved.push(run.id);
        this.runCache.delete(run.id);
      }
      await trash(staged);
    } catch (err) {
      let restored = true;
      for (const id of moved.reverse()) {
        try { renameSync(join(staged, id), join(root, id)); }
        catch { restored = false; }
      }
      if (!restored) throw new Error(`部分对话记录无法还原，请检查 ${staged} 或系统回收站。${message(err)}`);
      try { rmdirSync(staged); } catch { /* The session records are already restored. */ }
      throw new Error(`无法将对话移到系统回收站：${message(err)}`);
    }
  }

  // ── workflows ──────────────────────────────────────────────────────────

  /**
   * Start a workflow and stream its live record to the window at a bounded rate;
   * structural events go out at once. Events emitted before the handle exists are replayed.
   */
  private start(begin: (onEvent: (e: WorkflowEvent) => void) => WorkflowHandle): { turnId: string; sessionId: string } {
    this.assertBranchIdle();
    const early: WorkflowEvent[] = [];
    let route: (e: WorkflowEvent) => void = (e) => early.push(e);
    const handle = begin((e) => route(e));
    const { record } = handle;
    this.handles.set(record.id, handle);
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      this.push({ type: 'run', record });
    };
    route = (e) => {
      if (e.type === 'provider') {
        if (e.event.type === 'done' || e.event.type === 'error') flush();
        else timer ??= setTimeout(flush, PUSH_INTERVAL_MS);
      } else if (e.type === 'interaction') {
        this.push({
          type: 'interaction',
          turnId: e.turnId,
          callId: e.callId,
          scope: e.scope,
          targetId: e.targetId,
          targetLabel: e.targetLabel,
          request: e.request,
        });
        flush();
      } else if (e.type === 'interaction-resolved') {
        this.push({
          type: 'interaction-resolved',
          turnId: e.turnId,
          callId: e.callId,
          interactionId: e.interactionId,
        });
      } else {
        if (e.type === 'notice') this.push(e);
        flush();
      }
    };
    early.splice(0).forEach(route);
    flush();
    void handle.done.catch(() => undefined).then(() => {
      flush();
      this.handles.delete(record.id);
      this.push({ type: 'end', turnId: record.id, sessionId: record.sessionId, status: record.status });
      this.refreshQuota(true);
    });
    return { turnId: record.id, sessionId: record.sessionId };
  }

  private assertSessionIdle(sessionId: string): void {
    if (this.deletions.has(sessionId)) throw new Error('正在删除这段对话');
    if ([...this.handles.values()].some((h) => h.record.sessionId === sessionId)) {
      throw new Error(SESSION_BUSY);
    }
  }

  async ask(req: AskRequest): Promise<{ turnId: string; sessionId: string }> {
    if (this.configError) throw new Error(`配置有误：${this.configError}`);
    await this.detecting;
    if (this.disposed) throw new Error('项目已关闭');
    let previous: RunRecord | undefined;
    if (req.sessionId) {
      this.assertSessionIdle(req.sessionId);
      const runs = this.session(req.sessionId);
      if (!runs.length) throw new Error('找不到可以继续的对话');
      if (req.replyTo && runs.at(-1)?.id !== req.replyTo) throw new Error('对话已有新一轮，请在最新轮次提交选择');
      previous = req.reviseTurn ? runs.at(-1) : runs.findLast((r) => r.kind === 'comparison');
    }
    const config = req.synthesizer ? parseConfig({ ...this.cfg, synthesizer: req.synthesizer }) : this.cfg;
    const workspace = this.info();
    if (req.reviseTurn && (previous?.id !== req.reviseTurn || !previous.collaboration)) throw new Error('请打开最新协作轮次再修改方案');
    let graph = req.graph && Object.hasOwn(workspace.collaborationGraphs, req.graph) ? workspace.collaborationGraphs[req.graph] : undefined;
    if (req.reviseTurn) graph = previous?.collaboration;
    if (req.graph && !graph) throw new Error('所选协作图不存在');
    if (graph) {
      const issue = graphIssue(graph, workspace.targets);
      if (issue) throw new Error(issue);
    }
    if (req.materials?.length && req.materialWorkspace !== this.cwd) throw new Error('请回到添加材料的项目发送');
    const materials = req.materials?.length ? commitMaterials(this.cwd, req.materials) : undefined;
    return this.start((onEvent) => startComparison({
      cwd: this.cwd, config, targets: this.targets, question: req.question, selected: req.selected, collaboration: graph,
      collaborationTargets: req.reviseTurn ? previous?.collaborationTargets : undefined,
      manualSelection: req.manual, synthesize: req.synthesize, previous, continueFrom: req.continueFrom,
      memoryUpdates: req.memoryUpdates, materials, expandFileMentions: !req.replyTo, discussionFormat, interactive: true, onEvent,
    }));
  }

  async retry(turnId: string, targetIds?: string[]): Promise<{ turnId: string; sessionId: string }> {
    await this.detecting;
    if (this.disposed) throw new Error('项目已关闭');
    const original = this.load(turnId);
    if (!original) throw new Error(`找不到记录 ${turnId}`);
    if (original.collaboration) {
      if (original.kind !== 'comparison') throw new Error('实施不能自动重试');
      this.assertSessionIdle(original.sessionId);
      return this.start(onEvent => startComparison({
        cwd: this.cwd, config: this.cfg, targets: this.targets, question: original.question, collaboration: original.collaboration,
        retry: { record: original, targetIds: original.collaboration!.plans.map(p => p.target) }, discussionFormat, interactive: true, onEvent,
      }));
    }
    this.assertSessionIdle(original.sessionId);
    const ids = targetIds?.length ? targetIds : original.targets.filter((t) => !original.results.find((r) => r.targetId === t.id)?.ok).map((t) => t.id);
    if (!ids.length) throw new Error('没有需要重试的目标');
    return this.start((onEvent) => startComparison({
      cwd: this.cwd, config: this.cfg, targets: this.targets, question: '',
      retry: { record: original, targetIds: ids }, discussionFormat, interactive: true, onEvent,
    }));
  }

  cancel(turnId: string): void {
    this.handles.get(turnId)?.cancel();
  }

  private assertGraphPending(run: RunRecord): void {
    const turns = this.session(run.sessionId);
    if (!run.collaboration || run.collaborationClosed || turns.at(-1)?.id !== run.id) throw new Error('这份方案已处理，请查看最新轮次');
    selectPlan(run);
  }

  closeCollaboration(turnId: string): void {
    const run = this.load(turnId);
    if (!run) throw new Error('找不到协作记录');
    this.assertSessionIdle(run.sessionId);
    this.assertGraphPending(run);
    const closed = { ...run, collaborationClosed: true };
    saveRun(this.cwd, closed);
    this.runCache.delete(turnId);
    this.push({ type: 'run', record: closed });
  }

  cancelTarget(turnId: string, targetId: string): boolean {
    return this.handles.get(turnId)?.cancelTarget(targetId) ?? false;
  }

  respondInteraction(turnId: string, interactionId: string, response: InteractionResponse): boolean {
    return this.handles.get(turnId)?.respondInteraction(interactionId, response) ?? false;
  }

  async previewExec(turnId: string, from?: string, executorId?: string): Promise<ExecPreview> {
    const run = this.load(turnId);
    if (!run) throw new Error(`找不到记录 ${turnId}`);
    const plan = selectPlan(run, from);
    await this.detecting;
    const executor = chooseExecutor(this.targets, executorId ?? run.collaboration?.execution.target ?? this.cfg.executor, this.installed);
    const label = (id: string) => run.targets.find((t) => t.id === id)?.label ?? this.targets.find((t) => t.id === id)?.label ?? id;
    const sources: ExecPreview['sources'] = [];
    if (run.synthesis?.result.ok) sources.push({ label: `汇总 · ${label(run.synthesis.provider)}` });
    for (const r of run.results) if (r.ok && r.text.trim()) sources.push({ id: r.targetId, label: label(r.targetId) });
    return {
      turnId, question: run.question, from,
      source: { targetId: plan.source.targetId, scope: plan.source.scope, label: plan.source.scope === 'synthesis' ? `汇总 · ${label(plan.source.targetId)}` : label(plan.source.targetId) },
      sources,
      executor: { id: executor.id, label: executor.label },
      executors: this.targets.filter((t) => t.adapter.capabilities.exec && this.installed.get(t.id)).map((t) => ({ id: t.id, label: t.label })),
      cwd: this.cwd,
    };
  }

  async exec(turnId: string, from: string | undefined, executorId: string): Promise<{ turnId: string; sessionId: string }> {
    await this.detecting;
    if (this.disposed) throw new Error('项目已关闭');
    if ([...this.handles.values()].some((h) => h.record.kind === 'execution')) throw new Error('已有实施在进行，请等待它结束');
    const source = this.load(turnId);
    if (!source) throw new Error(`找不到记录 ${turnId}`);
    this.assertSessionIdle(source.sessionId);
    if (source.collaboration) {
      this.assertGraphPending(source);
      const audit = source.collaboration.audit;
      if (audit && !this.installed.get(audit.target)) throw new Error(`复核目标 ${audit.target} 不可用，请先接入该目标`);
    }
    const executor = chooseExecutor(this.targets, executorId, this.installed);
    return this.start((onEvent) => startExecution({ cwd: this.cwd, config: this.cfg, targets: this.targets, executor, source, from, interactive: true, onEvent }));
  }

  // ── quota, settings, memory ────────────────────────────────────────────

  private refreshQuota(force = false): void {
    if (!this.disposed) void this.quota(force).catch(() => undefined);
  }

  private invalidateQuota(): void {
    this.quotaRun?.abort();
    this.quotaRun = undefined;
    this.quotaCache = undefined;
  }

  async quota(force = false): Promise<TargetQuota[]> {
    if (this.disposed) throw new Error('项目已关闭');
    const cached = this.quotaCache;
    if (cached && (this.quotaRun || (!force && Date.now() - cached.at <= QUOTA_TTL_MS))) return cached.value;
    const ctl = this.quotaRun = new AbortController();
    const value = readTargetQuotas(this.targets, this.cwd, ctl.signal).then((quotas) => {
      ctl.signal.throwIfAborted();
      this.push({ type: 'quota', cwd: this.cwd, quotas });
      this.onQuota(quotas);
      return quotas;
    }).catch((err: unknown) => {
      if (this.quotaCache?.value === value) this.quotaCache = undefined;
      throw err;
    }).finally(() => {
      if (this.quotaRun === ctl) this.quotaRun = undefined;
    });
    this.quotaCache = { at: Date.now(), value };
    return value;
  }

  async testTarget(id: string): Promise<void> {
    if (this.configError) throw new Error(this.configError);
    const target = this.targets.find(t => t.id === id);
    if (!target) throw new Error(`未知目标 ${id}`);
    await this.modelTests.run(target, this.cfg.timeoutSec);
  }

  settings(): SettingsInfo {
    const userPath = userConfigPath();
    const projectPath = projectConfigPath(this.cwd);
    const safeRead = (path: string): Config => { try { return parseConfig(readJson(path) ?? {}, path); } catch { return {}; } };
    return {
      project: safeRead(projectPath), user: safeRead(userPath), merged: this.cfg, projectPath, userPath,
      apis: officialApis.map((api) => {
        let profile: ReturnType<typeof readApiProfile>;
        try { profile = readApiProfile(api); } catch { profile = undefined; }
        const blocked = this.cfg.custom?.[api.id] || (api.id !== 'deepseek' && this.cfg.targets?.[api.id]) ? `目标 ${api.id} 已由现有配置使用` : undefined;
        return {
          id: api.id, label: api.label, baseUrl: api.baseUrl, apiKeyEnv: api.apiKeyEnv,
          configured: !!profile, model: profile?.model ?? api.model, hasKey: !!profile?.apiKey, envKey: !!process.env[api.apiKeyEnv],
          models: modelIds(api.id, [profile?.model ?? api.model]), blocked,
        };
      }),
    };
  }

  setSetting(key: keyof Config, value: unknown, entry?: string): WorkspaceInfo {
    writeSetting(this.cwd, key, value, entry);
    this.reload(['targets', 'custom', 'disableClaude', 'quotaCommands', 'models'].includes(key) || this.installed.size === 0);
    if (!this.detecting || this.installed.size) this.pushInfo();
    return this.info();
  }

  saveApi(id: string, model: string, apiKey?: string): WorkspaceInfo {
    const api = officialApis.find((a) => a.id === id);
    if (!api) throw new Error(`未知服务商 ${id}`);
    if (this.cfg.custom?.[api.id] || (api.id !== 'deepseek' && this.cfg.targets?.[api.id])) throw new Error(`目标 ${api.id} 已由现有配置使用`);
    const key = apiKey?.trim() || readApiProfile(api)?.apiKey;
    if (!key && !process.env[api.apiKeyEnv]) throw new Error('请输入 API Key');
    saveApiProfile(api, { model, ...(key ? { apiKey: key } : {}) });
    this.reload();
    this.refreshQuota();
    return this.info();
  }

  memoryUrl(): Promise<string> {
    this.memory ??= startMemoryServer(defaultContext(this.cwd));
    return this.memory.then((m) => m.url, (err) => { this.memory = undefined; throw err; });
  }

  private benchModel(id: string) {
    const target = this.targets.find(t => t.id === id);
    if (!target) throw new Error('评测目标不可用：' + id);
    return { target, signal: this.benchAbort.signal, timeoutMs: timeoutMillis(this.cfg.timeoutSec ?? 600), project: this.cwd };
  }

  benchDraft(id: string, target: string, note: string, repo?: Repository) {
    return draftCase(this.cwd, id, this.benchModel(target), note, repo && repoSchema.parse(repo));
  }

  benchPublish(data: unknown, judge?: string, options?: Publication) {
    return publish(this.cwd, data, judge ? this.benchModel(judge) : undefined, this.benchAbort.signal, options);
  }

  benchRun(ids: string[], targets: string[], judge?: string, collectionId?: string) {
    return runBench(this.cwd, ids, targets.map(id => this.benchModel(id)), judge ? this.benchModel(judge) : undefined, this.benchAbort.signal, collectionId);
  }

  prepareDistill(source: DistillSourceRef): DistillPreparation {
    return buildDistillPrep(defaultContext(this.cwd), source);
  }

  async distillCandidates(source: DistillSourceRef, targetId?: string): Promise<DistillCandidate[]> {
    await this.detecting;
    const picked = (targetId ? this.targets.find((t) => t.id === targetId) : undefined)
      ?? (this.cfg.synthesizer ? this.targets.find((t) => t.id === this.cfg.synthesizer && this.installed.get(t.id)) : undefined)
      ?? this.targets.find((t) => this.installed.get(t.id));
    if (!picked) throw new Error('没有可用于提炼候选的可用模型');
    return runDistillCandidates(defaultContext(this.cwd), source, picked);
  }

  checkDistillDuplicate(targetPath: string, text: string): DuplicateCheckResult {
    return checkMemoryDuplicates(defaultContext(this.cwd), targetPath, text);
  }

  applyDistill(req: DistillSaveRequest): DistillApplyResult {
    return applyDistillSave(defaultContext(this.cwd), req);
  }

  runDir(id: string): string {
    return join(this.cwd, '.unify', 'runs', id);
  }

  /** Cancel everything and wait for cleanup and the final record writes. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.benchAbort.abort();
    clearInterval(this.quotaTimer);
    const quota = this.quotaCache?.value.catch(() => undefined);
    this.invalidateQuota();
    this.detectCtl.abort();
    const pending = [...this.handles.values()];
    for (const h of pending) h.cancel();
    const deletions = Array.from(this.deletions.values(), (deletion) => deletion.catch(() => undefined));
    await Promise.all([quota, this.branchChange?.catch(() => undefined), this.modelTests.reset(), ...pending.map((h) => h.done.catch(() => undefined)), ...deletions]);
    await this.memory?.then((m) => m.close(), () => undefined);
  }
}
