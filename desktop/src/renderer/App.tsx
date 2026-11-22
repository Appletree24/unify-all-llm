import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ComposerSelection, DistillPreparation, DistillSourceRef, ExecPreview, OpenedWorkspace, Push, QuotaNotice, RunRecord, SessionChanges, SessionSummary, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { onPush, unify } from './api.js';
import { MemoryPage, QuotaPage, SettingsPage, Welcome } from './Pages.js';
import { SessionList } from './Sessions.js';
import { Card, Composer, DistillDialog, ExecDialog, Turn, type Activity, type ComposerState, type FollowUpChoice, type PendingInteractionItem, type TurnActions } from './Thread.js';
import { Icon, Spinner, hue, isActive } from './ui.js';

type View = 'chat' | 'quota' | 'memory' | 'settings';
interface Toast { id: number; msg: string; kind: 'ok' | 'err' | 'info' }
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
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
  const [activity, setActivity] = useState<Record<string, Activity[]>>({});
  const [interactions, setInteractions] = useState<Record<string, PendingInteractionItem[]>>({});
  const [notices, setNotices] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('view') === 'quota' ? 'quota' : 'chat');
  const [quota, setQuota] = useState<TargetQuota[]>();
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaNotice, setQuotaNotice] = useState<QuotaNotice>();
  const [toast, setToast] = useState<Toast>();
  const [execPreview, setExecPreview] = useState<ExecPreview>();
  const [distillModal, setDistillModal] = useState<{ source: DistillSourceRef; prep: DistillPreparation }>();
  const [pendingMemoryUpdates, setPendingMemoryUpdates] = useState<string[]>([]);
  const [zoom, setZoom] = useState<{ turnId: string; runId: string }>();
  const [followUp, setFollowUp] = useState<FollowUpChoice>();
  const [composerSelection, setComposerSelection] = useState<ComposerSelection>();
  const [sidebar, setSidebar] = useState(true);
  const [menu, setMenu] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const cwd = ws?.cwd;
  const activeCwd = useRef(cwd);
  const sessionListRequest = useRef(0);
  const openSessionRequest = useRef(0);
  useLayoutEffect(() => { activeCwd.current = cwd; }, [cwd]);

  const notify = useCallback((msg: string, kind: Toast['kind'] = 'info') => setToast({ id: Date.now(), msg, kind }), []);
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
      else if (p.type === 'activity') setActivity((a) => ({ ...a, [p.runId]: [...(a[p.runId] ?? []), { name: p.name, detail: p.detail }] }));
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
      } else if (p.type === 'notice') setNotices((n) => ({ ...n, [p.turnId]: [...(n[p.turnId] ?? []), p.message] }));
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
  }, [refreshSessions, openQuota, showWorkspace]);

  // A different project starts from a clean slate.
  useEffect(() => {
    setCurrent(null);
    setSessions([]);
    setFollowUp(undefined);
    setPendingMemoryUpdates([]);
    setDistillModal(undefined);
    setRecords({});
    setActivity({});
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
    return { selected, synth: synth === 'off' || available.has(synth) ? synth : '' };
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
    setActivity((all) => Object.fromEntries(Object.entries(all).filter(([callId]) => !callIds.has(callId))));
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

  const send = async (question: string): Promise<boolean> => {
    try {
      const ids = await unify.ask({
        question, selected: composer.selected, manual: composerSelection?.selected !== undefined,
        synthesize: composer.synth !== 'off', synthesizer: composer.synth && composer.synth !== 'off' ? composer.synth : undefined,
        sessionId: current ?? undefined,
        continueFrom: activeFollowUp?.targetId,
        memoryUpdates: current && pendingMemoryUpdates.length ? pendingMemoryUpdates : undefined,
      });
      setFollowUp(undefined);
      setPendingMemoryUpdates([]);
      setCurrent(ids.sessionId);
      refreshSessions();
      return true;
    } catch (err) { notify(errText(err), 'err'); return false; }
  };

  const actions: TurnActions = {
    zoom: (turnId, runId) => setZoom(runId ? { turnId, runId } : undefined),
    exec: (turnId, from) => { unify.previewExec(turnId, from).then(setExecPreview, (err) => notify(errText(err), 'err')); },
    retry: (turnId, targetIds) => {
      unify.retry(turnId, targetIds).then((ids) => { setCurrent(ids.sessionId); refreshSessions(); }, (err) => notify(errText(err), 'err'));
    },
    cancel: (turnId) => { void unify.cancel(turnId); },
    cancelTarget: (turnId, targetId) => { void unify.cancelTarget(turnId, targetId); },
    respondInteraction: (turnId, interactionId, response) => {
      void unify.respondInteraction(turnId, interactionId, response).catch((err) => notify(errText(err), 'err'));
    },
    followUp: (choice) => setFollowUp(choice),
    distill: (source) => {
      unify.prepareDistill(source).then((prep) => setDistillModal({ source, prep }), (err) => notify(errText(err), 'err'));
    },
  };
  const cancelCurrent = () => { for (const t of turns) if (isActive(t)) void unify.cancel(t.id); };

  // ── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('.session-dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && zoom) { setZoom(undefined); return; }
      if (!mod || !ws) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void openSession(null); }
      else if (e.key === ',') { e.preventDefault(); setView('settings'); }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setSidebar((s) => !s); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ws, zoom, openSession]);

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
    if (rec && rec.sessionId !== current) void openSession(rec.sessionId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-interaction-id="${CSS.escape(item.request.id)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [records, current, openSession]);

  const zoomed = zoom && records[zoom.turnId];
  const zoomResult = zoomed && [...zoomed.results, ...(zoomed.synthesis ? [zoomed.synthesis.result] : [])].find((r) => r.runId === zoom.runId);
  const selectedLabels = ws?.targets.filter((t) => composer.selected.includes(t.id)) ?? [];

  if (ws === undefined) return <div className="boot"><Spinner /></div>;

  return (
    <div className={`app ${platform}${sidebar && ws ? '' : ' no-side'}`}>
      <div className="titlebar">
        {ws && <button className="tb-btn" onClick={() => setSidebar(!sidebar)} title="侧栏 (Ctrl+B)"><Icon name="sidebar" /></button>}
        <div className="brand"><Icon name="spark" size={14} />Unify</div>
        {ws && (
          <>
            <span className="sep">/</span>
            <div className="tb-menu">
              <button className="tb-project" onClick={() => setMenu(!menu)} title={ws.cwd}><Icon name="folder" size={14} />{ws.name}<Icon name="chevron" size={12} /></button>
              {menu && (
                <>
                  <div className="menu-back" onClick={() => setMenu(false)} />
                  <div className="menu">
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
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
      </div>

      {ws && sidebar && (
        <aside className="sidebar">
          <button className="new-chat" onClick={() => void openSession(null)}><Icon name="plus" />新对话<kbd>Ctrl N</kbd></button>
          <SessionList key={ws.cwd} sessions={sessions} current={view === 'chat' ? current : null} live={liveSessions}
            open={(id) => void openSession(id)} update={updateSession} remove={deleteSession} onError={(msg) => notify(msg, 'err')} />
          <nav className="side-nav">
            <button className={view === 'quota' ? 'on' : ''} onClick={openQuota}><Icon name="gauge" />额度</button>
            <button className={view === 'memory' ? 'on' : ''} onClick={() => setView('memory')}><Icon name="layers" />记忆</button>
            <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}><Icon name="sliders" />设置<kbd>Ctrl ,</kbd></button>
          </nav>
        </aside>
      )}

      <main className="sheet">
        {pendingInteractions.length > 0 && view !== 'chat' && (
          <div style={{ padding: '10px 24px 0', maxWidth: 1120, width: '100%', margin: '0 auto' }}>
            <div className="interact-banner" role="status">
              <div className="interact-banner-left">
                <Icon name="alert" size={14} />
                <span>
                  <b>{pendingInteractions[0].targetLabel}</b> 等待交互：{pendingInteractions[0].request.title}
                  {pendingInteractions.length > 1 ? `（另有 ${pendingInteractions.length - 1} 项）` : ''}
                </span>
              </div>
              <button type="button" className="interact-banner-jump" onClick={() => jumpToInteraction(pendingInteractions[0])}>
                前往处理
              </button>
            </div>
          </div>
        )}
        {!ws ? <Welcome onOpen={(d) => void openWorkspace(d)} />
          : view === 'quota' ? <QuotaPage quota={quota} loading={quotaLoading} refresh={() => refreshQuota(true)} />
          : view === 'memory' ? <MemoryPage cwd={ws.cwd} notify={notify} />
          : view === 'settings' ? <SettingsPage ws={ws} onChange={setWs} notify={notify} />
          : (
            <>
              <div className="thread" ref={thread} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                {ws.configError && <div className="error block"><Icon name="alert" size={14} /><span>配置有误：{ws.configError}</span></div>}
                {turns.length === 0 ? (
                  <div className="hero">
                    <h1>想比较什么？</h1>
                    <p className="lede">
                      {selectedLabels.length
                        ? <>问题会同时发给 {selectedLabels.map((t, i) => <span key={t.id} className="hero-target" style={{ '--h': hue(t.id) } as React.CSSProperties}>{i > 0 && '、'}<i className="dot" />{t.label}</span>)}，回答并排显示，再匿名汇总。</>
                        : ws.targets.some((t) => t.installed === undefined) ? '正在检测可用的模型…'
                        : ws.targets.some((t) => t.installed) ? '从下方选择要提问的模型。'
                        : <button className="link" onClick={() => setView('settings')}>在设置中接入模型</button>}
                    </p>
                    <ul className="tips">
                      <li><b>并排</b>每个模型一列，实时流式输出；点 <Icon name="expand" size={12} /> 放大阅读。</li>
                      <li><b>追问</b>同一对话里继续提问，会带上之前的汇总作为上下文。</li>
                      <li><b>实施</b>选一个回答或汇总，交给支持实施的模型修改项目文件。</li>
                    </ul>
                  </div>
                ) : turns.map((r) => (
                  <Turn
                    key={r.id} record={r} notices={notices[r.id] ?? []} activity={activity} interactions={interactions} showReasoning={ws.showReasoning} actions={actions}
                    isLatestComparison={r.id === latestComparisonId} followUp={activeFollowUp}
                  />
                ))}
              </div>
              {pendingInteractions.length > 0 && (
                <div style={{ padding: '0 24px', maxWidth: 1120, width: '100%', margin: '0 auto' }}>
                  <div className="interact-banner" role="status">
                    <div className="interact-banner-left">
                      <Icon name="alert" size={14} />
                      <span>
                        <b>{pendingInteractions[0].targetLabel}</b> 等待交互：{pendingInteractions[0].request.title}
                        {pendingInteractions.length > 1 ? `（另有 ${pendingInteractions.length - 1} 项）` : ''}
                      </span>
                    </div>
                    <button type="button" className="interact-banner-jump" onClick={() => jumpToInteraction(pendingInteractions[0])}>
                      定位处理
                    </button>
                  </div>
                </div>
              )}
              <Composer
                ws={ws} quota={quotaMap} busy={busy} state={composer} onToggleTarget={toggleTarget}
                onSynthesisChange={(synth) => changeComposerSelection({ ...composerSelection, synth })}
                onSend={send} onCancel={cancelCurrent} autoFocusKey={`${ws.cwd}:${current}`}
                followUp={activeFollowUp} onClearFollowUp={() => setFollowUp(undefined)}
                pendingMemoryUpdates={pendingMemoryUpdates} onClearMemoryUpdates={() => setPendingMemoryUpdates([])}
              />
            </>
          )}
        {zoomed && zoomResult && (
          <div className="zoom-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setZoom(undefined); }}>
            <Card
              record={zoomed} result={zoomResult} zoomed showReasoning={ws?.showReasoning ?? false} activity={activity[zoomResult.runId]} interactions={interactions[zoomResult.runId]} actions={actions}
              kind={zoomed.synthesis?.result.runId === zoomResult.runId ? 'synthesis' : zoomed.kind === 'execution' ? 'exec' : 'answer'}
            />
          </div>
        )}
      </main>

      {execPreview && (
        <ExecDialog
          initial={execPreview} onClose={() => setExecPreview(undefined)}
          onError={(m) => notify(m, 'err')}
          onStarted={(ids) => { setExecPreview(undefined); setCurrent(ids.sessionId); setView('chat'); refreshSessions(); }}
        />
      )}
      {distillModal && (
        <DistillDialog
          initial={distillModal.prep}
          source={distillModal.source}
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
      {toast && <div key={toast.id} className={`toast ${toast.kind}`} role="status">{toast.msg}</div>}
      {quotaNotice && (
        <aside className="quota-notice" aria-label="套餐额度提醒">
          <div className="quota-notice-content" role="status">
            <header><Icon name="gauge" /><strong>{quotaNotice.title}</strong></header>
            <ul>{quotaNotice.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </div>
          <button className="quota-notice-close" type="button" aria-label="关闭额度提醒" onClick={() => setQuotaNotice(undefined)}><Icon name="x" size={14} /></button>
          <button className="btn" type="button" onClick={openQuota}>查看额度</button>
        </aside>
      )}
    </div>
  );
}
