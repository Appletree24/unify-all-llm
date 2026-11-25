import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { SESSION_TITLE_LIMIT, type SessionChanges, type SessionSummary } from '../shared/api.js';
import { useAnimatedDialog, usePresence } from './motion.js';
import { Icon, Spinner, ACTIVE } from './ui.js';

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const diff = (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
  return diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff < 7 ? '7 天内' : diff < 30 ? '30 天内' : '更早';
}

export interface SessionIndex {
  sessions?: SessionSummary[];
  error?: string;
}

interface WorkspaceSessionsProps {
  sidebarOpen: boolean;
  query: string;
  setQuery(query: string): void;
  paths: string[];
  indexes: Record<string, SessionIndex>;
  activeCwd: string;
  current: string | null;
  live: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  toggle(cwd: string): void;
  add(): void;
  refresh(cwd: string): void;
  open(cwd: string, id: string | null): void;
  update(cwd: string, id: string, changes: SessionChanges): Promise<void>;
  remove(cwd: string, id: string): Promise<void>;
  onError(message: string): void;
}

const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).at(-1) || dir;
const noLiveSessions = new Set<string>();
const matches = (session: SessionSummary, search: string) => session.title.toLowerCase().includes(search);

export function WorkspaceSessions({ paths, indexes, activeCwd, current, expanded, live, add, toggle,
  open, refresh, update, remove, sidebarOpen, onError, query, setQuery }: WorkspaceSessionsProps) {
  const search = query.trim().toLowerCase();
  const names = paths.map(folderName);
  const noMatches = search && paths.every(dir => indexes[dir]?.sessions?.every(session => !matches(session, search)));

  return (
    <>
      <label className="session-search">
        <Icon name="search" size={15} />
        <input type="search" aria-label="搜索所有工作区的对话" placeholder="搜索所有工作区的对话" value={query}
          onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="workspaces-heading"><span>工作区</span>
        <button type="button" title="添加工作区" aria-label="添加工作区" onClick={add}><Icon name="plus" size={15} /></button>
      </div>
      <nav className="sessions" aria-label="按工作区浏览对话">
        {paths.map((dir, i) => (
          <WorkspaceGroup key={dir} dir={dir} name={names[i]} showPath={names.indexOf(names[i]) !== names.lastIndexOf(names[i])}
            index={indexes[dir]} expanded={expanded.has(dir)} search={search} active={dir === activeCwd}
            toggle={() => toggle(dir)} refresh={refresh} newChat={() => open(dir, null)}
            sidebarOpen={sidebarOpen} current={dir === activeCwd ? current : null} live={dir === activeCwd ? live : noLiveSessions}
            open={id => open(dir, id)} update={(id, changes) => update(dir, id, changes)} remove={id => remove(dir, id)} onError={onError} />
        ))}
        {noMatches && <p className="side-empty">没有匹配的对话</p>}
      </nav>
    </>
  );
}

function WorkspaceGroup({ dir, name, showPath, index, expanded, search, active, toggle, refresh, newChat, ...list }:
  Omit<SessionListProps, 'sessions'> & {
    dir: string; name: string; showPath: boolean; index?: SessionIndex; expanded: boolean; search: string;
    active: boolean; toggle(): void; refresh(cwd: string): void; newChat(): void;
  }) {
  const sectionId = useId();
  const visible = expanded || !!search;
  useEffect(() => { if (visible) refresh(dir); }, [visible, refresh, dir]);
  const sessions = useMemo(() => search ? index?.sessions?.filter(session => matches(session, search)) : index?.sessions, [index, search]);
  if (search && sessions?.length === 0) return null;

  return (
    <section className="workspace-group" aria-label={dir}>
      <div className={`workspace-heading${active ? ' active' : ''}`}>
        <button type="button" className="workspace-disclosure" title={dir} aria-expanded={visible} aria-controls={sectionId}
          disabled={!!search} onClick={toggle}>
          <Icon name="chevron" size={12} /><Icon name="folder" size={15} />
          <span className="workspace-name">{name}{showPath && <small>{dir}</small>}</span>
        </button>
        <button type="button" className="workspace-new" title={`在 ${name} 中新建对话`} aria-label={`在 ${dir} 中新建对话`}
          onClick={newChat}><Icon name="plus" size={14} /></button>
      </div>
      {visible && <div className="workspace-sessions" id={sectionId}>
        {index?.error ? <p className="side-empty" title={index.error}>无法读取对话 <button onClick={() => refresh(dir)}>重试</button></p>
          : !sessions ? <p className="side-empty"><Spinner /> 正在读取对话…</p>
          : !sessions.length ? <p className="side-empty">暂无对话</p>
          : <SessionList {...list} sessions={sessions} />}
      </div>}
    </section>
  );
}

interface SessionListProps {
  sidebarOpen: boolean;
  sessions: SessionSummary[];
  current: string | null;
  live: ReadonlySet<string>;
  open(id: string): void;
  update(id: string, changes: SessionChanges): Promise<void>;
  remove(id: string): Promise<void>;
  onError(message: string): void;
}

type SessionAction = 'rename' | 'delete';
const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

