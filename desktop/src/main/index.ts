import { candidateEvidence, capture, getCase, getDraft, listBench, saveDraft } from '../../../src/bench/cases.js';
import type { MenuItemConstructorOptions } from 'electron';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, screen, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../../../src/core/atomic-write.js';
import { collectQuotaReminders, type QuotaReminderHistory } from '../../../src/quota/reminders.js';
import type { ComposerSelection, Method, OpenedWorkspace, Push, QuotaNotice, Reply, TargetQuota, UnifyApi } from '../shared/api.js';
import { prepareProviderPath } from './env.js';
import { Workspace } from './workspace.js';

const here = dirname(fileURLToPath(import.meta.url));
const statePath = () => join(app.getPath('userData'), 'state.json');

interface State {
  recent: string[];
  theme?: 'light' | 'dark';
  bounds?: { x: number; y: number; width: number; height: number; maximized?: boolean };
  quotaReminders: QuotaReminderHistory;
  composerSelections: Record<string, ComposerSelection>;
}

function parseComposerSelection(value: unknown): ComposerSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { selected, synth } = value as Record<string, unknown>;
  if (selected !== undefined && (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string'))) return undefined;
  if (synth !== undefined && typeof synth !== 'string') return undefined;
  return { selected: selected && [...new Set(selected)], synth };
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
let quitting = false;
let pendingQuotaNotice: QuotaNotice | undefined;
let activeQuotaNotification: Notification | undefined;

let activeInteractionNotification: Notification | undefined;

const push = (p: Push) => {
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

function openWorkspace(dir: string): Workspace {
  const cwd = resolve(dir);
  if (!isDir(cwd)) throw new Error(`目录不存在：${cwd}`);
  if (workspace?.cwd === cwd) return workspace;
  if (workspace?.busy) throw new Error('当前项目还有操作在进行，请等待完成后再切换');
  void workspace?.dispose();
  workspace = new Workspace(cwd, push, monitorQuota);
  state.recent = [cwd, ...state.recent.filter((p) => p !== cwd)].slice(0, 12);
  writeState(state);
  return workspace;
}

const need = (): Workspace => {
  if (!workspace) throw new Error('请先打开一个项目文件夹');
  return workspace;
};

const currentWorkspace = (cwd: string): Workspace => {
  const ws = need();
  if (cwd !== ws.cwd) throw new Error('项目已切换，请在当前项目中重试');
  return ws;
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
  async openWorkspace(dir) {
    let target = dir;
    if (!target) {
      const picked = await dialog.showOpenDialog(win!, { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      target = picked.filePaths[0];
    }
    return describeWorkspace(openWorkspace(target));
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
  async sessions() { return need().sessions(); },
  async session(id) { return need().session(id); },
  async updateSession(cwd, id, changes) { currentWorkspace(cwd).updateSession(id, changes); },
  async deleteSession(cwd, id) { await currentWorkspace(cwd).deleteSession(id, (path) => shell.trashItem(path)); },
  async ask(req) { return need().ask(req); },
  async retry(turnId, targetIds) { return need().retry(turnId, targetIds); },
  async cancel(turnId) { need().cancel(turnId); },
  async cancelTarget(turnId, targetId) { return need().cancelTarget(turnId, targetId); },
  async respondInteraction(turnId, interactionId, response) { return need().respondInteraction(turnId, interactionId, response); },
  async captureBench(cwd, turn, call) { return capture(currentWorkspace(cwd).cwd, turn, call); },
  async benchIndex(cwd) { return listBench(currentWorkspace(cwd).cwd); },
  async benchSaveDraft(cwd, data) { return saveDraft(currentWorkspace(cwd).cwd, data); },
  async benchEvidence(cwd, id) { return candidateEvidence(currentWorkspace(cwd).cwd, id); },
  async benchDraft(cwd, id, target, note, repo) { return currentWorkspace(cwd).benchDraft(id, target, note, repo); },
  async benchRead(cwd, id, published) { return (published ? getCase : getDraft)(currentWorkspace(cwd).cwd, id); },
  async benchPublish(cwd, data, judge) { return currentWorkspace(cwd).benchPublish(data, judge); },
  async benchRun(cwd, ids, targets, judge) { return currentWorkspace(cwd).benchRun(ids, targets, judge); },
  async previewExec(turnId, from, executor) { return need().previewExec(turnId, from, executor); },
  async exec(turnId, from, executor) { return need().exec(turnId, from, executor); },
  async quota(force) { return need().quota(force); },
  async settings() { return need().settings(); },
  async testTarget(id) { return need().testTarget(id); },
  async setSetting(key, value, entry) { return need().setSetting(key, value, entry); },
  async saveApi(id, model, apiKey) { return need().saveApi(id, model, apiKey); },
  async memoryUrl() { return need().memoryUrl(); },
  async prepareDistill(source) { return need().prepareDistill(source); },
  async distillCandidates(source, targetId) { return need().distillCandidates(source, targetId); },
  async checkDistillDuplicate(targetPath, text) { return need().checkDistillDuplicate(targetPath, text); },
  async applyDistill(req) { return need().applyDistill(req); },
  async reveal(what, id) {
    const ws = need();
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
    if (quitting || !workspace) return;
    event.preventDefault();
    quitting = true;
    const done = workspace.dispose();
    const limit = new Promise((r) => setTimeout(r, 8000));
    void Promise.race([done, limit]).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!win) createWindow(); });

  void app.whenReady().then(async () => {
    state = readState();
    nativeTheme.themeSource = state.theme ?? 'system';
    await prepareProviderPath();
    const fromArgs = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && isDir(a));
    const initial = process.env.UNIFY_CWD ?? fromArgs ?? state.recent.find(isDir);
    if (initial) { try { openWorkspace(initial); } catch { /* fall back to the welcome screen */ } }
    createWindow();
  });
}
