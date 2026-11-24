import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ComposerSelection, DistillPreparation, DistillSourceRef, ExecPreview, OpenedWorkspace, Push, QuotaNotice, RunRecord, SessionChanges, SessionSummary, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { onPush, unify } from './api.js';
import { MemoryPage, QuotaPage, SettingsPage, Welcome } from './Pages.js';
import { CachePage } from './CachePage.js';
import { BenchmarkPage } from './Benchmark.js';
import { SessionList } from './Sessions.js';
import { Card, Composer, DistillDialog, ExecDialog, Turn, type ComposerState, type FollowUpChoice, type TurnActions } from './Thread.js';
import type { PendingInteractionItem } from './QuestionPanel.js';
import { FeedbackDialog, type FeedbackContext } from './FeedbackDialog.js';
import type { MaterialSelection } from '../shared/api.js';
import { prefersReducedMotion, usePresence } from './motion.js';
import { Icon, Spinner, isActive } from './ui.js';

type View = 'bench' | 'chat' | 'quota' | 'cache' | 'memory' | 'settings';
interface Toast { id: number; msg: string; kind: 'ok' | 'err' | 'info' }
function InteractionBanner({ items, onJump, label, className }: {
  items: PendingInteractionItem[]; onJump(item: PendingInteractionItem): void; label: string; className: string;
}) {
  const { rendered, state } = usePresence(items.length ? items : undefined);
  if (!rendered) return null;
  const [first, ...rest] = rendered;
  return (
    <div className={`interact-slot motion-fold ${className}`} data-presence={state} inert={state === 'closing'}>
      <div className="motion-fold-inner">
        <div className="interact-banner" role="status">
          <div className="interact-banner-left">
            <Icon name="alert" size={14} />
            <span><b>{first.targetLabel}</b> 等待交互：{first.request.title}{rest.length ? `（另有 ${rest.length} 项）` : ''}</span>
          </div>
          <button type="button" className="interact-banner-jump" onClick={() => onJump(first)}>{label}</button>
        </div>
      </div>
    </div>
  );
}
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
const darkTheme = window.matchMedia('(prefers-color-scheme: dark)');
function subscribeTheme(listener: () => void) {
  darkTheme.addEventListener('change', listener);
  return () => darkTheme.removeEventListener('change', listener);
}