function SessionList({ sidebarOpen, sessions, current, live, open, update, remove, onError }: SessionListProps) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLButtonElement; style: CSSProperties }>();
  const [dialog, setDialog] = useState<{ key: number; action: SessionAction; session: SessionSummary }>();
  const dialogSequence = useRef(0);
  const openDialog = (action: SessionAction, session: SessionSummary) => {
    setDialog({ key: ++dialogSequence.current, action, session });
  };
  const menuPresence = usePresence(sidebarOpen ? menu : undefined);
  const dialogPresence = usePresence(dialog);
  const visibleDialog = dialogPresence.rendered;
  const menuItems = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => { if (!sidebarOpen) setMenu(undefined); }, [sidebarOpen]);
  useLayoutEffect(() => {
    if (!menu || !sidebarOpen) return;
    menuItems.current?.querySelector('button')?.focus({ preventScroll: true });
    const close = () => setMenu(undefined);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, sidebarOpen]);

  const openMenu = (id: string, anchor: HTMLButtonElement) => {
    const rect = anchor.getBoundingClientRect();
    setMenu({
      id, anchor, style: {
        left: Math.max(8, Math.min(rect.right - 8, window.innerWidth - 176)),
        ...(rect.top + 130 < window.innerHeight ? { top: rect.top } : { bottom: window.innerHeight - rect.bottom }),
      },
    });
  };

  const closeMenu = () => {
    menu?.anchor.focus({ preventScroll: true });
    setMenu(undefined);
  };

  const groups = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const group = session.pinned ? '置顶' : dayGroup(session.updatedAt);
      const items = groups.get(group);
      if (items) items.push(session);
      else groups.set(group, [session]);
    }
    return groups;
  }, [sessions]);

  return (
    <>
        {[...groups].map(([group, list]) => (
          <div key={group} className="session-group">
            <div className="label">{group}</div>
            {list.map((session) => {
              const { id, title, pinned } = session;
              const label = title || '（空问题）';
              const selected = current === id;
              const active = live.has(id) || ACTIVE.includes(session.status);
              const expanded = sidebarOpen && menu?.id === id;
              const visibleMenu = menuPresence.rendered;
              return (
                <div key={id} className={`session-row${selected ? ' on' : ''}`} onContextMenu={(event) => {
                  event.preventDefault();
                  const anchor = event.currentTarget.querySelector<HTMLButtonElement>('.session-actions');
                  if (anchor) openMenu(id, anchor);
                }}>
                  <button type="button" className="session" title={label} aria-current={selected ? 'true' : undefined}
                    onClick={() => { setMenu(undefined); open(id); }}>
                    {pinned && <Icon name="pin" size={12} />}
                    <span className="session-title">{label}</span>
                    {active ? <Spinner /> : session.turns > 1 ? <small>{session.turns}</small> : session.hasExec ? <Icon name="run" size={12} /> : null}
                  </button>
                  <button type="button" className="session-actions" title="对话操作" aria-label={`对话操作：${label}`}
                    aria-expanded={expanded} onClick={(event) => { if (expanded) closeMenu(); else openMenu(id, event.currentTarget); }}
                    onKeyDown={(event) => { if (expanded && event.key === 'Escape') closeMenu(); }}>
                    <Icon name="more" size={16} />
                  </button>
                  {visibleMenu?.id === id && createPortal(
                    <>
                      {expanded && <div className="menu-back" aria-hidden="true" onClick={closeMenu} />}
                      <div className="session-menu" role="group" aria-label="对话操作" style={visibleMenu.style} ref={menuItems}
                        data-presence={menuPresence.state} inert={!expanded}
                        onBlur={(event) => {
                          if (expanded && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== visibleMenu.anchor) setMenu(undefined);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          event.stopPropagation();
                          closeMenu();
                        }}>
                        <button type="button" onClick={() => { closeMenu(); openDialog('rename', session); }}>
                          <Icon name="edit" size={15} />重命名
                        </button>
                        <button type="button" onClick={() => {
                          closeMenu();
                          void update(id, { pinned: !pinned }).catch((err) => onError(errorMessage(err)));
                        }}>
                          <Icon name="pin" size={15} />{pinned ? '取消置顶' : '置顶'}
                        </button>
                        <button type="button" className="danger" aria-disabled={active}
                          title={active ? '请等待请求完成或先取消' : undefined}
                          onClick={() => { if (!active) { closeMenu(); openDialog('delete', session); } }}>
                          <Icon name="trash" size={15} />删除对话
                        </button>
                      </div>
                    </>, document.body,
                  )}
                </div>
              );
            })}
          </div>
        ))}
      {visibleDialog && (
        <SessionDialog key={visibleDialog.key} action={visibleDialog.action} session={visibleDialog.session}
          open={dialogPresence.state === 'open'} onClose={() => setDialog(undefined)}
          onSubmit={(title) => visibleDialog.action === 'delete'
            ? remove(visibleDialog.session.id) : update(visibleDialog.session.id, { title })} />
      )}
    </>
  );
}

function SessionDialog({ action, session, open, onClose, onSubmit }: {
  action: SessionAction; session: SessionSummary; open: boolean; onClose(): void; onSubmit(title: string): Promise<void>;
}) {
  const dialog = useAnimatedDialog(open);
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deleting = action === 'delete';

  useLayoutEffect(() => { if (open) input.current?.select(); }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (!deleting && !title.trim())) return;
    setBusy(true);
    setError('');
    try { await onSubmit(title); onClose(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <dialog className="modal session-dialog" ref={dialog} aria-labelledby="session-dialog-title" inert={!open}
      aria-describedby={deleting ? 'session-delete-description' : undefined}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="session-dialog-title">{deleting ? '删除对话' : '重命名对话'}</h2>
        {deleting ? (
          <p id="session-delete-description" className="lede">「{session.title || '（空问题）'}」的所有轮次、回答和实施记录都将移到系统回收站。</p>
        ) : (
          <input ref={input} autoFocus aria-label="对话标题" value={title} maxLength={SESSION_TITLE_LIMIT} disabled={busy}
            onChange={(event) => setTitle(event.target.value)} />
        )}
        {error && <p className="session-dialog-error" role="alert">{error}</p>}
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className={`btn ${deleting ? 'danger' : 'primary'}`} disabled={busy || (!deleting && !title.trim())}>
            {busy && <Spinner />}{deleting ? '删除对话' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
