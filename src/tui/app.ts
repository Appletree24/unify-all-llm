import { capture } from '../bench/cases.js';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { currentGitBranch, listGitBranches, switchGitBranch, type GitBranches } from '../core/git-branches.js';
import { loadConfig, type Config, type RunRecord } from '../core/store.js';
import type { ModelTarget, ProviderEvent } from '../core/types.js';
import { chooseExecutor, selectPlan, startComparison, startExecution, type WorkflowEvent, type WorkflowHandle } from '../core/workflow.js';
import { defaultContext } from '../memory/scan.js';
import { formatMemoryReferences } from '../memory/report.js';
import type { MemoryContext } from '../memory/types.js';
import { startMemoryServer, type MemoryServer } from '../memory/server.js';
import { buildRegistry } from '../providers/index.js';
import { readTargetQuotas } from '../quota/index.js';
import { defaultTargetIds, detectTargets } from '../core/targets.js';
import { ModelTests } from '../core/model-tests.js';
import { displaySynthesisEvents } from '../ui/synthesis.js';
import { COMMANDS, complete, listFiles, type Completion } from './complete.js';
import { readApiProfile, saveApiProfile, type ApiProfile, type OfficialApi } from '../providers/official.js';
import { SettingsView, writeSetting } from './settings.js';
import { ApiView } from './api.js';
import { Editor } from './editor.js';
import { KeyParser, type Key } from './keys.js';
import { layout } from './markdown.js';
import { MemoryView } from './memory.js';
import { QuotaView } from './quota.js';
import { Screen, charWidth, rgb, textWidth, truncate, type Cell } from './screen.js';

// ── palette ────────────────────────────────────────────────────────────────
const GOLD = rgb(232, 196, 104); // the synthesis: where the voices converge
const VIOLET = rgb(190, 140, 255); // execution
const DIM = rgb(120, 125, 135);
const BORDER = rgb(72, 76, 86);
const RED = rgb(240, 90, 90);
const YELLOW = rgb(235, 190, 90);
const PROVIDER_COLORS: Record<string, string> = {
  claude: rgb(217, 119, 87),
  codex: rgb(25, 195, 155),
  deepseek: rgb(110, 130, 250),
};
const FALLBACK_COLORS = [rgb(230, 130, 180), rgb(120, 200, 230), rgb(170, 210, 110)];
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const kilo = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
const EDITING = new Set(['char', 'paste', 'backspace', 'delete', 'wordback', 'worddel', 'altenter', 'ctrl+j', 'ctrl+w', 'ctrl+u', 'ctrl+k', 'ctrl+d']);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface Pane {
  id: string; // 'a:<target>' | 'synth' | 'exec'
  targetId: string;
  kind: 'answer' | 'synth' | 'exec';
  title: string;
  color: string;
  text: string;
  reasoning: string;
  status: 'run' | 'ok' | 'err' | 'cancelled' | 'timed_out';
  error?: string;
  tool?: string;
  start: number;
  end?: number;
  scroll: number;
  follow: boolean;
  viewH: number;
  maxScroll: number;
  cache?: { key: string; lines: Cell[][] };
}

export interface TuiIO {
  cols(): number;
  rows(): number;
  write(s: string): void;
  setMouse?(on: boolean): void;
}

export class App {
  onQuit: () => void = () => {};

  private installed = new Map<string, boolean>();
  private selected: string[] = [];
  private panes: Pane[] = [];
  private synth?: Pane;
  private exec?: Pane;
  private question = '';
  private turn = 0;
  private lastRun?: RunRecord;
  private lastExecution?: RunRecord;
  private active?: WorkflowHandle;
  private detecting = new AbortController();

  private ed = new Editor();
  private history: string[] = [];
  private histIdx = 0;
  private draft = '';
  private comp?: Completion;
  private compIdx = 0;
  private compOff = false;
  private files?: string[];
  /** Messages submitted while a turn is running; sent in order once it ends. */
  private queue: string[] = [];
  private userCancel = false;
  private busySince = 0;
  private quitArmed = 0;
  private help = false;
  private tokens = { input: 0, output: 0 };
  private branch?: string | null;
  private branchOperation?: Promise<void>;
  private switchingBranch = false;
  private branchView?: GitBranches & { offset: number };
  private memory?: Promise<MemoryServer>;
  private mem?: MemoryView;
  private settings?: SettingsView;
  private api?: ApiView;
  private quota?: QuotaView;
  private quotaDetails = false;

  private focus = 'input';
  private zoomId?: string;
  private activeAnswer = 0;
  private busy = false;
  private ctl?: AbortController;
  private confirm?: { text: string; yes: () => void };
  private notice = '';
  private noticeColor = DIM;
  private showReasoning = false;

  private frame = 0;
  private prev: string[] = [];
  private prevCols = 0;
  private last?: Screen;
  private cursor: { x: number; y: number } | null = null;
  private pending = false;
  private ticker?: NodeJS.Timeout;
  private disposed = false;
  private rects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  private inputTop = 0;
  private mouseOn = true;
  private manualModels = false;
  private sessionSynth?: string;
  private continueFrom?: string;
  private readonly modelTests: ModelTests;

  constructor(
    private io: TuiIO,
    private cwd: string,
    private cfg: Config,
    private all: ModelTarget[],
    private memoryCtx: MemoryContext = defaultContext(cwd),
  ) { this.modelTests = new ModelTests(cwd, () => this.requestRender()); }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async init(open?: 'memory'): Promise<void> {
    const initialBranch = currentGitBranch(this.cwd).catch(() => undefined);
    this.showReasoning = this.cfg.showReasoning ?? false;
    this.mouseOn = this.cfg.mouse ?? true;
    if (!this.mouseOn) this.io.setMouse?.(false);
    if (open === 'memory') this.openMemory();
    else this.startQuotaMonitor();
    this.render();
    this.ticker = setInterval(() => {
      if (this.busy || this.installed.size < this.all.length) {
        this.frame++;
        this.render();
      }
    }, 100);
    const initial = this.all;
    const [detected, branch] = await Promise.all([detectTargets(initial, this.detecting.signal), initialBranch]);
    if (this.disposed) return;
    if (!this.branchOperation && this.branch === undefined) this.branch = branch;
    for (const target of initial) {
      if (this.adapter(target.id) === target) this.installed.set(target.id, detected.get(target.id) ?? false);
    }
    if (!this.manualModels) {
      const wanted = defaultTargetIds(this.cfg, this.all);
      this.selected = this.cfg.providers ?? wanted.filter((id) => this.installed.get(id));
    }
    this.requestRender();
  }

  private startQuotaMonitor(): void {
    this.quota ??= new QuotaView((signal) => readTargetQuotas(this.all, this.cwd, signal), () => this.requestRender());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.quota?.dispose();
    if (this.ticker) clearInterval(this.ticker);
    this.ctl?.abort();
    this.detecting.abort();
    await Promise.all([this.active?.done.catch(() => undefined), this.branchOperation, this.modelTests.reset()]);
    await this.memory?.then((m) => m.close(), () => undefined);
  }

  /** Wait for model cleanup and record persistence; also used by terminal hosts. */
  async waitForIdle(): Promise<void> {
    await this.active?.done.catch(() => undefined);
  }

  invalidate(): void {
    this.prev = [];
    this.render();
  }

  snapshot(): string[] {
    return this.last?.toPlain() ?? [];
  }

