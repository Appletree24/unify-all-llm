import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ExecPreview, Push, RunRecord, SessionSummary, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { onPush, unify } from './api.js';
import { MemoryPage, QuotaPage, SettingsPage, Welcome } from './Pages.js';
import { Card, Composer, ExecDialog, Turn, type Activity, type ComposerState, type TurnActions } from './Thread.js';
import { Icon, Spinner, hue, isActive } from './ui.js';

type View = 'chat' | 'quota' | 'memory' | 'settings';
interface Toast { id: number; msg: string; kind: 'ok' | 'err' | 'info' }
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const QUOTA_MS = 60_000;

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000;
  return diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff < 7 ? '7 天内' : diff < 30 ? '30 天内' : '更早';
}

export function App() {
  const [platform, setPlatform] = useState<string>('');
  const [ws, setWs] = useState<WorkspaceInfo | null | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<string, RunRecord>>({});
  const [activity, setActivity] = useState<Record<string, Activity[]>>({});
  const [notices, setNotices] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<View>('chat');
  const [quota, setQuota] = useState<TargetQuota[]>();
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [toast, setToast] = useState<Toast>();
  const [execPreview, setExecPreview] = useState<ExecPreview>();
  const [zoom, setZoom] = useState<{ turnId: string; runId: string }>();
  const [composer, setComposer] = useState<ComposerState>({ selected: [], manual: false, synth: '' });
  const [sidebar, setSidebar] = useState(true);
  const [menu, setMenu] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const cwd = ws?.cwd;

  const notify = useCallback((msg: string, kind: Toast['kind'] = 'info') => setToast({ id: Date.now(), msg, kind }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), toast.kind === 'err' ? 6000 : 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshSessions = useCallback(() => { unify.sessions().then(setSessions, () => undefined); }, []);
  const refreshQuota = useCallback((force = false) => {
    setQuotaLoading(true);
    unify.quota(force).then(setQuota, () => undefined).finally(() => setQuotaLoading(false));
  }, []);

  // ── bootstrap and pushes ────────────────────────────────────────────────
  useEffect(() => {
    void unify.platform().then(setPlatform);
    void unify.workspace().then(setWs);
    return onPush((p: Push) => {
      if (p.type === 'run') setRecords((r) => ({ ...r, [p.record.id]: p.record }));
      else if (p.type === 'activity') setActivity((a) => ({ ...a, [p.runId]: [...(a[p.runId] ?? []), { name: p.name, detail: p.detail }] }));
      else if (p.type === 'notice') setNotices((n) => ({ ...n, [p.turnId]: [...(n[p.turnId] ?? []), p.message] }));
      else if (p.type === 'workspace') setWs((w) => (w && w.cwd === p.info.cwd ? p.info : w));
      else if (p.type === 'end') { refreshSessions(); refreshQuota(); }
    });
  }, [refreshSessions, refreshQuota]);

  // A different project starts from a clean slate.
  useEffect(() => {
    setCurrent(null);
    setRecords({});
    setActivity({});
    setNotices({});
    setQuota(undefined);
    setComposer({ selected: [], manual: false, synth: '' });
    if (!cwd) return;
    refreshSessions();
    refreshQuota();
    const t = setInterval(() => refreshQuota(), QUOTA_MS);
    return () => clearInterval(t);
  }, [cwd, refreshSessions, refreshQuota]);

  // Follow the configured defaults until the user picks targets by hand.
  useEffect(() => {
    if (!ws) return;
    setComposer((c) => {
      const valid = c.selected.filter((id) => ws.targets.some((t) => t.id === id && t.installed !== false));
      return c.manual ? { ...c, selected: valid } : { ...c, selected: ws.defaults };
    });
  }, [ws]);

  useEffect(() => { if (menu) void unify.recentWorkspaces().then(setRecent); }, [menu]);

  const openWorkspace = useCallback(async (dir?: string) => {
    setMenu(false);
    try {
      const info = await unify.openWorkspace(dir);
      if (info) { setWs(info); setView('chat'); }
    } catch (err) { notify(errText(err), 'err'); }
  }, [notify]);

  const openSession = useCallback(async (id: string | null) => {
    setCurrent(id);
    setView('chat');
    setZoom(undefined);
    if (!id) return;
    try {
      const runs = await unify.session(id);
      setRecords((r) => {
        const next = { ...r };
        for (const run of runs) if (!(next[run.id] && isActive(next[run.id]))) next[run.id] = run;
        return next;
      });
    } catch (err) { notify(errText(err), 'err'); }
  }, [notify]);

  // ── derived ─────────────────────────────────────────────────────────────
  const turns = useMemo(
    () => Object.values(records).filter((r) => r.sessionId === current).sort((a, b) => a.id.localeCompare(b.id)),
    [records, current],
  );
  const busy = turns.some(isActive);
  const liveSessions = useMemo(() => new Set(Object.values(records).filter(isActive).map((r) => r.sessionId)), [records]);
  const quotaMap = useMemo(() => new Map((quota ?? []).map((q) => [q.targetId, q])), [quota]);
  const grouped = useMemo(() => {
    const out: [string, SessionSummary[]][] = [];
    for (const s of sessions) {
      const g = dayGroup(s.updatedAt);
      const last = out[out.length - 1];
      if (last && last[0] === g) last[1].push(s); else out.push([g, [s]]);
    }
    return out;
  }, [sessions]);

  // ── actions ─────────────────────────────────────────────────────────────
  const send = async (question: string): Promise<boolean> => {
    try {
      const ids = await unify.ask({
        question, selected: composer.selected, manual: composer.manual,
        synthesize: composer.synth !== 'off', synthesizer: composer.synth && composer.synth !== 'off' ? composer.synth : undefined,
        sessionId: current ?? undefined,
      });
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
  };
  const cancelCurrent = () => { for (const t of turns) if (isActive(t)) void unify.cancel(t.id); };

  // ── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
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
            {ws.branch && <span className="tb-branch"><Icon name="branch" size={13} />{ws.branch}</span>}
          </>
        )}
      </div>

      {ws && sidebar && (
        <aside className="sidebar">
          <button className="new-chat" onClick={() => void openSession(null)}><Icon name="plus" />新对话<kbd>Ctrl N</kbd></button>
          <nav className="sessions">
            {grouped.length === 0 && <p className="side-empty">还没有对话记录</p>}
            {grouped.map(([group, list]) => (
              <div key={group} className="session-group">
                <div className="label">{group}</div>
                {list.map((s) => (
                  <button key={s.id} className={`session${current === s.id && view === 'chat' ? ' on' : ''}`} onClick={() => void openSession(s.id)} title={s.title}>
                    <span className="session-title">{s.title || '（空问题）'}</span>
                    {liveSessions.has(s.id) ? <Spinner /> : s.turns > 1 ? <small>{s.turns}</small> : s.hasExec ? <Icon name="run" size={12} /> : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <nav className="side-nav">
            <button className={view === 'quota' ? 'on' : ''} onClick={() => setView('quota')}><Icon name="gauge" />额度</button>
            <button className={view === 'memory' ? 'on' : ''} onClick={() => setView('memory')}><Icon name="layers" />记忆</button>
            <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}><Icon name="sliders" />设置<kbd>Ctrl ,</kbd></button>
          </nav>
        </aside>
      )}

      <main className="sheet">
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
                        : <>没有可用的模型。<button className="link" onClick={() => setView('settings')}>在设置中接入官方 API</button>，或安装并登录 Codex、Gemini、Claude Code 等 CLI。</>}
                    </p>
                    <ul className="tips">
                      <li><b>并排</b>每个模型一列，实时流式输出；点 <Icon name="expand" size={12} /> 放大阅读。</li>
                      <li><b>追问</b>同一对话里继续提问，会带上之前的汇总作为上下文。</li>
                      <li><b>实施</b>选一个回答或汇总，交给支持实施的模型修改项目文件。</li>
                    </ul>
                  </div>
                ) : turns.map((r) => (
                  <Turn key={r.id} record={r} notices={notices[r.id] ?? []} activity={activity} showReasoning={ws.showReasoning} actions={actions} />
                ))}
              </div>
              <Composer
                ws={ws} quota={quotaMap} busy={busy} state={composer} setState={setComposer}
                onSend={send} onCancel={cancelCurrent} autoFocusKey={`${ws.cwd}:${current}`}
              />
            </>
          )}
        {zoomed && zoomResult && (
          <div className="zoom-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setZoom(undefined); }}>
            <Card
              record={zoomed} result={zoomResult} zoomed showReasoning={ws?.showReasoning ?? false} activity={activity[zoomResult.runId]} actions={actions}
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
      {toast && <div key={toast.id} className={`toast ${toast.kind}`} role="status">{toast.msg}</div>}
    </div>
  );
}
