import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { SESSION_TITLE_LIMIT, type SessionChanges, type SessionSummary } from '../shared/api.js';
import { Icon, Spinner, ACTIVE } from './ui.js';

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const diff = (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
  return diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff < 7 ? '7 天内' : diff < 30 ? '30 天内' : '更早';
}

interface SessionListProps {
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

export function SessionList({ sessions, current, live, open, update, remove, onError }: SessionListProps) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLButtonElement }>();
  const [dialog, setDialog] = useState<{ action: SessionAction; session: SessionSummary }>();
  const menuItems = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!menu) return;
    menuItems.current?.querySelector('button')?.focus({ preventScroll: true });
    const close = () => setMenu(undefined);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [menu]);

  const closeMenu = () => {
    menu?.anchor.focus({ preventScroll: true });
    setMenu(undefined);
  };

  const search = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      if (search && !session.title.toLowerCase().includes(search)) continue;
      const group = session.pinned ? '置顶' : dayGroup(session.updatedAt);
      const items = groups.get(group);
      if (items) items.push(session);
      else groups.set(group, [session]);
    }
    return groups;
  }, [sessions, search]);

  const anchor = menu?.anchor.getBoundingClientRect();
  const menuStyle = anchor && {
    left: Math.min(anchor.right - 8, window.innerWidth - 176),
    ...(anchor.top + 130 < window.innerHeight ? { top: anchor.top } : { bottom: window.innerHeight - anchor.bottom }),
  };

  return (
    <>
      <label className="session-search">
        <Icon name="search" size={15} />
        <input type="search" aria-label="搜索对话标题" placeholder="搜索对话标题" value={query}
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <nav className="sessions" aria-label="对话历史" onScroll={() => setMenu(undefined)}>
        {!groups.size && <p className="side-empty">{search ? '没有匹配的对话' : '还没有对话记录'}</p>}
        {[...groups].map(([group, list]) => (
          <div key={group} className="session-group">
            <div className="label">{group}</div>
            {list.map((session) => {
              const { id, title, pinned } = session;
              const label = title || '（空问题）';
              const selected = current === id;
              const active = live.has(id) || ACTIVE.includes(session.status);
              const expanded = menu?.id === id;
              return (
                <div key={id} className={`session-row${selected ? ' on' : ''}`} onContextMenu={(event) => {
                  event.preventDefault();
                  const anchor = event.currentTarget.querySelector<HTMLButtonElement>('.session-actions');
                  if (anchor) setMenu({ id, anchor });
                }}>
                  <button type="button" className="session" title={label} aria-current={selected ? 'true' : undefined}
                    onClick={() => { setMenu(undefined); open(id); }}>
                    {pinned && <Icon name="pin" size={12} />}
                    <span className="session-title">{label}</span>
                    {active ? <Spinner /> : session.turns > 1 ? <small>{session.turns}</small> : session.hasExec ? <Icon name="run" size={12} /> : null}
                  </button>
                  <button type="button" className="session-actions" title="对话操作" aria-label={`对话操作：${label}`}
                    aria-expanded={expanded} onClick={(event) => setMenu(expanded ? undefined : { id, anchor: event.currentTarget })}
                    onKeyDown={(event) => { if (expanded && event.key === 'Escape') closeMenu(); }}>
                    <Icon name="more" size={16} />
                  </button>
                  {expanded && (
                    <>
                      <div className="menu-back" aria-hidden="true" onClick={closeMenu} />
                      <div className="session-menu" role="group" aria-label="对话操作" style={menuStyle} ref={menuItems}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== menu.anchor) setMenu(undefined);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          event.stopPropagation();
                          closeMenu();
                        }}>
                        <button type="button" onClick={() => { closeMenu(); setDialog({ action: 'rename', session }); }}>
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
                          onClick={() => { if (!active) { closeMenu(); setDialog({ action: 'delete', session }); } }}>
                          <Icon name="trash" size={15} />删除对话
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      {dialog && (
        <SessionDialog action={dialog.action} session={dialog.session} onClose={() => setDialog(undefined)}
          onSubmit={(title) => dialog.action === 'delete' ? remove(dialog.session.id) : update(dialog.session.id, { title })} />
      )}
    </>
  );
}

function SessionDialog({ action, session, onClose, onSubmit }: {
  action: SessionAction; session: SessionSummary; onClose(): void; onSubmit(title: string): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deleting = action === 'delete';

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.select();
    return () => element?.close();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (!deleting && !title.trim())) return;
    setBusy(true);
    setError('');
    try { await onSubmit(title); onClose(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <dialog className="modal session-dialog" ref={dialog} aria-labelledby="session-dialog-title"
      aria-describedby={deleting ? 'session-delete-description' : undefined}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="session-dialog-title">{deleting ? '删除对话' : '重命名对话'}</h2>
        {deleting ? (
          <p id="session-delete-description" className="lede">「{session.title || '（空问题）'}」的所有轮次、回答和实施记录都将移到系统回收站。</p>
        ) : (
          <input ref={input} aria-label="对话标题" value={title} maxLength={SESSION_TITLE_LIMIT} disabled={busy}
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
