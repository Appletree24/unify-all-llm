import { deleteCollection, saveCollection } from '../../../src/bench/catalog.js';
import { candidateEvidence, capture, deleteEntry, getCandidate, getCase, getDraft, listBench, saveDraft } from '../../../src/bench/cases.js';
import { loadRun } from '../../../src/core/store.js';
import { readCacheReport } from '../../../src/core/cache-monitor.js';
import { clearMaterials, discardMaterial, stageMaterial } from './materials.js';
import type { MenuItemConstructorOptions } from 'electron';
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, Notification, screen, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../../../src/core/atomic-write.js';
import { readAgyModels } from '../../../src/providers/models.js';
import { collectQuotaReminders, type QuotaReminderHistory } from '../../../src/quota/reminders.js';
import type { ComposerSelection, Method, OpenedWorkspace, Push, QuotaNotice, Reply, TargetQuota, UnifyApi } from '../shared/api.js';
import { prepareProviderPath } from './env.js';
import { Workspace } from './workspace.js';
import { MobileShare, mobileNetworks } from '../../../src/mobile/share.js';
import { resolveComposerSelection } from '../shared/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const statePath = () => join(app.getPath('userData'), 'state.json');

interface State {
  recent: string[];
  activeWorkspace?: string;
  theme?: 'light' | 'dark';
  bounds?: { x: number; y: number; width: number; height: number; maximized?: boolean };
  quotaReminders: QuotaReminderHistory;
  composerSelections: Record<string, ComposerSelection>;
}

function parseComposerSelection(value: unknown): ComposerSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { selected, synth, graph } = value as Record<string, unknown>;
  if (selected !== undefined && (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string'))) return undefined;
  if (synth !== undefined && typeof synth !== 'string') return undefined;
  if (graph !== undefined && typeof graph !== 'string') return undefined;
  return { selected: selected && [...new Set(selected)], synth, graph };
}

function readState(): State {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    const reminders = s.quotaReminders;
    const composerSelections = Object.fromEntries(Object.entries(s.composerSelections ?? {}).flatMap(([cwd, value]) => {
      const selection = parseComposerSelection(value);
      return selection ? [[cwd, selection]] : [];
    }));
    return {
      recent: Array.isArray(s.recent) ? s.recent.filter((p: unknown) => typeof p === 'string') : [], bounds: s.bounds,
      activeWorkspace: typeof s.activeWorkspace === 'string' ? s.activeWorkspace : undefined,
      theme: s.theme === 'dark' || s.theme === 'light' ? s.theme : undefined,
      quotaReminders: reminders && typeof reminders === 'object' && !Array.isArray(reminders) ? reminders : {},
      composerSelections,
    };
  } catch { return { recent: [], quotaReminders: {}, composerSelections: {} }; }
}

function writeState(state: State): void {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    atomicWrite(statePath(), JSON.stringify(state, null, 2));
  } catch { /* Keep the current state in memory when it can't be written. */ }
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

let state: State;
let win: BrowserWindow | undefined;
let workspace: Workspace | undefined;
let mobileShare: MobileShare | undefined;
const workspaces = new Map<string, Workspace>();
let quitting = false;
let pendingQuotaNotice: QuotaNotice | undefined;
let activeQuotaNotification: Notification | undefined;

let activeInteractionNotification: Notification | undefined;