export function App() {
  const isDark = useSyncExternalStore(subscribeTheme, () => darkTheme.matches);
  const themeAction = isDark ? '切换至亮色主题' : '切换至暗色主题';
  const [platform, setPlatform] = useState<string>('');
  const [ws, setWs] = useState<WorkspaceInfo | null | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<string, RunRecord>>({});
  const [interactions, setInteractions] = useState<Record<string, PendingInteractionItem[]>>({});
  const [notices, setNotices] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('view') === 'quota' ? 'quota' : 'chat');
  const [quota, setQuota] = useState<TargetQuota[]>();
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaNotice, setQuotaNotice] = useState<QuotaNotice>();
  const [toast, setToast] = useState<Toast>();
  const [execPreview, setExecPreview] = useState<{ key: number; preview: ExecPreview }>();
  const [distillModal, setDistillModal] = useState<{ key: number; source: DistillSourceRef; prep: DistillPreparation }>();
  const [pendingMemoryUpdates, setPendingMemoryUpdates] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<FeedbackContext>();
  const [inserted, setInserted] = useState<{ session: string; text: string }>();
  const [zoom, setZoom] = useState<{ turnId: string; runId: string }>();
  const [followUp, setFollowUp] = useState<FollowUpChoice>();
  const [composerSelection, setComposerSelection] = useState<ComposerSelection>();
  const [settingsGraph,setSettingsGraph] = useState<string>();
  const [revisionId,setRevisionId] = useState<string>();
  const [sidebar, setSidebar] = useState(true);
  const [menu, setMenu] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const sidebarElement = useRef<HTMLElement>(null);
  const projectToggle = useRef<HTMLButtonElement>(null);
  const zoomBack = useRef<HTMLDivElement>(null);
  const zoomTrigger = useRef<HTMLElement | null>(null);
  const modalSequence = useRef(0);
  const projectMenu = usePresence(menu ? true : undefined);
  const toastPresence = usePresence(toast);
  const quotaPresence = usePresence(quotaNotice);
  const execPresence = usePresence(execPreview);
  const distillPresence = usePresence(distillModal);
  const zoomPresence = usePresence(zoom);
  const cwd = ws?.cwd;
  const activeCwd = useRef(cwd);
  const sessionListRequest = useRef(0);
  const openSessionRequest = useRef(0);
  useLayoutEffect(() => { activeCwd.current = cwd; }, [cwd]);

  const toastSequence = useRef(0);
  const notify = useCallback((msg: string, kind: Toast['kind'] = 'info') => setToast({ id: ++toastSequence.current, msg, kind }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), toast.kind === 'err' ? 6000 : 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshSessions = useCallback(() => {
    const requestedCwd = activeCwd.current;
    const request = ++sessionListRequest.current;
    void unify.sessions().then((list) => {
      if (requestedCwd === activeCwd.current && request === sessionListRequest.current) setSessions(list);
    }, () => undefined);
  }, []);
  const refreshQuota = useCallback((force = false) => {
    const requestedCwd = activeCwd.current;
    setQuotaLoading(true);
    unify.quota(force).then((quotas) => {
      if (requestedCwd === activeCwd.current) setQuota(quotas);
    }, () => undefined).finally(() => {
      if (requestedCwd === activeCwd.current) setQuotaLoading(false);
    });
  }, []);

  const openQuota = useCallback(() => { setQuotaNotice(undefined); setView('quota'); }, []);
  const showWorkspace = useCallback((opened: OpenedWorkspace | null) => {
    setWs(opened?.info ?? null);
    setComposerSelection(opened?.selection);
  }, []);

  // ── bootstrap and pushes ────────────────────────────────────────────────
  useEffect(() => {
    void unify.platform().then(setPlatform);
    void unify.workspace().then(showWorkspace);
    return onPush((p: Push) => {
      if (p.type === 'run') setRecords((r) => ({ ...r, [p.record.id]: p.record }));
      else if (p.type === 'interaction') {
        setInteractions((prev) => {
          const list = prev[p.callId] ?? [];
          if (list.some((x) => x.request.id === p.request.id)) return prev;
          return {
            ...prev,
            [p.callId]: [...list, { turnId: p.turnId, callId: p.callId, targetId: p.targetId, targetLabel: p.targetLabel, request: p.request }],
          };
        });
      } else if (p.type === 'interaction-resolved') {
        setInteractions((prev) => {
          const list = prev[p.callId];
          if (!list) return prev;
          const next = list.filter((x) => x.request.id !== p.interactionId);
          if (next.length) return { ...prev, [p.callId]: next };
          const copy = { ...prev };
          delete copy[p.callId];
          return copy;
        });
      } else if (p.type === 'notice') {
        setNotices((n) => ({ ...n, [p.turnId]: [...(n[p.turnId] ?? []), p.message] }));
        if (p.category === 'cache') notify(p.message);
      }
      else if (p.type === 'workspace') setWs((w) => (w && w.cwd === p.info.cwd ? p.info : w));
      else if (p.type === 'end') {
        setInteractions((prev) => {
          let changed = false;
          const copy: Record<string, PendingInteractionItem[]> = {};
          for (const [cid, list] of Object.entries(prev)) {
            const filtered = list.filter((x) => x.turnId !== p.turnId);
            if (filtered.length !== list.length) changed = true;
            if (filtered.length) copy[cid] = filtered;
          }
          return changed ? copy : prev;
        });
        refreshSessions();
      }
      else if (p.type === 'quota' && p.cwd === activeCwd.current) setQuota(p.quotas);
      else if (p.type === 'quota-notice') setQuotaNotice(p.notice);
      else if (p.type === 'open-quota') openQuota();
    });
  }, [refreshSessions, openQuota, showWorkspace, notify]);

  // A different project starts from a clean slate.
  useEffect(() => {
    setCurrent(null);
    setSessions([]);
    setFollowUp(undefined);
    setPendingMemoryUpdates([]);
    setDistillModal(undefined);
    setFeedback(undefined); setInserted(undefined);
    setRecords({});
    setInteractions({});
    setNotices({});
    setQuota(undefined);
    setQuotaLoading(false);
    if (!cwd) return;
    refreshSessions();
    refreshQuota();
  }, [cwd, refreshSessions, refreshQuota]);

  const composer = useMemo<ComposerState>(() => {
    const available = new Set(ws?.targets.filter((target) => target.installed !== false).map((target) => target.id));
    const selected = (composerSelection?.selected ?? ws?.defaults ?? []).filter((id) => available.has(id));
    const synth = composerSelection?.synth ?? '';
    return { selected, synth: synth === 'off' || available.has(synth) ? synth : '', graph: composerSelection?.graph && ws?.collaborationGraphs[composerSelection.graph] ? composerSelection.graph : undefined };
  }, [ws, composerSelection]);

  const changeComposerSelection = (selection: ComposerSelection) => {
    if (!cwd) return;
    setComposerSelection(selection);
    void unify.saveComposerSelection(cwd, selection).catch((err) => {
      if (cwd === activeCwd.current) notify(errText(err), 'err');
    });
  };

  const toggleTarget = (id: string) => {
    const selected = composerSelection?.selected ?? composer.selected;
    changeComposerSelection({
      ...composerSelection,
      selected: selected.includes(id) ? selected.filter((target) => target !== id) : [...selected, id],
    });
  };

  useEffect(() => { if (menu) void unify.recentWorkspaces().then(setRecent); }, [menu]);

  const toggleSidebar = useCallback(() => {
    const active = document.activeElement;
    if (sidebarElement.current?.contains(active) || active?.closest('.session-menu')) sidebarToggle.current?.focus();
    setSidebar(open => !open);
  }, []);

  const openWorkspace = useCallback(async (dir?: string) => {
    setMenu(false);
    try {
      const opened = await unify.openWorkspace(dir);
      if (opened) { showWorkspace(opened); setView('chat'); }
    } catch (err) { notify(errText(err), 'err'); }
  }, [notify, showWorkspace]);

  const openSession = useCallback(async (id: string | null) => {
    const requestedCwd = activeCwd.current;
    const request = ++openSessionRequest.current;
    setCurrent(id);
    setFollowUp(undefined);
    setPendingMemoryUpdates([]);
    setView('chat');
    setZoom(undefined);
    if (!id) return;
    try {
      const runs = await unify.session(id);
      if (requestedCwd !== activeCwd.current || request !== openSessionRequest.current) return;
      setRecords((r) => {
        const next = { ...r };
        for (const run of runs) if (!(next[run.id] && isActive(next[run.id]))) next[run.id] = run;
        return next;
      });
    } catch (err) {
      if (requestedCwd === activeCwd.current && request === openSessionRequest.current) notify(errText(err), 'err');
    }
  }, [notify]);

  // ── derived ─────────────────────────────────────────────────────────────
  const turns = useMemo(
    () => Object.values(records).filter((r) => r.sessionId === current).sort((a, b) => a.id.localeCompare(b.id)),
    [records, current],
  );
  const busy = turns.some(isActive);
  const latestComparisonId = useMemo(() => turns.filter((r) => r.kind === 'comparison').at(-1)?.id, [turns]);
  const activeFollowUp = followUp && followUp.turnId === latestComparisonId ? followUp : undefined;
  const revision = revisionId && revisionId === turns.at(-1)?.id ? records[revisionId] : undefined;
  const graphControls = {
    revision: revision?.collaboration,
    onGraph: (graph?: string) => { setRevisionId(undefined); changeComposerSelection({ ...composerSelection, graph }); },
    editGraph: () => { setSettingsGraph(composer.graph ?? ''); setView('settings'); },
  };
  const liveSessions = useMemo(() => new Set(Object.values(records).filter(isActive).map((r) => r.sessionId)), [records]);
  const quotaMap = useMemo(() => new Map((quota ?? []).map((q) => [q.targetId, q])), [quota]);

  // ── actions ─────────────────────────────────────────────────────────────
  const updateSession = async (id: string, changes: SessionChanges) => {
    if (!cwd) return;
    await unify.updateSession(cwd, id, changes);
    if (cwd === activeCwd.current) refreshSessions();
  };

  const deleteSession = async (id: string) => {
    if (!cwd) return;
    try { await unify.deleteSession(cwd, id); }
    finally { if (cwd === activeCwd.current) refreshSessions(); }
    if (cwd !== activeCwd.current) return;

    const deletedTurns = Object.values(records).filter((record) => record.sessionId === id);
    const turnIds = new Set(deletedTurns.map((record) => record.id));
    const callIds = new Set(deletedTurns.flatMap((record) => record.calls.map((call) => call.id)));
    setSessions((list) => list.filter((session) => session.id !== id));
    setRecords((all) => Object.fromEntries(Object.entries(all).filter(([, record]) => record.sessionId !== id)));
    setNotices((all) => Object.fromEntries(Object.entries(all).filter(([turnId]) => !turnIds.has(turnId))));
    setInteractions((all) => Object.fromEntries(Object.entries(all).filter(([callId]) => !callIds.has(callId))));
    if (current === id) {
      openSessionRequest.current++;
      setCurrent(null);
      setFollowUp(undefined);
      setPendingMemoryUpdates([]);
      setZoom(undefined);
    }
    notify('已将对话移到系统回收站', 'ok');
  };

  const send = async (question: string, source?: RunRecord, materials?: MaterialSelection[]): Promise<boolean> => {
    try {
      const reviseTurn = source?.collaboration ? source.id : revision?.id;
      const ids = await unify.ask({
        question, selected: composer.selected, manual: composerSelection?.selected !== undefined, graph: composer.graph, reviseTurn,
        synthesize: composer.synth !== 'off', synthesizer: composer.synth && composer.synth !== 'off' ? composer.synth : undefined,
        sessionId: current ?? undefined,
        replyTo: source?.id, materials, materialWorkspace: cwd,
        continueFrom: reviseTurn && !source ? undefined : activeFollowUp?.targetId,
        memoryUpdates: current && pendingMemoryUpdates.length ? pendingMemoryUpdates : undefined,
      });
      setFollowUp(undefined);
      setPendingMemoryUpdates([]);
      setCurrent(ids.sessionId);
      setRevisionId(undefined);
      refreshSessions();
      return true;
    } catch (err) {
      if (source) throw err;
      notify(errText(err), 'err');
      return false;
    }
  };

  const actions: TurnActions = {
    confirmGraph: record => { void unify.exec(record.id,undefined,record.collaboration!.execution.target).then(() => refreshSessions(),err => notify(errText(err),'err')); },
    reviseGraph: record => { setRevisionId(record.id); setFollowUp(undefined); document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(); },
    closeGraph: record => { void unify.closeCollaboration(record.id).then(() => setRevisionId(undefined),err => notify(errText(err),'err')); },
    zoom: (turnId, runId, trigger) => {
      if (runId) zoomTrigger.current = trigger;
      setZoom(runId ? { turnId, runId } : undefined);
    },
    exec: (turnId, from) => {
      unify.previewExec(turnId, from).then(preview => setExecPreview({ key: ++modalSequence.current, preview }), err => notify(errText(err), 'err'));
    },
    retry: (turnId, targetIds) => {
      unify.retry(turnId, targetIds).then((ids) => { setCurrent(ids.sessionId); refreshSessions(); }, (err) => notify(errText(err), 'err'));
    },
    cancel: (turnId) => { void unify.cancel(turnId); },
    cancelTarget: (turnId, targetId) => { void unify.cancelTarget(turnId, targetId); },
    openInteraction: item => jumpToInteraction(item),
    feedback: (record, call, quote) => setFeedback({ record, call, quote }),
    sendChoices: async (text, source) => { await send(text, source); },
    respondInteraction: async (turnId, interactionId, response) => {
      if (!await unify.respondInteraction(turnId, interactionId, response)) {
        throw new Error('这项请求已经结束');
      }
    },
    followUp: (choice) => setFollowUp(choice),
    benchmark: (turn, call) => {
      if (ws) void unify.captureBench(ws.cwd, turn, call).then(() => notify('已留作评测候选，可在侧栏「评测集」整理'), err => notify(errText(err), 'err'));
    },
    distill: (source) => {
      unify.prepareDistill(source).then((prep) => setDistillModal({ key: ++modalSequence.current, source, prep }), (err) => notify(errText(err), 'err'));
    },
  };
  const cancelCurrent = () => { for (const t of turns) if (isActive(t)) void unify.cancel(t.id); };

  // ── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const dialog = e.target instanceof Element && e.target.closest('dialog[open]');
      if (e.defaultPrevented || (dialog && (e.key === 'Escape' || dialog.matches('.session-dialog, .source-dialog')))) return;
      if (e.key === 'Escape' && menu) { setMenu(false); projectToggle.current?.focus(); return; }
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && zoom) { setZoom(undefined); return; }
      if (!mod || !ws) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void openSession(null); }
      else if (e.key === ',') { e.preventDefault(); setView('settings'); }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ws, zoom, menu, openSession, toggleSidebar]);

  // Keep the thread pinned to the newest output unless the user scrolled up.
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => { stick.current = true; }, [current]);
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, view]);

  const pendingInteractions = useMemo(() => Object.values(interactions).flat(), [interactions]);
  const jumpToInteraction = useCallback((item: PendingInteractionItem) => {
    const rec = records[item.turnId];
    setView('chat');
    setZoom(undefined);
    if (rec && rec.sessionId !== current) void openSession(rec.sessionId);
    requestAnimationFrame(() => {
      const el = document.getElementById('turn-' + item.turnId)?.querySelector<HTMLElement>(`[data-interaction-id="${CSS.escape(item.request.id)}"]`);
      el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'instant' : 'smooth', block: 'center' });
      (el?.querySelector<HTMLElement>('input') ?? el?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    });
  }, [records, current, openSession]);

  const visibleZoom = zoomPresence.rendered;
  const zoomed = visibleZoom && records[visibleZoom.turnId];
  const zoomCall = zoomed?.calls.find(c => c.id === visibleZoom?.runId);
  const zoomResult = zoomed && (zoomCall?.result ?? [...zoomed.results, ...(zoomed.synthesis ? [zoomed.synthesis.result] : [])].find((r) => r.runId === visibleZoom.runId));
  const zoomIsOpen = view === 'chat' && !!(zoom && zoomResult);
  useLayoutEffect(() => { if (view !== 'chat') setZoom(undefined); }, [view]);
  useLayoutEffect(() => {
    if (zoomIsOpen) {
      zoomBack.current?.querySelector<HTMLElement>('[data-zoom-close]')?.focus({ preventScroll: true });
    } else if (zoomTrigger.current) {
      if (document.activeElement === document.body || zoomBack.current?.contains(document.activeElement)) {
        zoomTrigger.current.focus({ preventScroll: true });
      }
      zoomTrigger.current = null;
    }
  }, [zoomIsOpen]);

  if (ws === undefined) return <div className="boot"><Spinner /></div>;

  return (
    <div className={`app ${platform}${sidebar && ws ? '' : ' no-side'}`}>
      <div className="titlebar">
        {ws && <button ref={sidebarToggle} className="tb-btn" onClick={toggleSidebar} aria-expanded={sidebar} aria-controls="workspace-sidebar" title="侧栏 (Ctrl+B)"><Icon name="sidebar" /></button>}
        <div className="brand"><Icon name="spark" size={14} />Unify</div>
        {ws && (
          <>
            <span className="sep">/</span>
            <div className="tb-menu">
              <button ref={projectToggle} className="tb-project" onClick={() => setMenu(!menu)} aria-expanded={menu} title={ws.cwd}><Icon name="folder" size={14} />{ws.name}<Icon name="chevron" size={12} /></button>
              {projectMenu.rendered && (
                <>
                  {menu && <div className="menu-back" onClick={() => setMenu(false)} />}
                  <div className="menu" data-presence={projectMenu.state} inert={!menu}>
                    {recent.filter((p) => p !== ws.cwd).slice(0, 8).map((p) => (
                      <button key={p} onClick={() => void openWorkspace(p)}><b>{p.split(/[\\/]/).filter(Boolean).pop()}</b><span>{p}</span></button>
                    ))}
                    <button onClick={() => void openWorkspace()}><b>打开其他文件夹…</b></button>
                    <button onClick={() => { setMenu(false); void unify.reveal('project'); }}><b>在文件管理器中显示</b></button>
                  </div>
                </>
              )}
            </div>
            {ws.branch !== undefined && (
              <button type="button" className="tb-branch" title={`切换 Git 分支（${ws.branch ?? '游离 HEAD'}）`}
                aria-haspopup="menu" onClick={(event) => {
                  const { left, bottom } = event.currentTarget.getBoundingClientRect();
                  void unify.chooseGitBranch(ws.cwd, Math.round(left), Math.round(bottom)).catch(err => notify(errText(err), 'err'));
                }}>
                <Icon name="branch" size={13} />
                <span>{ws.branch ?? '游离 HEAD'}</span>
                <Icon name="chevron" size={12} />
              </button>
            )}
          </>
        )}
        <button type="button" className="tb-btn theme-toggle" title={themeAction} aria-label={themeAction}
          onClick={() => void unify.setTheme(isDark ? 'light' : 'dark').catch(err => notify(errText(err), 'err'))}>
          <Icon key={isDark ? 'sun' : 'moon'} name={isDark ? 'sun' : 'moon'} />
        </button>
      </div>

      {ws && (
        <aside id="workspace-sidebar" className="sidebar" ref={sidebarElement} aria-hidden={!sidebar} inert={!sidebar}>
          <button className="new-chat" onClick={() => void openSession(null)}><Icon name="plus" />新对话<kbd>Ctrl N</kbd></button>
          <SessionList key={ws.cwd} sidebarOpen={sidebar} sessions={sessions} current={view === 'chat' ? current : null} live={liveSessions}
            open={(id) => void openSession(id)} update={updateSession} remove={deleteSession} onError={(msg) => notify(msg, 'err')} />
          <nav className="side-nav">
            <button className={view === 'bench' ? 'on' : ''} onClick={() => setView('bench')}><Icon name="bookmark" />评测集</button>
            <button className={view === 'quota' ? 'on' : ''} onClick={openQuota}><Icon name="gauge" />额度</button>
            <button className={view === 'cache' ? 'on' : ''} onClick={() => setView('cache')}><Icon name="activity" />缓存监控</button>
            <button className={view === 'memory' ? 'on' : ''} onClick={() => setView('memory')}><Icon name="layers" />记忆</button>
            <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}><Icon name="sliders" />设置<kbd>Ctrl ,</kbd></button>
          </nav>
        </aside>
      )}

      <main className="sheet">
        <div className="sheet-content" inert={zoomIsOpen}>
          {view !== 'chat' && (
            <InteractionBanner items={pendingInteractions} onJump={jumpToInteraction} label="前往处理" className="page-interact" />
          )}
          {ws && <BenchmarkPage key={ws.cwd} ws={ws} visible={view === 'bench'} />}
          {!ws ? <Welcome onOpen={(d) => void openWorkspace(d)} />
            : view === 'bench' ? null
            : view === 'quota' ? <QuotaPage quota={quota} loading={quotaLoading} refresh={() => refreshQuota(true)} />
            : view === 'cache' ? <CachePage />
            : view === 'memory' ? <MemoryPage cwd={ws.cwd} notify={notify} />
            : view === 'settings' ? <SettingsPage key={ws.cwd} ws={ws} onChange={setWs} notify={notify} initialGraph={settingsGraph} />
            : turns.length === 0 ? (
              <div className="home-stage">
                {ws.configError && <div className="error block home-alert"><Icon name="alert" size={14} /><span>配置有误：{ws.configError}</span></div>}
                <InteractionBanner items={pendingInteractions} onJump={jumpToInteraction} label="定位处理" className="home-interact" />
                <div className="home-center">
                  <div className="home-head">
                    <div className="home-mark" aria-hidden="true"><Icon name="spark" size={18} /></div>
                    <h1>{timeGreeting()}</h1>
                    {ws.targets.some((t) => t.installed === undefined) ? (
                      <p className="home-status"><Spinner />正在准备可用模型…</p>
                    ) : !ws.targets.some((t) => t.installed) ? (
                      <p className="home-status">
                        <button type="button" className="home-setup-btn" onClick={() => { setSettingsGraph(undefined); setView('settings'); }}>
                          <Icon name="sliders" size={13} />在设置中接入模型
                        </button>
                      </p>
                    ) : null}
                  </div>
                  <Composer
                    home {...graphControls}
                    ws={ws} quota={quotaMap} busy={busy} state={composer} onToggleTarget={toggleTarget}
                    onSynthesisChange={(synth) => changeComposerSelection({ ...composerSelection, synth })}
                    key={`${ws.cwd}:${current}`} onSend={(q, files) => send(q, undefined, files)} onCancel={cancelCurrent} autoFocusKey={`${ws.cwd}:${current}`}
                    followUp={activeFollowUp} onClearFollowUp={() => setFollowUp(undefined)}
                    pendingMemoryUpdates={pendingMemoryUpdates} onClearMemoryUpdates={() => setPendingMemoryUpdates([])}
                  />
                </div>
              </div>
            ) : (
              <>
                <div key={current} className="thread page-enter" ref={thread} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                  {ws.configError && <div className="error block"><Icon name="alert" size={14} /><span>配置有误：{ws.configError}</span></div>}
                  {turns.map((r) => (
                    <Turn
                      key={r.id} record={r} notices={notices[r.id] ?? []} interactions={interactions} showReasoning={ws.showReasoning} actions={actions}
                      isLatestComparison={r.id === latestComparisonId} isLatestTurn={r.id === turns.at(-1)?.id} followUp={activeFollowUp}
                      choiceBlocker={!r.collaboration && !composer.graph && !composer.selected.length ? '先选择一个回答模型' : undefined}
                      execution={r.collaboration ? turns.find(t => t.planSource?.turnId === r.id) : undefined}
                      graphExecutor={r.collaborationTargets?.find(t => t.id === r.collaboration?.execution.target)?.label}
                    />
                  ))}
                </div>
                <InteractionBanner items={pendingInteractions} onJump={jumpToInteraction} label="定位处理" className="thread-interact" />
                <Composer {...graphControls}
                  ws={ws} quota={quotaMap} busy={busy} state={composer} onToggleTarget={toggleTarget}
                  onSynthesisChange={(synth) => changeComposerSelection({ ...composerSelection, synth })}
                  key={`${ws.cwd}:${current}`} onSend={(q, files) => send(q, undefined, files)} onCancel={cancelCurrent} autoFocusKey={`${ws.cwd}:${current}`}
                  inserted={inserted?.session === current ? inserted : undefined} consumed={() => setInserted(undefined)}
                  followUp={activeFollowUp} onClearFollowUp={() => setFollowUp(undefined)}
                  pendingMemoryUpdates={pendingMemoryUpdates} onClearMemoryUpdates={() => setPendingMemoryUpdates([])}
                />
              </>
            )}
        </div>
        {zoomed && zoomResult && (
          <div className="zoom-back" ref={zoomBack} role="dialog" aria-label="放大阅读"
            data-presence={zoomPresence.state} inert={!zoomIsOpen}
            onMouseDown={(e) => { if (e.target === e.currentTarget) setZoom(undefined); }}>
            <Card
              key={zoomResult.runId} record={zoomed} result={zoomResult} zoomed showReasoning={ws?.showReasoning ?? false} interactions={interactions[zoomResult.runId]} actions={actions}
              kind={zoomCall?.scope === 'plan-review' || zoomCall?.scope === 'result-review' ? zoomCall.scope : zoomed.synthesis?.result.runId === zoomResult.runId ? 'synthesis' : zoomed.kind === 'execution' ? 'exec' : 'answer'}
            />
          </div>
        )}
      </main>

      {feedback && ws && <FeedbackDialog context={feedback} close={() => setFeedback(undefined)}
        insert={text => { setZoom(undefined); setInserted({ session: feedback.record.sessionId, text: '针对「' + feedback.record.question + '」\n' + text }); }}
        save={async (note, entry) => {
          await unify.captureBench(ws.cwd, feedback.record.id, feedback.call, note, entry);
          notify('已留作评测候选', 'ok');
        }} />}
      {execPresence.rendered && (
        <ExecDialog
          key={execPresence.rendered.key}
          initial={execPresence.rendered.preview} open={execPresence.state === 'open'} onClose={() => setExecPreview(undefined)}
          onError={(m) => notify(m, 'err')}
          onStarted={(ids) => { setExecPreview(undefined); setCurrent(ids.sessionId); setView('chat'); refreshSessions(); }}
        />
      )}
      {distillPresence.rendered && (
        <DistillDialog
          key={distillPresence.rendered.key}
          open={distillPresence.state === 'open'}
          initial={distillPresence.rendered.prep}
          source={distillPresence.rendered.source}
          onClose={() => setDistillModal(undefined)}
          onError={(m) => notify(m, 'err')}
          onSaved={(res, applyInSession) => {
            setDistillModal(undefined);
            if (applyInSession) setPendingMemoryUpdates((prev) => [...prev, res.savedText]);
            const effectNote = applyInSession
              ? '已加入本对话下轮增量；新对话及原生 CLI 下轮起生效'
              : res.affectsNativeCli
                ? '新对话及原生 CLI 下轮起生效（当前 API 会话保持旧快照）'
                : '新对话起生效';
            notify(`已写入 ${res.display} · ${effectNote}`, 'ok');
          }}
        />
      )}
      {toastPresence.rendered && <div key={toastPresence.rendered.id} className={`toast ${toastPresence.rendered.kind}`}
        data-presence={toastPresence.state} inert={toastPresence.state === 'closing'} role="status">{toastPresence.rendered.msg}</div>}
      {quotaPresence.rendered && (
        <aside className="quota-notice" aria-label="套餐额度提醒" data-presence={quotaPresence.state} inert={quotaPresence.state === 'closing'}>
          <div className="quota-notice-content" role="status">
            <header><Icon name="gauge" /><strong>{quotaPresence.rendered.title}</strong></header>
            <ul>{quotaPresence.rendered.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </div>
          <button className="quota-notice-close" type="button" aria-label="关闭额度提醒" onClick={() => setQuotaNotice(undefined)}><Icon name="x" size={14} /></button>
          <button className="btn" type="button" onClick={openQuota}>查看额度</button>
        </aside>
      )}
    </div>
  );
}