  private requestRender(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.render();
    }, 16);
  }

  private say(text: string, color = DIM): void {
    this.notice = text;
    this.noticeColor = color;
    this.requestRender();
  }

  private colorOf(id: string): string {
    return PROVIDER_COLORS[id] ?? FALLBACK_COLORS[Math.max(0, this.all.findIndex((a) => a.id === id)) % FALLBACK_COLORS.length];
  }

  private adapter(id: string): ModelTarget | undefined {
    return this.all.find((a) => a.id === id);
  }

  private newPane(targetId: string, kind: Pane['kind'], title: string, color: string): Pane {
    const id = kind === 'answer' ? `a:${targetId}` : kind;
    return { id, targetId, kind, title, color, text: '', reasoning: '', status: 'run', start: Date.now(), scroll: 0, follow: true, viewH: 1, maxScroll: 0 };
  }

  private apply(p: Pane, ev: ProviderEvent): void {
    p.cache = undefined;
    if (ev.type === 'delta') {
      p.text += ev.text;
      p.tool = undefined;
    } else if (ev.type === 'reasoning') {
      p.reasoning += ev.text;
    } else if (ev.type === 'tool') {
      p.tool = ev.name;
      if (p.kind === 'exec') {
        const detail = ev.detail ? ' ' + ev.detail.replace(/\s+/g, ' ').slice(0, 160) : '';
        p.text += `${p.text && !p.text.endsWith('\n') ? '\n' : ''}⚙ ${ev.name}${detail}\n`;
      }
    } else if (ev.type === 'done') {
      p.status = 'ok';
      p.end = Date.now();
      p.tool = undefined;
      if (p.kind !== 'exec' && ev.text) p.text = ev.text; // the final answer, without tool-use chatter
      p.text += formatMemoryReferences(ev.memoryReferences);
      if (p.kind === 'answer' && p.follow) {
        // A finished answer is read from its beginning, not its tail.
        p.follow = false;
        p.scroll = 0;
      }
    } else if (ev.type === 'error') {
      p.status = ev.status === 'cancelled' || ev.status === 'timed_out' ? ev.status : 'err';
      p.end = Date.now();
      p.error = ev.message;
    }
    this.requestRender();
  }

  // ── flows ────────────────────────────────────────────────────────────────
  private workflowEvent(ev: WorkflowEvent): void {
    if (ev.type === 'stage' && ev.stage === 'answering') {
      this.panes = ev.targets.map((t) => this.newPane(t.id, 'answer', t.label, this.colorOf(t.id)));
    } else if (ev.type === 'call' && (ev.scope === 'synthesis' || ev.scope === 'plan-review')) {
      this.synth = this.newPane(ev.target.id, 'synth', `${ev.scope === 'plan-review' ? '方案复核' : '汇总'} · ${ev.target.label}`, GOLD);
    } else if (ev.type === 'provider') {
      const pane = ev.scope === 'answer' ? this.panes.find((p) => p.id === `a:${ev.targetId}`) : ev.scope === 'synthesis' || ev.scope === 'plan-review' ? this.synth : ev.scope === 'exec' ? this.exec : undefined;
      if (pane) this.apply(pane, ev.event);
    } else if (ev.type === 'notice') this.say(ev.message);
    this.requestRender();
  }

  private async ask(question: string, retryIds?: string[]): Promise<void> {
    if (this.switchingBranch) return this.say('正在切换 Git 分支，请稍候', YELLOW);
    if (!this.selected.length) return this.say('没有可用的模型，输入 /settings 接入官方 API，或检查 CLI 登录状态', RED);
    const previous = this.lastRun;
    const continueFrom = retryIds ? undefined : this.continueFrom;
    this.continueFrom = undefined;
    this.begin();
    this.ctl = new AbortController();
    this.question = question;
    this.turn++;
    this.panes = [];
    this.synth = undefined;
    this.exec = undefined;
    this.lastRun = undefined;
    this.lastExecution = undefined;
    this.zoomId = undefined;
    this.focus = 'input';
    this.activeAnswer = 0;
    this.render();
    try {
      this.active = startComparison({
        cwd: this.cwd, config: this.cfg, targets: this.all, question, selected: this.selected,
        previous, continueFrom, manualSelection: this.manualModels, signal: this.ctl.signal,
        retry: retryIds && previous ? { record: previous, targetIds: retryIds } : undefined,
        onEvent: displaySynthesisEvents((ev) => this.workflowEvent(ev)),
      });
      this.lastRun = this.active.record;
      this.addUsage(await this.active.done);
    } catch (err) {
      this.say(`出错: ${err instanceof Error ? err.message : err}`, RED);
    } finally {
      this.finish();
    }
  }

  private startExec(executorId?: string): void {
    if (this.switchingBranch) return this.say('正在切换 Git 分支，请稍候', YELLOW);
    if (this.busy) return this.say('请等待当前请求完成，或按 Ctrl+C 取消', YELLOW);
    const run = this.lastRun;
    if (!run) return this.say('还没有可实施的方案：先提一个问题', YELLOW);

    const focused = this.panes.find((p) => p.id === this.focus);
    const from = run.collaboration ? undefined : focused?.id.slice(2);
    try {
      const plan = selectPlan(run, from);
      const chosen = chooseExecutor(this.all, executorId ?? run.collaboration?.execution.target ?? this.cfg.executor, this.installed);
      this.confirm = {
        text: `按 y 确认 · 其他键取消 — 让 ${chosen.label} 按「${plan.source.targetId}」修改 ${basename(this.cwd)}/ 下的文件`,
        yes: () => void this.runExec(chosen, run, from),
      };
    } catch (err) { return this.say(err instanceof Error ? err.message : String(err), YELLOW); }
    this.requestRender();
  }

  private async runExec(executor: ModelTarget, source: RunRecord, from?: string): Promise<void> {
    const pane = (this.exec = this.newPane(executor.id, 'exec', `实施 · ${executor.label}`, VIOLET));
    this.focus = 'input';
    this.zoomId = undefined;
    this.begin();
    const ctl = (this.ctl = new AbortController());
    this.render();
    try {
      this.active = startExecution({
        cwd: this.cwd, config: this.cfg, targets: this.all, executor, source, from, signal: ctl.signal,
        onEvent: (ev) => {
          if (ev.type === 'call' && ev.scope === 'result-review') this.exec = this.newPane(ev.target.id, 'exec', `实施复核 · ${ev.target.label}`, GOLD);
          if (ev.type === 'provider') this.apply(ev.scope === 'result-review' ? this.exec! : pane, ev.event);
        },
      });
      this.lastExecution = await this.active.done;
      this.addUsage(this.lastExecution);
      if (pane.status === 'ok') this.say('实施完成，请用 git diff 检查改动', GOLD);
    } catch (err) {
      this.say(`实施失败: ${err instanceof Error ? err.message : err}`, RED);
    } finally {
      this.finish();
    }
  }

  /** Show the memory manager in place of the comparison screen until it is closed. */
  openMemory(): void {
    try {
      this.mem = new MemoryView(this.memoryCtx, {
        close: () => { this.mem = undefined; this.startQuotaMonitor(); },
        web: () => this.memoryWeb(),
      });
      this.quota?.dispose();
      this.quota = undefined;
    } catch (err) { this.say(`无法读取记忆: ${err instanceof Error ? err.message : err}`, RED); }
    this.requestRender();
  }

  /** One web server per session; it stops when the TUI exits. */
  private memoryWeb(): Promise<string> {
    this.memory ??= startMemoryServer(this.memoryCtx);
    return this.memory.then((m) => { this.requestRender(); return m.url; }, (err) => { this.memory = undefined; this.requestRender(); throw err; });
  }

  private begin(): void {
    this.busy = true;
    this.busySince = Date.now();
    this.userCancel = false;
  }

  /** End of a turn: send the next queued message, or hand the queue back after an interrupt. */
  private finish(): void {
    this.busy = false;
    this.requestRender();
    if (!this.queue.length || this.disposed) return;
    if (!this.userCancel) return void this.ask(this.queue.shift()!);
    const queued = this.queue.splice(0).join('\n\n');
    this.ed.set(this.ed.empty ? queued : `${queued}\n\n${this.ed.text}`);
    this.say('已中断，排队的消息已放回输入框', YELLOW);
  }

  private interrupt(): void {
    this.userCancel = true;
    this.ctl?.abort();
    this.say('已取消当前请求', YELLOW);
  }

  private addUsage(run: RunRecord): void {
    const supporting = run.calls.filter(c => ['plan-review', 'result-review', 'dispute-assessment', 'source-check'].includes(c.scope));
    for (const r of [...run.results, ...(run.synthesis ? [run.synthesis.result] : []), ...supporting.map(c => c.result)]) {
      this.tokens.input += r.usage?.inputTokens ?? 0;
      this.tokens.output += r.usage?.outputTokens ?? 0;
    }
  }

  private copy(): void {
    const p = this.findPane(this.focus) ?? this.bottomPane() ?? this.panes[this.activeAnswer];
    if (!p || !p.text.trim()) return this.say('没有可复制的内容', YELLOW);
    const [cmd, args, data]: [string, string[], Buffer] =
      process.platform === 'win32'
        ? ['clip', [], Buffer.from('﻿' + p.text, 'utf16le')]
        : process.platform === 'darwin'
          ? ['pbcopy', [], Buffer.from(p.text, 'utf8')]
          : ['xclip', ['-selection', 'clipboard'], Buffer.from(p.text, 'utf8')];
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', () => this.say(`复制失败：找不到 ${cmd}`, RED));
      child.on('close', (code) => code === 0 && this.say(`已复制「${p.title}」到剪贴板`, GOLD));
      child.stdin.end(data);
    } catch {
      this.say('复制失败', RED);
    }
  }

  private newConversation(): void {
    if (this.busy) return this.say('请等待当前请求完成，或按 Ctrl+C 取消', YELLOW);
    this.panes = [];
    this.synth = this.exec = undefined;
    this.lastRun = undefined;
    this.lastExecution = undefined;
    this.continueFrom = undefined;
    this.question = '';
    this.turn = 0;
    this.focus = 'input';
    this.zoomId = undefined;
    this.say('已开始新对话');
  }

  private useApi(api: OfficialApi, profile: ApiProfile): void {
    const registry = buildRegistry(this.cfg, other => other.id === api.id ? profile : readApiProfile(other));
    const updated = Object.values(registry).filter(t => t.adapter.id === api.id);
    saveApiProfile(api, profile);
    void this.modelTests.reset();
    this.all = [...this.all.filter(t => t.adapter.id !== api.id), ...updated];
    for (const t of updated) this.installed.set(t.id, true);
    this.selected = [api.id];
    this.manualModels = true;
    this.quota?.dispose();
    this.quota = undefined;
    this.startQuotaMonitor();
    this.say(`已选用 ${api.label} · ${registry[api.id].model ?? profile.model}，可以直接提问`, GOLD);
  }

  private applySetting(field: keyof Config, value: unknown, entry?: string): void {
    const { cfg, targets } = writeSetting(this.cwd, field, value, entry);
    void this.modelTests.reset();
    if (field === 'synthesizer' || !targets.some(t => t.id === this.sessionSynth)) this.sessionSynth = undefined;
    if (this.sessionSynth) cfg.synthesizer = this.sessionSynth;
    this.cfg = cfg;
    this.all = targets;
    if (field === 'mouse') {
      this.mouseOn = cfg.mouse ?? true;
      this.io.setMouse?.(this.mouseOn);
    }
    if (field === 'showReasoning') this.showReasoning = cfg.showReasoning ?? false;
    if (field === 'providers') this.manualModels = false;
    this.selected = this.selected.filter(id => targets.some(t => t.id === id));
    const selectDefaults = () => {
      if (!this.manualModels) this.selected = cfg.providers ?? defaultTargetIds(cfg, targets).filter(id => this.installed.get(id));
    };
    const transportChanged = ['targets', 'custom', 'disableClaude'].includes(field);
    if (transportChanged) this.installed.clear();
    selectDefaults();
    if (targets.some(t => !this.installed.has(t.id))) void detectTargets(targets, this.detecting.signal).then(installed => {
      if (this.disposed || this.all !== targets) return;
      this.installed = installed;
      selectDefaults();
      this.requestRender();
    });
    if (['targets', 'models', 'custom', 'quotaCommands', 'disableClaude'].includes(field)) {
      this.quota?.dispose();
      this.quota = undefined;
      this.startQuotaMonitor();
    }
  }

  private changeBranch(branch: string): void {
    if (this.branchOperation) return this.say('Git 分支操作正在进行，请稍候', YELLOW);
    if (branch && this.busy) return this.say('请等待当前请求结束后切换分支', YELLOW);
    this.switchingBranch = !!branch;
    if (branch) this.say('正在切换 Git 分支…');
    this.branchOperation = (async () => {
      if (!branch) {
        const branches = await listGitBranches(this.cwd);
        if (this.branch !== branches.current) this.files = undefined;
        this.branch = branches.current;
        this.branchView = { ...branches, offset: Math.max(0, branches.local.indexOf(branches.current ?? '')) };
        return;
      }
      try {
        await switchGitBranch(this.cwd, branch);
        this.say(`已切换到 ${branch}`, GOLD);
      } finally {
        const current = await currentGitBranch(this.cwd).catch(() => undefined);
        if (current !== this.branch || current === branch) this.files = undefined;
        this.branch = current;
      }
    })().catch((err: Error) => this.say(err.message.replace(/\s*\r?\n\s*/g, ' '), RED))
      .finally(() => {
        this.branchOperation = undefined;
        this.switchingBranch = false;
        this.requestRender();
      });
  }

  private command(line: string): void {
    const branch = /^\/branch(?:[ \t]+(.*))?$/.exec(line);
    if (branch) return this.changeBranch(branch[1] ?? '');
    const [name, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ');
    if (name === 'settings') {
      if (arg) return this.say('请单独输入 /settings', YELLOW);
      if (this.busy) return this.say('请等待本轮结束后修改设置', YELLOW);
      this.settings = new SettingsView(
        this.cwd, this.modelTests,
        () => ({ cfg: this.cfg, targets: this.all, selected: this.selected, showReasoning: this.showReasoning, mouse: this.mouseOn }),
        (field, value, entry) => this.applySetting(field, value, entry),
        () => {
          this.api = new ApiView(this.cfg, (api, profile) => {
            this.useApi(api, profile);
            this.settings = undefined;
          }, () => { this.api = undefined; });
        },
        () => { this.settings = undefined; },
        () => this.requestRender(),
      );
    }
    else if (name === 'bench') {
      if (this.busy || !this.lastRun) return this.say('请先完成一轮问答', YELLOW);
      try {
        const pane = this.findPane(this.focus);
        const source = pane?.kind === 'exec' ? this.lastExecution : this.lastRun;
        if (!source) return this.say('没有可保存的实施记录', YELLOW);
        const call = pane?.kind === 'synth' ? source.synthesis?.result.runId
          : source.results.find(r => r.targetId === pane?.targetId)?.runId;
        const item = capture(this.cwd, source.id, call, line.slice('/bench'.length).trim());
        this.say('已留作评测候选 ' + item.id + ' · unify bench help 查看出题用法', GOLD);
      } catch (e) { this.say(e instanceof Error ? e.message : String(e), RED); }
    }
    else if (name === 'exec') this.startExec(arg || undefined);
    else if (name === 'use') {
      if (!this.lastRun) return this.say('还没有可沿用的上一轮回答', YELLOW);
      if (!arg) {
        this.continueFrom = undefined;
        return this.say('下轮追问将恢复默认上下文');
      }
      const ok = arg === 'synthesis'
        ? !!(this.lastRun.synthesis?.result.ok && this.lastRun.synthesis.result.text.trim())
        : this.lastRun.results.some((r) => r.targetId === arg && r.ok && r.text.trim());
      if (!ok) return this.say(`上一轮中没有来自 "${arg}" 的可用回答`, RED);
      this.continueFrom = arg;
      this.say(`下轮追问将沿用「${arg}」的回答（输入 /use 重置）`, GOLD);
    }
    else if (name === 'cancel') {
      if (!this.busy) return this.say('没有正在运行的请求');
      if (!arg) return this.interrupt();
      if (!this.active?.cancelTarget(arg)) return this.say(`目标 ${arg} 未在回答`, YELLOW);
      this.say(`已取消 ${arg}`, YELLOW);
    } else if (name === 'retry') {
      if (this.busy) return this.say('请先等待当前请求结束', YELLOW);
      if (!this.lastRun) return this.say('没有可重试的记录', YELLOW);
      const ids = arg ? arg.split(/[,\s]+/) : this.lastRun.targets.filter((t) => !this.lastRun!.results.find((r) => r.targetId === t.id)?.ok).map((t) => t.id);
      if (!ids.length) return this.say('没有失败目标；用 /retry 目标 指定重新回答');
      void this.ask(this.lastRun.question, ids);
    }
    else if (name === 'new') this.newConversation();
    else if (name === 'copy') this.copy();
    else if (name === 'help') this.help = true;
    else if (name === 'quota') this.quotaDetails = true;
    else if (name === 'memory') {
      if (arg === 'web') this.memoryWeb().then((url) => this.say(`记忆管理界面（仅本机）: ${url}`, GOLD), (err) => this.say(`无法启动记忆管理界面: ${err instanceof Error ? err.message : err}`, RED));
      else this.openMemory();
    }
    else if (name === 'quit' || name === 'exit') this.onQuit();
    else if (name === 'models') {
      if (!arg) return this.say(`当前: ${this.selected.join(', ') || '无'}    用法: /models claude,codex`);
      const ids = arg.split(/[,\s]+/).filter(Boolean);
      if (new Set(ids).size !== ids.length) return this.say('不能重复选择同一个目标；请在 targets 中配置不同模型', RED);
      const bad = ids.find((id) => !this.installed.get(id));
      if (bad) return this.say(`"${bad}" 不可用（未安装或不存在）`, RED);
      this.selected = ids;
      this.manualModels = true;
      this.say(`之后的问题将发给: ${ids.join(', ')}`);
    } else if (name === 'mouse') {
      this.mouseOn = !this.mouseOn;
      this.io.setMouse?.(this.mouseOn);
      this.say(this.mouseOn ? '鼠标滚轮已开启（选择文本请按住 Shift 拖动）' : '鼠标已关闭，可直接拖动选择文本');
    } else if (name === 'synth') {
      if (!this.installed.get(arg)) return this.say(`"${arg}" 不可用`, RED);
      this.sessionSynth = arg;
      this.cfg = { ...this.cfg, synthesizer: arg };
      this.say(`汇总模型: ${arg}`);
    } else {
      this.say(`未知命令 /${name}；输入 / 查看命令列表，/help 查看快捷键`, YELLOW);
    }
  }

  // ── input ────────────────────────────────────────────────────────────────
  handleKey(k: Key): void {
    const branches = this.branchView;
    if (branches) {
      if (k.name === 'ctrl+d') return this.onQuit();
      if (k.name === 'esc' || k.name === 'ctrl+c' || k.name === 'enter') {
        this.branchView = undefined;
      } else if (k.name === 'up' || k.name === 'wheelup') {
        branches.offset--;
      } else if (k.name === 'down' || k.name === 'wheeldown') {
        branches.offset++;
      }
      return this.requestRender();
    }
    const view = this.api ?? this.settings;
    if (view) {
      if (k.name === 'ctrl+d') return this.onQuit();
      view.handleKey(k);
      return this.requestRender();
    }
    if (this.quotaDetails && this.quota) {
      if (k.name === 'ctrl+d') return this.onQuit();
      if (k.name === 'esc' || k.name === 'ctrl+c' || (k.name === 'char' && k.text === 'q')) {
        this.quotaDetails = false;
      } else this.quota.handleKey(k);
      return this.requestRender();
    }
    if (this.mem) {
      if (k.name === 'ctrl+d') return this.onQuit();
      this.mem.handleKey(k);
      return this.requestRender();
    }
    if (k.name === 'wheelup' || k.name === 'wheeldown' || k.name === 'click') {
      this.mouse(k);
      return this.requestRender();
    }
    this.notice = '';
    if (k.name !== 'ctrl+c') this.quitArmed = 0;
    if (this.help) {
      this.help = false;
      if (k.name !== 'ctrl+c' && k.name !== 'ctrl+d') return this.requestRender();
    }
    if (this.confirm) {
      const c = this.confirm;
      this.confirm = undefined;
      if (k.name === 'char' && /^[yY]$/.test(k.text ?? '')) c.yes();
      else this.say('已取消');
      return this.requestRender();
    }
    const typing = this.focus === 'input';
    switch (k.name) {
      case 'ctrl+c':
        if (this.busy) this.interrupt();
        else if (!this.ed.empty) this.ed.clear();
        else if (Date.now() - this.quitArmed < 2000) this.onQuit();
        else {
          this.quitArmed = Date.now();
          this.say('再按一次 Ctrl+C 退出', YELLOW);
        }
        break;
      case 'ctrl+d':
        if (typing && !this.ed.empty) this.ed.del();
        else this.onQuit();
        break;
      case 'tab':
      case 'shifttab':
        if (typing && this.comp) this.accept();
        else this.cycleFocus(k.name === 'tab' ? 1 : -1);
        break;
      case 'ctrl+e':
        if (typing && !this.ed.empty) this.ed.end();
        else this.startExec();
        break;
      case 'ctrl+y':
        this.copy();
        break;
      case 'ctrl+n':
        this.newConversation();
        break;
      case 'ctrl+r':
        this.showReasoning = !this.showReasoning;
        this.say(this.showReasoning ? '显示思考过程' : '隐藏思考过程');
        break;
      case 'pgup':
      case 'pgdn':
        this.scrollPane(this.findPane(this.focus) ?? this.bottomPane() ?? this.panes[this.activeAnswer], k.name === 'pgup' ? -1 : 1, true);
        break;
      default:
        if (typing) this.inputKey(k);
        else this.paneKey(k);
    }
    this.suggest(EDITING.has(k.name));
    this.requestRender();
  }

  /** Recompute the completion popup for the text at the caret. */
  private suggest(edited: boolean): void {
    if (edited) this.compOff = false;
    let c: Completion | undefined;
    if (this.focus === 'input' && !this.compOff && !this.ed.empty) {
      const targets = this.all.filter((t) => this.installed.get(t.id)).map((t) => ({ id: t.id, label: t.label, exec: t.adapter.capabilities.exec }));
      c = complete(this.ed.chars, this.ed.caret, targets, () => (this.files ??= listFiles(this.cwd)));
      // Keep exact command matches visible; completed arguments need no popup.
      if (c && c.kind === 'argument' && c.items.length === 1 && c.items[0].value === this.ed.chars.slice(c.start, c.end).join('')) c = undefined;
    }
    const same = !!c && !edited && this.comp?.kind === c.kind && this.comp.start === c.start;
    this.compIdx = same ? clamp(this.compIdx, 0, c!.items.length - 1) : 0;
    this.comp = c;
  }

  /** Apply the highlighted suggestion. Returns whether the text changed. */
  private accept(): boolean {
    const c = this.comp;
    const item = c?.items[this.compIdx];
    if (!c || !item) return false;
    const current = this.ed.chars.slice(c.start, c.end).join('');
    const value = c.kind === 'command' && !/\s/.test(this.ed.chars[c.end] ?? '') ? `${item.value} ` : item.value;
    this.ed.replace(c.start, c.end, value);
    this.compOff = false;
    return item.value !== current;
  }

  private mouse(k: Key): void {
    const x = k.x ?? -1;
    const y = k.y ?? -1;
    const hit = this.rects.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    if (k.name === 'click') {
      if (this.confirm) return;
      if (hit) {
        this.focus = hit.id;
        const ai = this.panes.findIndex((p) => p.id === hit.id);
        if (ai >= 0) this.activeAnswer = ai;
      } else if (y >= this.inputTop) this.focus = 'input';
      return;
    }
    // The wheel scrolls whatever is under the pointer, without moving focus.
    const pane = hit ? this.findPane(hit.id) : (this.bottomPane() ?? this.panes[this.activeAnswer]);
    for (let n = 0; n < 3; n++) this.scrollPane(pane, k.name === 'wheelup' ? -1 : 1);
  }

  private focusOrder(): string[] {
    return ['input', ...this.panes.map((p) => p.id), ...(this.synth ? ['synth'] : []), ...(this.exec ? ['exec'] : [])];
  }

  private cycleFocus(dir: number): void {
    const order = this.focusOrder();
    const i = Math.max(0, order.indexOf(this.focus));
    this.focus = order[(i + dir + order.length) % order.length];
    const ai = this.panes.findIndex((p) => p.id === this.focus);
    if (ai >= 0) this.activeAnswer = ai;
    if (this.zoomId) this.zoomId = this.focus === 'input' ? undefined : this.focus;
  }

  private findPane(id: string): Pane | undefined {
    return id === 'synth' ? this.synth : id === 'exec' ? this.exec : this.panes.find((p) => p.id === id);
  }

  /** The pane shown in the lower region: the synthesis, or the execution once it exists. */
  private bottomPane(): Pane | undefined {
    if (this.focus === 'synth') return this.synth;
    return this.exec ?? this.synth;
  }

  private scrollPane(p: Pane | undefined, dir: number, page = false): void {
    if (!p) return;
    const top = (p.follow ? p.maxScroll : p.scroll) + dir * (page ? Math.max(1, p.viewH - 2) : 1);
    p.scroll = clamp(top, 0, p.maxScroll);
    p.follow = p.scroll >= p.maxScroll;
  }

  private paneKey(k: Key): void {
    const p = this.findPane(this.focus);
    if (!p) {
      this.focus = 'input';
      return;
    }
    const ch = k.name === 'char' ? k.text : '';
    if (k.name === 'up' || ch === 'k') this.scrollPane(p, -1);
    else if (k.name === 'down' || ch === 'j') this.scrollPane(p, 1);
    else if (ch === ' ') this.scrollPane(p, 1, true);
    else if (k.name === 'home' || ch === 'g') {
      p.scroll = 0;
      p.follow = p.maxScroll === 0;
    } else if (k.name === 'end' || ch === 'G') p.follow = true;
    else if (k.name === 'enter' || ch === 'z') this.zoomId = this.zoomId ? undefined : p.id;
    else if (ch === 'y') this.copy();
    else if (ch === 'b') this.command('/bench');
    else if (ch === 'u' && (p.kind === 'answer' || p.kind === 'synth')) {
      if (p.status !== 'ok' || !p.text.trim()) return this.say('该回答尚未完成，无法作为追问上下文', YELLOW);
      this.continueFrom = p.kind === 'synth' ? 'synthesis' : p.targetId;
      this.zoomId = undefined;
      this.focus = 'input';
      this.say(`下轮追问将沿用「${p.title}」的回答（输入 /use 重置）`, GOLD);
    }
    else if (k.name === 'esc' || ch === 'i') {
      if (this.zoomId) this.zoomId = undefined;
      else this.focus = 'input';
    }
  }

  private inputKey(k: Key): void {
    const ed = this.ed;
    switch (k.name) {
      case 'char':
      case 'paste':
        ed.insert(k.text ?? '');
        break;
      case 'altenter':
      case 'ctrl+j':
        ed.insert('\n');
        break;
      case 'enter': {
        const c = this.comp;
        if (c && this.accept()) {
          // A completed command runs at once unless it still needs its argument.
          const spec = c.kind === 'command' ? COMMANDS.find((v) => `/${v.name}` === c.items[this.compIdx].value) : undefined;
          if (!spec || spec.required) break;
        }
        this.submit();
        break;
      }
      case 'esc':
        if (this.comp) this.compOff = true;
        else if (this.busy) this.interrupt();
        break;
      case 'backspace':
        ed.backspace();
        break;
      case 'delete':
        ed.del();
        break;
      case 'left':
      case 'ctrl+b':
        ed.left();
        break;
      case 'right':
      case 'ctrl+f':
        ed.right();
        break;
      case 'wordleft':
        ed.wordLeft();
        break;
      case 'wordright':
        ed.wordRight();
        break;
      case 'wordback':
      case 'ctrl+w':
        ed.deleteWordBack();
        break;
      case 'worddel':
        ed.deleteWordForward();
        break;
      case 'home':
      case 'ctrl+a':
        ed.home();
        break;
      case 'end':
        ed.end();
        break;
      case 'ctrl+u':
        ed.killToStart();
        break;
      case 'ctrl+k':
        ed.killToEnd();
        break;
      case 'up':
      case 'down': {
        const dir = k.name === 'up' ? -1 : 1;
        if (this.comp) {
          const n = this.comp.items.length;
          this.compIdx = (this.compIdx + dir + n) % n;
          break;
        }
        if (ed.vertical(dir)) break;
        const next = clamp(this.histIdx + dir, 0, this.history.length);
        if (next === this.histIdx) break;
        if (this.histIdx === this.history.length) this.draft = ed.text;
        this.histIdx = next;
        ed.set(this.history[next] ?? this.draft);
        this.compOff = true; // arrows keep walking history rather than a popup
        break;
      }
    }
  }

  private submit(): void {
    const raw = this.ed.text.trimStart();
    const text = /^\/branch(?:[ \t]|$)/.test(raw) ? raw.replace(/[ \t\r\n]+$/, '') : raw.trimEnd();
    if (!text) return;
    if (this.switchingBranch && !text.startsWith('/')) return this.say('正在切换 Git 分支，请稍候', YELLOW);
    if (!/^\/settings\s/.test(text) && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.histIdx = this.history.length;
    this.draft = '';
    this.ed.clear();
    if (text.startsWith('/')) return this.command(text);
    if (this.busy) return void this.queue.push(text);
    void this.ask(text);
  }

  // ── rendering ────────────────────────────────────────────────────────────
  render(): void {
    if (this.disposed) return;
    const s = this.compose();
    this.last = s;
    const lines = s.toLines();
    let out = '\x1b[?2026h';
    if (this.prev.length !== lines.length || this.prevCols !== s.cols) {
      out += '\x1b[2J';
      this.prev = [];
    }
    lines.forEach((l, i) => {
      if (l !== this.prev[i]) out += `\x1b[${i + 1};1H${l}`;
    });
    out += this.cursor ? `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h` : '\x1b[?25l';
    out += '\x1b[?2026l';
    this.io.write(out);
    this.prev = lines;
    this.prevCols = s.cols;
  }

  private compose(): Screen {
    const cols = Math.max(40, this.io.cols());
    const rows = Math.max(12, this.io.rows());
    const s = new Screen(cols, rows);
    this.cursor = null;
    this.rects = [];
    if (this.branchView) {
      this.drawBranches(s, this.branchView);
      return s;
    }
    const view = this.api ?? this.settings;
    if (view) {
      view.draw(s);
      return s;
    }
    if (this.quotaDetails && this.quota) {
      this.quota.draw(s);
      return s;
    }
    if (this.mem) {
      this.cursor = this.mem.draw(s);
      return s;
    }
    this.drawHeader(s);
    const inputH = this.drawInput(s);
    this.drawFooter(s);
    this.drawBody(s, 2, rows - 3 - inputH);
    this.drawPopup(s);
    return s;
  }

  private drawBranches(s: Screen, branches: GitBranches & { offset: number }): void {
    const { current, local } = branches;
    const limit = s.rows - 5;
    branches.offset = clamp(branches.offset, 0, Math.max(0, local.length - limit));
    s.put(1, 0, '本地 Git 分支', '1;' + GOLD);
    s.put(1, 1, truncate(`当前分支 · ${current ?? '游离 HEAD'}`, s.cols - 2), DIM);
    if (!local.length) s.put(1, 3, '暂无本地分支', DIM);
    local.slice(branches.offset, branches.offset + limit).forEach((name, row) => {
      const selected = name === current;
      s.put(1, row + 3, truncate((selected ? '* ' : '  ') + name, s.cols - 2), selected ? GOLD : '');
    });
    s.put(1, s.rows - 2, '↑↓ 滚动 · Esc 返回', DIM);
    s.put(1, s.rows - 1, '使用 /branch 分支名 切换', DIM);
  }

  private drawHeader(s: Screen): void {
    let x = s.put(1, 0, '✦ unify', `1;${GOLD}`) + 2;
    for (const a of this.all) {
      if (this.installed.get(a.id) === false) continue;
      const known = this.installed.has(a.id);
      const on = this.selected.includes(a.id);
      // The decider does not answer; it is shown as the diamond that routes the others.
      const deciding = a.id === this.cfg.decider && !on && this.installed.get(a.id) === true;
      const color = deciding ? GOLD : on ? this.colorOf(a.id) : DIM;
      x = s.put(x, 0, !known ? SPIN[this.frame % 10] : deciding ? '◆' : on ? '●' : '○', color);
      x = s.put(x + 1, 0, deciding ? `${a.label} 决策` : a.label, color) + 2;
    }
    if (this.question) {
      s.put(1, 1, '❯', GOLD);
      s.put(3, 1, truncate(this.question.replace(/\s+/g, ' '), s.cols - 4), '1');
    }
  }

  /** Draws the activity line, queued messages and composer above the footer; returns their height. */
  private drawInput(s: Screen): number {
    const inner = s.cols - 3;
    // Wrap the input manually so the caret position is known exactly.
    const { chars, caret } = this.ed;
    const lines: Cell[][] = [[]];
    let cx = 0;
    let cy = 0;
    let w = 0;
    chars.forEach((ch, i) => {
      if (i === caret) [cx, cy] = [w, lines.length - 1];
      const cw = ch === '\n' ? 0 : charWidth(ch.codePointAt(0)!);
      if (ch === '\n' || w + cw > inner) {
        lines.push([]);
        w = 0;
      }
      if (ch !== '\n') {
        lines[lines.length - 1].push({ ch, st: '', w: cw });
        w += cw;
      }
      // A caret sitting right after a newline belongs to the new line.
      if (ch === '\n' && i + 1 === caret) [cx, cy] = [0, lines.length - 1];
    });
    if (caret >= chars.length) [cx, cy] = [w, lines.length - 1];
    if (cx >= inner) [cx, cy] = [0, cy + 1];
    while (lines.length <= cy) lines.push([]);

    const h = Math.min(Math.max(3, Math.floor(s.rows / 3)), lines.length);
    const first = clamp(cy - h + 1, 0, lines.length - h);
    const queued = this.queue.slice(0, 3);
    const y = s.rows - 1 - (h + 2);
    const top = y - 1 - queued.length;
    this.inputTop = top;
    const active = this.focus === 'input' && !this.confirm;
    const st = active ? GOLD : BORDER;

    this.drawActivity(s, top);
    queued.forEach((q, i) => {
      const more = i === 2 && this.queue.length > 3 ? ` (+${this.queue.length - 3})` : '';
      s.put(1, top + 1 + i, truncate(`↳ 已排队${more}  ${q.replace(/\s+/g, ' ')}`, s.cols - 2), DIM);
    });
    s.put(0, y, '─'.repeat(s.cols), st);
    s.put(0, y + h + 1, '─'.repeat(s.cols), st);
    if (first === 0) s.put(0, y + 1, '❯', active ? GOLD : DIM);
    for (let i = 0; i < h; i++) s.putCells(2, y + 1 + i, lines[first + i], s.cols - 1);
    if (chars.length === 0) {
      const hint = this.busy
        ? '继续输入会排队，本轮结束后发送…'
        : this.continueFrom
          ? `沿用「${this.continueFrom}」继续追问…（输入 /use 重置）`
          : this.turn === 0
            ? '问点什么…  / 命令 · @ 引用文件'
            : '继续追问，或输入 /exec 让模型按方案动手';
      s.put(2, y + 1, truncate(hint, inner), DIM);
    }
    if (active) this.cursor = { x: 2 + cx, y: y + 1 + (cy - first) };
    return h + 3 + queued.length;
  }

  /** One line above the composer: confirmation, notice, what is running, or key hints. */
  private drawActivity(s: Screen, y: number): void {
    if (this.confirm) return void s.put(1, y, truncate(this.confirm.text, s.cols - 2), `1;${YELLOW}`);
    if (this.notice) return void s.put(1, y, truncate(this.notice, s.cols - 2), this.noticeColor);
    if (this.busy) {
      const done = this.panes.filter((p) => p.status !== 'run').length;
      const stage = this.exec?.status === 'run' ? '实施中' : this.synth?.status === 'run' ? '汇总中' : this.panes.length ? `回答中 ${done}/${this.panes.length}` : '准备中';
      let x = s.put(1, y, SPIN[this.frame % 10], GOLD);
      x = s.put(x + 1, y, stage, '1');
      s.put(x + 1, y, truncate(`${Math.floor((Date.now() - this.busySince) / 1000)}s · Esc 中断${this.queue.length ? ` · ${this.queue.length} 条排队` : ''}`, s.cols - x - 2), DIM);
      return;
    }
    const hints =
      this.focus === 'input'
        ? this.panes.length
          ? ['Tab 切换面板', 'Ctrl+E 实施', 'Ctrl+Y 复制', 'Ctrl+R 思考', 'Ctrl+N 新对话', '/help 帮助']
          : ['Enter 发送', 'Shift+Enter/Ctrl+J 换行', '/quota 套餐余量', '/ 命令', '@ 文件', '/help 帮助']
        : ['↑↓/滚轮 滚动', 'Enter 放大', 'u 沿此继续', 'b 留题', 'y 复制', 'Ctrl+E 按此实施', 'Esc 返回'];
    let x = 1;
    for (const h of hints) {
      if (x + textWidth(h) + 3 > s.cols) break;
      const [key, ...rest] = h.split(' ');
      x = s.put(x, y, key, '');
      x = s.put(x, y, ' ' + rest.join(' '), DIM) + 3;
    }
  }

  /** Status line: where we are, who answers, what the session has used. */
  private drawFooter(s: Screen): void {
    const y = s.rows - 1;
    const used = this.tokens.input + this.tokens.output;
    const right = [used ? `↑${kilo(this.tokens.input)} ↓${kilo(this.tokens.output)}` : '', this.turn > 1 ? `第 ${this.turn} 轮` : ''].filter(Boolean).join(' · ');
    const rx = s.cols - textWidth(right) - 1;
    if (right) s.put(rx, y, right, DIM);
    const home = homedir();
    const branch = this.branch === undefined ? '' : ` (${this.branch ?? '游离 HEAD'})`;
    const where = (this.cwd === home || this.cwd.startsWith(home + '/') ? '~' + this.cwd.slice(home.length) : this.cwd) + branch;
    const who = this.selected.length ? `${this.selected.join(' + ')}${this.cfg.synthesizer && this.selected.length > 1 ? ` → ${this.cfg.synthesizer}` : ''}` : '';
    const room = (right ? rx : s.cols) - 2;
    const left = textWidth(where) + textWidth(who) + 3 <= room ? where : basename(this.cwd) + branch;
    const x = s.put(1, y, truncate(left, room), DIM);
    if (who && x + 3 + textWidth(who) <= room + 1) s.put(s.put(x, y, ' · ', BORDER), y, who, DIM);
  }

  /** Completion list floating over the body, directly above the activity line. */
  private drawPopup(s: Screen): void {
    const c = this.comp;
    if (!c || this.focus !== 'input' || this.confirm) return;
    const n = Math.min(c.items.length, 8, Math.max(1, this.inputTop - 3));
    const first = clamp(this.compIdx - n + 1, 0, Math.max(0, c.items.length - n));
    const labelW = Math.min(Math.max(...c.items.map((i) => textWidth(i.label))), c.kind === 'file' ? s.cols - 6 : 24);
    const y0 = this.inputTop - n;
    s.put(0, y0 - 1, '─'.repeat(s.cols), BORDER);
    for (let i = 0; i < n; i++) {
      const item = c.items[first + i];
      const on = first + i === this.compIdx;
      s.put(0, y0 + i, ' '.repeat(s.cols));
      s.put(1, y0 + i, on ? '›' : ' ', GOLD);
      const x = s.put(3, y0 + i, truncate(item.label, labelW), on ? `1;${GOLD}` : '', s.cols - 1);
      if (item.detail) s.put(Math.max(x, 3 + labelW) + 2, y0 + i, truncate(item.detail, Math.max(0, s.cols - labelW - 7)), DIM, s.cols - 1);
    }
    if (c.items.length > n) s.put(s.cols - 12, y0 - 1, ` ${this.compIdx + 1}/${c.items.length} `, DIM);
  }

  private drawHelp(s: Screen, y: number, h: number): void {
    const keys: [string, string][] = [
      ['Enter', '发送；生成中发送会排队，本轮结束后自动发出'],
      ['Shift+Enter / Alt+Enter / Ctrl+J', '换行'],
      ['Esc', '中断本轮（排队的消息放回输入框）'],
      ['Ctrl+C', '中断本轮；空闲时清空输入，输入为空时连按两次退出'],
      ['↑ ↓', '多行内移动；到首/末行时翻阅历史'],
      ['Ctrl+A/E · Alt+←/→ · Ctrl+W · Ctrl+U/K', '行首/行尾 · 按词移动 · 删词 · 删到行首/行尾'],
      ['@', '模糊搜索并引用项目文件'],
      ['Tab', '接受补全；否则在输入框与各面板间切换'],
      ['Ctrl+R · Ctrl+Y · Ctrl+N', '显示思考 · 复制 · 新对话'],
      ['Ctrl+E', '输入为空时：按汇总或聚焦的回答实施'],
    ];
    const rows: [string, string][] = [...keys, ['', ''], ...COMMANDS.map((c): [string, string] => [`/${c.name}`, c.detail])];
    const kw = Math.min(Math.max(...rows.map((r) => textWidth(r[0]))), Math.floor(s.cols / 2));
    s.put(2, y, '快捷键与命令', `1;${GOLD}`);
    rows.slice(0, h - 3).forEach(([key, text], i) => {
      s.put(2, y + 2 + i, truncate(key, kw), '');
      s.put(4 + kw, y + 2 + i, truncate(text, Math.max(0, s.cols - kw - 6)), DIM);
    });
    s.put(2, y + h - 1, '按任意键返回', DIM);
  }

  private drawBody(s: Screen, y: number, h: number): void {
    if (this.help) return this.drawHelp(s, y, h);
    if (this.panes.length === 0) return this.drawWelcome(s, y, h);
    const bottom = this.bottomPane();
    const zoomed = this.zoomId ? this.findPane(this.zoomId) : undefined;
    if (zoomed) return this.drawPane(s, 0, y, s.cols, h, zoomed, true);
    if (h < 12) {
      // Too short to split: show one pane at a time.
      const one = this.findPane(this.focus) ?? bottom ?? this.panes[this.activeAnswer];
      return this.drawPane(s, 0, y, s.cols, h, one, this.focus === one.id);
    }
    // Before the synthesis the answers own the screen; afterwards they step
    // back and the converged answer takes the larger share.
    const ah = bottom ? clamp(Math.round(h * 0.4), 5, h - 6) : h;
    const n = this.panes.length;
    if (Math.floor(s.cols / n) < 30) {
      const p = this.panes[this.activeAnswer];
      this.drawPane(s, 0, y, s.cols, ah, p, this.focus === p.id, `${this.activeAnswer + 1}/${n} · Tab 切换`);
    } else {
      const w = Math.floor(s.cols / n);
      this.panes.forEach((p, i) => {
        this.drawPane(s, i * w, y, i === n - 1 ? s.cols - i * w : w, ah, p, this.focus === p.id);
      });
    }
    if (bottom) this.drawPane(s, 0, y + ah, s.cols, h - ah, bottom, this.focus === bottom.id);
  }

  private drawWelcome(s: Screen, y: number, h: number): void {
    const targets = this.all.filter((a) => this.installed.get(a.id) !== false);
    const n = targets.length;
    const nameW = Math.min(Math.max(1, ...targets.map((a) => textWidth(a.label))), Math.floor(s.cols / 3));
    const mid = Math.floor((n - 1) / 2);
    const showDiagram = s.cols - nameW >= 48;
    const quotaOffset = 2 + nameW + (showDiagram ? 18 : 2);
    const blockW = Math.min(s.cols - 2, quotaOffset + 52);
    const x0 = Math.floor((s.cols - blockW) / 2);
    const quotaW = blockW - quotaOffset;
    const blockH = n + 4;
    let row = y + Math.max(0, Math.floor((h - blockH) / 2));
    for (const [i, a] of targets.entries()) {
      if (row >= y + h) break;
      const on = this.selected.includes(a.id);
      const known = this.installed.has(a.id);
      const color = on ? this.colorOf(a.id) : BORDER;
      const tag = a.id === this.cfg.decider ? '决策' : '';
      s.put(x0, row, !known ? SPIN[this.frame % 10] : on ? '●' : '○', color);
      s.put(x0 + 2, row, truncate(a.label, nameW), on ? `1;${color}` : DIM);
      if (showDiagram) {
        const joint = n === 1 ? '─' : i === mid ? (i === 0 ? '┬' : i === n - 1 ? '┴' : '┼') : i === 0 ? '╮' : i === n - 1 ? '╯' : '┤';
        const x = s.put(x0 + 3 + nameW, row, '──' + joint, color === BORDER ? BORDER : DIM);
        if (i === mid) s.put(s.put(x, row, '──▶ ', DIM), row, '✦ 最优解', `1;${GOLD}`);
        else if (tag) s.put(x + 1, row, tag, GOLD);
      }
      const summary = this.quota?.summary(a.id, quotaW) ?? '余量查询中…';
      const end = s.put(x0 + quotaOffset, row, truncate(summary, quotaW), DIM);
      if ((!showDiagram || i === mid) && tag && end + 2 + textWidth(tag) <= x0 + blockW) {
        s.put(end + 2, row, tag, GOLD);
      }
      row++;
    }
    const center = (text: string, st: string, at: number) => {
      if (at < y + h) s.put(Math.max(1, Math.floor((s.cols - textWidth(text)) / 2)), at, truncate(text, s.cols - 2), st);
    };
    center('一个问题 · 多个模型 · 一份最优解', '', row + 1);
    center('输入 /settings 接入官方 API', DIM, row + 2);
  }

  private drawPane(s: Screen, x: number, y: number, w: number, h: number, p: Pane, focused: boolean, hint = ''): void {
    this.rects.push({ id: p.id, x, y, w, h });
    const bst = focused ? p.color : BORDER;
    const right = x + w - 1;
    const innerW = Math.max(4, w - 4);
    const innerH = Math.max(1, h - 2);

    // content
    let body = p.text;
    if (p.error) body += `${body ? '\n\n' : ''}✗ ${p.error}`;
    const key = `${body.length}|${p.reasoning.length}|${innerW}|${this.showReasoning}`;
    if (p.cache?.key !== key) {
      const lines = this.showReasoning && p.reasoning.trim() ? [...layout(p.reasoning.trim(), innerW, p.color, true), []] : [];
      if (body) lines.push(...layout(body, innerW, p.color));
      p.cache = { key, lines };
    }
    const lines = p.cache.lines;
    p.viewH = innerH;
    p.maxScroll = Math.max(0, lines.length - innerH);
    if (p.follow) p.scroll = p.maxScroll;
    p.scroll = clamp(p.scroll, 0, p.maxScroll);

    // frame
    s.put(x, y, '╭' + '─'.repeat(w - 2) + '╮', bst);
    s.put(x, y + h - 1, '╰' + '─'.repeat(w - 2) + '╯', bst);
    const thumbH = p.maxScroll ? Math.max(1, Math.round((innerH * innerH) / lines.length)) : 0;
    const thumbY = p.maxScroll ? Math.round(((innerH - thumbH) * p.scroll) / p.maxScroll) : 0;
    for (let i = 0; i < innerH; i++) {
      const onThumb = thumbH > 0 && i >= thumbY && i < thumbY + thumbH;
      s.put(x, y + 1 + i, '│', bst);
      s.put(right, y + 1 + i, onThumb ? '┃' : '│', onThumb ? p.color : bst);
      const line = lines[p.scroll + i];
      if (line) s.putCells(x + 2, y + 1 + i, line, right - 1);
    }
    if (lines.length === 0 && p.status === 'run') {
      s.put(x + 2, y + 1, truncate(p.tool ? `正在使用 ${p.tool}…` : '等待响应…', innerW), DIM, right - 1);
    }

    // title
    const elapsed = secs((p.end ?? Date.now()) - p.start);
    const icon = p.status === 'run' ? SPIN[this.frame % 10] : p.status === 'ok' ? (p.kind === 'answer' ? '●' : '✦') : '✗';
    const status =
      p.status === 'run'
        ? `${elapsed}${p.tool ? ` · ${p.tool}` : ''}`
        : p.status === 'ok'
          ? `${elapsed} · ${Array.from(p.text).length} 字`
          : `${elapsed} · ${p.status === 'cancelled' ? '已取消' : p.status === 'timed_out' ? '超时' : '失败'}`;
    let tx = s.put(x + 2, y, ' ', '', right);
    tx = s.put(tx, y, icon + ' ', p.status === 'err' ? RED : p.color, right - 1);
    tx = s.put(tx, y, p.title, `1;${p.color}`, right - 1);
    tx = s.put(tx, y, `  ${status} `, DIM, right - 1);
    if (hint && tx + textWidth(hint) + 4 < right) s.put(right - textWidth(hint) - 3, y, ` ${hint} `, DIM, right - 1);

    const footY = y + h - 1;
    const pos = p.maxScroll ? ` ${Math.min(lines.length, p.scroll + innerH)}/${lines.length} ` : '';
    const footEnd = right - 1 - textWidth(pos);
    const available = Math.max(1, footEnd - x - 4);
    const quota = this.quota?.summary(p.targetId, available) ?? '余量查询中…';
    s.put(x + 2, footY, ` ${quota} `, DIM, footEnd);
    if (pos) s.put(footEnd, footY, pos, DIM, right - 1);
  }
}

// Wheel and click reporting in SGR coordinates. Native text selection then needs Shift+drag.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/** Run the full-screen interface until the user quits. */
export async function runTui(cwd: string, signal?: AbortSignal, open?: 'memory'): Promise<number> {
  const out = process.stdout;
  const stdin = process.stdin;
  if (!out.isTTY || !stdin.isTTY) throw new Error('交互界面需要在终端中运行；脚本中请使用 unify ask');

  const cfg = loadConfig(cwd);
  const app = new App(
    {
      cols: () => out.columns ?? 80,
      rows: () => out.rows ?? 24,
      write: (s) => void out.write(s),
      setMouse: (on) => void out.write(on ? MOUSE_ON : MOUSE_OFF),
    },
    cwd,
    cfg,
    Object.values(buildRegistry(cfg)),
  );
  const parser = new KeyParser();
  const restore = () => out.write(MOUSE_OFF + '\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l');

  // Request xterm modifyOtherKeys, then prefer kitty's keyboard protocol where supported.
  out.write('\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[>4;2m\x1b[>1u' + MOUSE_ON);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  process.on('exit', restore);

  return new Promise<number>((resolve) => {
    const onData = (d: string) => parser.feed(d).forEach((k) => app.handleKey(k));
    const onResize = () => app.invalidate();
    let closing = false;
    const quit = async (code = 0) => {
      if (closing) return;
      closing = true;
      stdin.off('data', onData);
      out.off('resize', onResize);
      signal?.removeEventListener('abort', onAbort);
      await app.dispose();
      stdin.setRawMode(false);
      stdin.pause();
      restore();
      process.off('exit', restore);
      resolve(code);
    };
    const onAbort = () => { void quit(130); };
    app.onQuit = () => { void quit(); };
    stdin.on('data', onData);
    out.on('resize', onResize);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else void app.init(open).catch(() => quit(1));
  });
}
