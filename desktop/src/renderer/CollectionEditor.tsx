import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { Collection } from '../shared/api.js';
type Props = {
  initial?: Collection;
  cases: { id: string; title: string }[];
  onSave: (name: string, caseIds: string[]) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
};

export function CollectionEditor({ initial, cases, onSave, onDelete, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [selected, setSelected] = useState(() => new Set<string>(initial?.caseIds ?? []));
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = pending !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    nameRef.current?.focus();
    nameRef.current?.select();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const visibleCases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? cases.filter((c) => c.title.toLowerCase().includes(q)) : cases;
  }, [cases, query]);

  const close = () => { if (!busy) onClose(); };

  const toggle = (id: string) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (kind: 'save' | 'delete', action: () => Promise<void>, label: string) => {
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error && err.message ? `${label}失败：${err.message}` : `${label}失败，请重试`);
      setPending(null);
    }
  };

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    if (busy || confirmDelete) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入分组名称');
      nameRef.current?.focus();
      return;
    }
    void run('save', () => onSave(trimmed, [...selected]), '保存');
  };

  return (
    <dialog
      ref={dialogRef}
      className="collection-editor"
      aria-labelledby="collection-editor-title"
      onCancel={(e) => { e.preventDefault(); close(); }}
    >
      <form className="collection-editor-form" onSubmit={handleSave} aria-busy={busy}>
        <header className="collection-editor-head">
          <h2 id="collection-editor-title">{initial ? '编辑分组' : '新建分组'}</h2>
          <button type="button" className="bench-icon-btn" aria-label="关闭" disabled={busy} onClick={close}>×</button>
        </header>

        <label className="collection-field">
          <span>名称</span>
          <input ref={nameRef} maxLength={100} className="collection-input" value={name} disabled={busy} placeholder="输入分组名称" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="collection-members-head">
          <span>包含案例</span>
          <span className="bench-muted">已选 {selected.size} / {cases.length}</span>
        </div>

        <input type="search" className="collection-input collection-filter" value={query} disabled={busy} placeholder="按标题过滤案例…" aria-label="按标题过滤案例" onChange={(e) => setQuery(e.target.value)} />

        <div className="collection-members" role="group" aria-label="案例列表">
          {visibleCases.length === 0 ? (
            <p className="bench-muted collection-empty">{cases.length === 0 ? '暂无案例，可直接保存为空分组' : '没有匹配的案例'}</p>
          ) : visibleCases.map((c) => (
            <label key={c.id} className="collection-member">
              <input type="checkbox" checked={selected.has(c.id)} disabled={busy} onChange={() => toggle(c.id)} />
              <span>{c.title}</span>
            </label>
          ))}
        </div>

        {error && <p className="collection-error" role="alert">{error}</p>}

        {initial && onDelete && confirmDelete && (
          <div className="collection-delete-confirm" role="alert">
            <p>确认删除「{initial.name}」？此操作仅删除分组，库中所有案例均会完整保留。</p>
            <div className="collection-delete-actions">
              <button type="button" className="bench-btn" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
              <button type="button" className="bench-btn" data-variant="danger" disabled={busy} onClick={() => { if (!busy) void run('delete', onDelete, '删除'); }}>
                {pending === 'delete' ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        )}

        <footer className="collection-actions">
          {initial && onDelete && !confirmDelete && (
            <button type="button" className="bench-btn" data-variant="danger" disabled={busy} onClick={() => { setError(null); setConfirmDelete(true); }}>
              删除分组
            </button>
          )}
          {!confirmDelete && <div className="collection-actions-end">
            <button type="button" className="bench-btn" disabled={busy} onClick={close}>取消</button>
            <button type="submit" className="bench-btn" data-variant="primary" disabled={busy}>
              {pending === 'save' ? '保存中…' : '保存'}
            </button>
          </div>}
        </footer>
      </form>
    </dialog>
  );
}