const push = (p: Push) => {
  if (p.type === 'run' && mobileShare?.ws.cwd === p.cwd) mobileShare.update(p.record);
  if (win && !win.isDestroyed()) win.webContents.send('unify:push', p);
  if (p.type === 'interaction' && !win?.isFocused() && Notification.isSupported()) {
    try {
      activeInteractionNotification?.close();
      const body = p.request.detail ? `${p.request.title}\n${p.request.detail.slice(0, 120)}` : p.request.title;
      const notification = activeInteractionNotification = new Notification({
        title: `${p.targetLabel} 等待交互确认`,
        body,
      });
      const release = () => { if (activeInteractionNotification === notification) activeInteractionNotification = undefined; };
      notification.once('close', release);
      notification.once('failed', release);
      notification.once('click', () => {
        if (!win || win.isDestroyed()) { createWindow(); return; }
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      notification.show();
    } catch { /* The prompt is still visible inside the app window. */ }
  }
};

function stopMobileShare() {
  mobileShare?.close();
  mobileShare = undefined;
  push({ type: 'mobile-sharing', share: null });
}

function openQuotaPage(): void {
  pendingQuotaNotice = undefined;
  if (!win || win.isDestroyed()) { createWindow('quota'); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  push({ type: 'open-quota' });
}

function monitorQuota(quotas: TargetQuota[]): void {
  const { notice, history, changed } = collectQuotaReminders(quotas, state.quotaReminders);
  state.quotaReminders = history;
  if (changed) writeState(state);
  if (!notice) return;

  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) pendingQuotaNotice = notice;
  else push({ type: 'quota-notice', notice });
  if (win?.isFocused() || !Notification.isSupported()) return;

  const lines = notice.lines.slice(0, 3);
  if (notice.lines.length > lines.length) lines.push(`另有 ${notice.lines.length - lines.length} 项，点击查看额度`);
  try {
    activeQuotaNotification?.close();
    const notification = activeQuotaNotification = new Notification({ title: notice.title, body: lines.join('\n') });
    const release = () => { if (activeQuotaNotification === notification) activeQuotaNotification = undefined; };
    notification.once('close', release);
    notification.once('failed', release);
    notification.once('click', openQuotaPage);
    notification.show();
  } catch { /* The same message is available in the app. */ }
}

const palette = () => nativeTheme.shouldUseDarkColors
  ? { bg: '#0e0f11', symbol: '#c9cbd1' }
  : { bg: '#f7f7f8', symbol: '#3a3d44' };

function registerWorkspace(dir: string): string {
  const cwd = resolve(dir);
  if (!isDir(cwd)) throw new Error(`目录不存在：${cwd}`);
  if (!state.recent.includes(cwd)) state.recent.unshift(cwd);
  return cwd;
}

function knownWorkspace(cwd: string): Workspace {
  if (!state.recent.includes(cwd) || !isDir(cwd)) throw new Error(`工作区不可用：${cwd}`);
  let ws = workspaces.get(cwd);
  if (!ws) {
    ws = new Workspace(cwd, (event) => push({ ...event, cwd }), monitorQuota);
    workspaces.set(cwd, ws);
  }
  return ws;
}

function activateWorkspace(ws: Workspace): void {
  if (workspace !== ws) {
    workspace?.deactivate();
    workspace = ws;
    ws.activate();
    state.activeWorkspace = ws.cwd;
    writeState(state);
  }
}

const currentWorkspace = (cwd: string): Workspace => {
  if (!workspace || cwd !== workspace.cwd) throw new Error('项目已切换，请在当前项目中重试');
  return workspace;
};

const describeWorkspace = (ws: Workspace): OpenedWorkspace => ({
  info: ws.info(), selection: state.composerSelections[ws.cwd],
});

const api: UnifyApi = {
  async platform() { return process.platform; },
  async setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') throw new Error('请选择亮色或暗色主题');
    nativeTheme.themeSource = theme;
    state.theme = theme;
    writeState(state);
  },
  async workspace() {
    if (pendingQuotaNotice) {
      push({ type: 'quota-notice', notice: pendingQuotaNotice });
      pendingQuotaNotice = undefined;
    }
    return workspace ? describeWorkspace(workspace) : null;
  },
  async addWorkspace() {
    const picked = await dialog.showOpenDialog(win!, { title: '添加工作区', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const cwd = registerWorkspace(picked.filePaths[0]);
    writeState(state);
    return cwd;
  },
  async openWorkspace(dir, sessionId) {
    const ws = knownWorkspace(dir);
    const records = sessionId ? ws.session(sessionId) : [];
    if (sessionId && !records.length) throw new Error('找不到这段对话');
    activateWorkspace(ws);
    return { ...describeWorkspace(ws), records };
  },
  async saveComposerSelection(cwd, selection) {
    const ws = currentWorkspace(cwd);
    const parsed = parseComposerSelection(selection);
    if (!parsed) throw new Error('模型选择无效');
    state.composerSelections[ws.cwd] = parsed;
    writeState(state);
  },
  async recentWorkspaces() { return state.recent.filter(isDir); },
  async chooseGitBranch(cwd, x, y) {
    const ws = currentWorkspace(cwd);
    const { current, local } = await ws.gitBranches();
    if (workspace !== ws || !win) return;
    const owner = win;
    const selected = await new Promise<string | undefined>((resolve) => {
      let branch: string | undefined;
      const items: MenuItemConstructorOptions[] = local.map((name) => ({
        label: name.replaceAll('&', '&&'),
        type: 'checkbox',
        checked: name === current,
        enabled: name !== current,
        click: () => { branch = name; },
      }));
      if (!items.length) items.push({ label: '暂无本地分支', enabled: false });
      const menu = Menu.buildFromTemplate(items);
      menu.popup({ window: owner, x, y, callback: () => resolve(branch) });
    });
    if (selected && workspace === ws) await ws.switchBranch(selected);
  },
  async sessions(cwd) { return knownWorkspace(cwd).sessions(); },
  async mobileSharing() { return { networks: mobileNetworks(), share: mobileShare?.ready ? mobileShare.info() : null }; },
  async shareSession(cwd, id, address) {
    if (mobileShare) throw new Error('请先停止正在进行的共享');
    const ws = currentWorkspace(cwd);
    const share = new MobileShare({
      cwd, session: sessionId => ws.session(sessionId), liveTurn: turnId => ws.liveTurn(turnId),
      async ask(question, parent, signal) {
        const prefs = state.composerSelections[cwd];
        const { selected, synth, graph } = resolveComposerSelection(ws.info(), prefs);
        const result = await ws.ask({
          question, sessionId: id, expectedTurnId: parent, selected, graph, manual: prefs?.selected !== undefined,
          synthesize: synth !== 'off', synthesizer: synth && synth !== 'off' ? synth : undefined,
        }, signal);
        return result.turnId;
      },
    }, id, join(here, 'mobile'));
    mobileShare = share;
    try {
      const info = await share.listen(address);
      push({ type: 'mobile-sharing', share: info });
      return info;
    } catch (err) {
      if (mobileShare === share) stopMobileShare();
      throw err;
    }
  },
  async stopSharing(cwd, id) {
    if (mobileShare?.id === id && mobileShare.ws.cwd === cwd) stopMobileShare();
  },
  async updateSession(cwd, id, changes) {
    knownWorkspace(cwd).updateSession(id, changes);
    if (changes.title && mobileShare?.id === id && mobileShare.ws.cwd === cwd) {
      mobileShare.rename(changes.title.replace(/\s+/g, ' ').trim());
      if (mobileShare.ready) push({ type: 'mobile-sharing', share: mobileShare.info() });
    }
  },
  async deleteSession(cwd, id) {
    await knownWorkspace(cwd).deleteSession(id, (path) => shell.trashItem(path));
    if (mobileShare?.id === id && mobileShare.ws.cwd === cwd) stopMobileShare();
  },
  async ask(cwd, req) { return currentWorkspace(cwd).ask(req); },
  async retry(cwd, turnId, targetIds) { return currentWorkspace(cwd).retry(turnId, targetIds); },
  async cancel(cwd, turnId) { currentWorkspace(cwd).cancel(turnId); },
  async cancelTarget(cwd, turnId, targetId) { return currentWorkspace(cwd).cancelTarget(turnId, targetId); },
  async respondInteraction(cwd, turnId, interactionId, response) { return currentWorkspace(cwd).respondInteraction(turnId, interactionId, response); },
  async stageMaterial(cwd, name, mime, data) { return stageMaterial(currentWorkspace(cwd).cwd, name, mime, data); },
  async discardMaterial(cwd, id) { discardMaterial(cwd, id); },
  async revealMaterial(cwd, turn, index) {
    const ws = currentWorkspace(cwd);
    const item = loadRun(ws.cwd, turn).input.materials?.[index];
    if (!item || !/^\.unify\/materials\/[a-f0-9]{64}\/[^/\\]+$/.test(item.file)) throw new Error('找不到材料');
    shell.showItemInFolder(join(ws.cwd, item.file));
  },
  async captureBench(cwd, turn, call, note, feedback) { return capture(currentWorkspace(cwd).cwd, turn, call, note, feedback); },
  async benchIndex(cwd) { return listBench(currentWorkspace(cwd).cwd); },
  async benchSaveCollection(cwd, name, ids, previous) { return saveCollection(currentWorkspace(cwd).cwd, name, ids, previous); },
  async benchDeleteCollection(cwd, previous) { deleteCollection(currentWorkspace(cwd).cwd, previous); },
  async benchDeleteEntry(cwd, kind, id) { deleteEntry(currentWorkspace(cwd).cwd, kind, id); },
  async benchSaveDraft(cwd, data, previous) { return saveDraft(currentWorkspace(cwd).cwd, data, previous); },
  async benchEvidence(cwd, id) {
    const ws = currentWorkspace(cwd);
    return { ...candidateEvidence(ws.cwd, id), record: loadRun(ws.cwd, getCandidate(ws.cwd, id).source.turn) };
  },
  async benchDraft(cwd, id, target, note, repo) { return currentWorkspace(cwd).benchDraft(id, target, note, repo); },
  async benchRead(cwd, id, published) { return (published ? getCase : getDraft)(currentWorkspace(cwd).cwd, id); },
  async benchPublish(cwd, data, judge, options) { return currentWorkspace(cwd).benchPublish(data, judge, options); },
  async benchRun(cwd, ids, targets, judge, collection) { return currentWorkspace(cwd).benchRun(ids, targets, judge, collection); },
  async previewExec(cwd, turnId, from, executor) { return currentWorkspace(cwd).previewExec(turnId, from, executor); },
  async closeCollaboration(cwd, turnId) { currentWorkspace(cwd).closeCollaboration(turnId); },
  async exec(cwd, turnId, from, executor) { return currentWorkspace(cwd).exec(turnId, from, executor); },
  async quota(cwd, force) { return currentWorkspace(cwd).quota(force); },
  cacheReport() { return readCacheReport(); },
  async settings(cwd) { return currentWorkspace(cwd).settings(); },
  async agyModels(cwd) { return readAgyModels(currentWorkspace(cwd).cwd); },
  async testTarget(cwd, id) { return currentWorkspace(cwd).testTarget(id); },
  async setSetting(cwd, key, value, entry) { return currentWorkspace(cwd).setSetting(key, value, entry); },
  async saveCollaboration(cwd, id, graph) { currentWorkspace(cwd).setSetting('collaborationGraphs', graph, id); },
  async saveApi(cwd, id, model, apiKey) { return currentWorkspace(cwd).saveApi(id, model, apiKey); },
  async memoryUrl(cwd) { return currentWorkspace(cwd).memoryUrl(); },
  async prepareDistill(cwd, source) { return currentWorkspace(cwd).prepareDistill(source); },
  async distillCandidates(cwd, source, targetId) { return currentWorkspace(cwd).distillCandidates(source, targetId); },
  async checkDistillDuplicate(cwd, targetPath, text) { return currentWorkspace(cwd).checkDistillDuplicate(targetPath, text); },
  async applyDistill(cwd, req) { return currentWorkspace(cwd).applyDistill(req); },
  async reveal(cwd, what, id) {
    const ws = currentWorkspace(cwd);
    const settings = what.endsWith('config') ? ws.settings() : undefined;
    const path = what === 'project' ? ws.cwd
      : what === 'run' ? ws.runDir(String(id))
      : what === 'user-config' ? settings!.userPath : settings!.projectPath;
    if (what === 'project' || what === 'run') { await shell.openPath(path); return; }
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{}\n');
    }
    shell.showItemInFolder(path);
  },
  async copy(text) { clipboard.writeText(String(text)); },
};

ipcMain.handle('unify', async (event, method: Method, ...args: unknown[]): Promise<Reply> => {
  if (event.senderFrame?.url !== win?.webContents.getURL() || !Object.hasOwn(api, method)) return { ok: false, error: '不允许的调用' };
  try {
    const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function visibleBounds(b: State['bounds']) {
  if (!b) return undefined;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 80;
  return visible ? b : undefined;
}

function createWindow(view?: 'quota'): void {
  const bounds = visibleBounds(state.bounds);
  const { bg, symbol } = palette();
  win = new BrowserWindow({
    width: bounds?.width ?? 1380, height: bounds?.height ?? 900, x: bounds?.x, y: bounds?.y,
    minWidth: 880, minHeight: 600, show: false, backgroundColor: bg, title: 'Unify',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: { color: bg, symbolColor: symbol, height: 44 } }),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  if (state.bounds?.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  const owner = win;
  win.webContents.session.setDisplayMediaRequestHandler(async (request, reply) => {
    if (!request.userGesture || request.frame !== owner.webContents.mainFrame) { reply({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const menu = Menu.buildFromTemplate(sources.map(source => ({
        label: source.name.replaceAll('&', '&&'), click: () => { selected = source; },
      })));
      let selected: (typeof sources)[number] | undefined;
      if (!sources.length) { reply({}); return; }
      menu.popup({ window: owner, callback: () => reply(selected ? { video: selected } : {}) });
    } catch { reply({}); }
  }, { useSystemPicker: true });

  // Model output can contain links: open web links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    state.bounds = { ...(win.isMaximized() ? state.bounds ?? win.getBounds() : win.getBounds()), maximized: win.isMaximized() };
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', () => { saveBounds(); writeState(state); });
  win.on('closed', () => { win = undefined; });

  void win.loadFile(join(here, 'renderer', 'index.html'), view ? { query: { view } } : undefined);
}

nativeTheme.on('updated', () => {
  if (!win || win.isDestroyed()) return;
  const { bg, symbol } = palette();
  win.setBackgroundColor(bg);
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: bg, symbolColor: symbol });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'dev.unify.desktop' : process.execPath);
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // Model calls are child processes; wait for cancellation and record writes before exiting.
  app.on('before-quit', (event) => {
    if (quitting || !workspaces.size) return;
    event.preventDefault();
    quitting = true;
    stopMobileShare();
    const done = Promise.all(Array.from(workspaces.values(), ws => ws.dispose()));
    const limit = new Promise((r) => setTimeout(r, 8000));
    void Promise.race([done, limit]).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', clearMaterials);
  app.on('activate', () => { if (!win) createWindow(); });

  void app.whenReady().then(async () => {
    state = readState();
    nativeTheme.themeSource = state.theme ?? 'system';
    await prepareProviderPath();
    const fromArgs = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && isDir(a));
    const initial = process.env.UNIFY_CWD ?? fromArgs ?? (state.activeWorkspace && isDir(state.activeWorkspace) ? state.activeWorkspace : state.recent.find(isDir));
    if (initial) { try { activateWorkspace(knownWorkspace(registerWorkspace(initial))); } catch { /* fall back to the welcome screen */ } }
    createWindow();
  });
}
