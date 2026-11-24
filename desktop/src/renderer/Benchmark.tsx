import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BenchCase, BenchIndex, BenchResult, Collection, WorkspaceInfo } from '../shared/api.js';
import { caseSchema } from '../../../src/bench/schema.js';
import { unify } from './api.js';
import { Icon, Spinner } from './ui.js';
import { CollectionEditor } from './CollectionEditor.js';
import './Benchmark.css';

type View = 'home' | 'candidate' | 'draft' | 'case' | 'suite' | 'revision';
type Filter = 'all' | 'cases' | 'drafts' | 'candidates';
type BenchKind = BenchCase['review']['grader']['kind'];
type CandidateItem = BenchIndex['candidates'][number];

const KIND_LABEL: Record<BenchKind, string> = {
  rubric: '开放评审',
  exact: '精确答案',
  javascript: 'JavaScript 用例',
  patch: '补丁校验',
};
const STATUS_LABEL: Record<BenchResult['status'], string> = {
  pass: '通过',
  fail: '未通过',
  error: '运行错误',
};

function normalizeCase(c: BenchCase): BenchCase {
  if (c.review.grader.kind !== 'rubric') return c;
  return {
    ...c,
    review: {
      ...c.review,
      grader: { ...c.review.grader, criteria: c.review.grader.criteria.map(s => s.trim()).filter(Boolean) },
    },
  };
}

function validateCase(value: unknown): { ok: true; data: BenchCase } | { ok: false; message: string } {
  const parsed = caseSchema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: issue?.message ? `草稿校验未通过：${issue.message}` : '草稿格式或必填项有误，请检查题面、参考答案与评审标准。' };
}

export function BenchmarkPage({ ws, visible }: { ws: WorkspaceInfo; visible: boolean }) {
  const cwd = ws.cwd;
  const page = useRef<HTMLElement>(null);
  const targets = ws.targets.filter(t => t.installed !== false);
  const [index, setIndex] = useState<BenchIndex>();
  const [view, setView] = useState<View>('home');
  const [filter, setFilter] = useState<Filter>('all');
  const [scopeId, setScopeId] = useState('');
  const [destination, setDestination] = useState('');
  const [query, setQuery] = useState('');
  const [collectionEditor, setCollectionEditor] = useState<Collection | 'new'>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const originalDraft = useRef<BenchCase>(undefined);
  const [id, setId] = useState('');
  const [selectedModel, setModel] = useState<string>();
  const [participants, setParticipants] = useState<string[]>();
  const [candidate, setCandidate] = useState<CandidateItem>();
  const [evidence, setEvidence] = useState<{ question: string; answer: string; followUp: string }>();
  const [note, setNote] = useState('');
  const [commit, setCommit] = useState('');
  const [paths, setPaths] = useState('');
  const [data, setData] = useState<BenchCase>();
  const [advanced, setAdvanced] = useState('');
  const [invalidMsg, setInvalidMsg] = useState('');
  const [results, setResults] = useState<BenchResult[]>([]);
  const [dirty, setDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!visible) return;
    let active = true;
    unify.benchIndex(cwd).then(v => { if (active) setIndex(v); }, e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [cwd, visible]);

  useLayoutEffect(() => { page.current?.scrollTo(0, 0); }, [view, id]);
  useLayoutEffect(() => {
    if (pendingNav || error) page.current?.scrollTo(0, 0);
  }, [pendingNav, error]);

  useEffect(() => {
    if (view === 'home' && index && scopeId && !index.collections.some(c => c.id === scopeId)) setScopeId('');
  }, [index, view, scopeId]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  if (!visible) return null;

  const model = [selectedModel ?? ws.synthesizer, ...ws.defaults, targets[0]?.id].find(id => targets.some(t => t.id === id)) ?? '';
  const activeParticipants = (participants ?? ws.defaults).filter(p => targets.some(t => t.id === p));
  const collection = index?.collections.find(c => c.id === scopeId);
  const members = new Set(collection?.caseIds);
  const scopeCases = (index?.cases ?? []).filter(c => !scopeId || members.has(c.id));
  const suiteLabel = scopeId ? '分组对照' : '整库对照';
  const needsJudge = view === 'case' ? data?.review.grader.kind === 'rubric' : scopeCases.some(c => c.kind === 'rubric');

  function resetDetail() {
    originalDraft.current = undefined;
    setConfirmDelete(false); setDestination(scopeId);
    setId(''); setCandidate(undefined); setEvidence(undefined); setNote(''); setCommit(''); setPaths('');
    setData(undefined); setAdvanced(''); setInvalidMsg(''); setResults([]); setDirty(false); setError(''); setNotice('');
  }

  function guardNav(action: () => void) {
    if (busy) return;
    if (dirty) { setPendingNav(() => action); return; }
    setPendingNav(null);
    action();
  }

  async function perform(label: string, action: () => Promise<void>): Promise<boolean> {
    setBusy(label); setError(''); setNotice('');
    try { await action(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(''); }
  }

  function goHome() {
    guardNav(() => { resetDetail(); setView('home'); refreshIndex(); });
  }

  function refreshIndex() {
    void unify.benchIndex(cwd).then(setIndex, e => setError(e instanceof Error ? e.message : String(e)));
  }

  function openCandidate(item: CandidateItem) {
    guardNav(() => {
      resetDetail(); setView('candidate'); setId(item.id); setCandidate(item); setNote(item.note ?? '');
      void perform('正在读取线索内容', async () => { setEvidence(await unify.benchEvidence(cwd, item.id)); });
    });
  }

  function openDraftById(draftId: string) {
    guardNav(() => {
      resetDetail(); setView('draft'); setId(draftId);
      void perform('正在读取草稿', async () => {
        const c = await unify.benchRead(cwd, draftId, false);
        originalDraft.current = c;
        setData(c); setAdvanced(JSON.stringify(c, null, 2));
      });
    });
  }

  function openCaseById(caseId: string) {
    guardNav(() => {
      resetDetail(); setView('case'); setId(caseId);
      void perform('正在读取案例', async () => {
        const c = await unify.benchRead(cwd, caseId, true);
        setData(c); setAdvanced(JSON.stringify(c, null, 2));
      });
    });
  }

  function openSuite() {
    guardNav(() => { resetDetail(); setView('suite'); });
  }

  async function loadSavedDraft(savedId: string, c: BenchCase, msg: string) {
    resetDetail();
    originalDraft.current = c;
    setView('draft'); setId(savedId); setData(c); setAdvanced(JSON.stringify(c, null, 2));
    setIndex(await unify.benchIndex(cwd));
    setNotice(msg);
  }

  function newCase() {
    const blank: BenchCase = {
      version: 1, task: { title: '', prompt: '', files: [] },
      review: { skill: '', negative: '', positive: '', grader: { kind: 'rubric', criteria: [''], perCriterion: true } },
    };
    resetDetail(); setView('draft'); setData(blank); setAdvanced(JSON.stringify(blank, null, 2));
    setInvalidMsg('请填写标题、任务、考察重点、参考答案和至少一条标准。');
  }

  function selectCollection(next: string) {
    setNotice(''); setError(''); setScopeId(next); setFilter('all'); setQuery('');
  }

  async function removeEntry() {
    if (view !== 'case' && view !== 'draft' && view !== 'candidate') return;
    await perform('正在删除', async () => {
      await unify.benchDeleteEntry(cwd, view, id);
      resetDetail(); setView('home');
      setIndex(await unify.benchIndex(cwd));
      setNotice(view === 'case' ? '案例已从题库和所属案例集中移除。' : '条目已删除。');
    });
  }

  function updateDraftForm(next: BenchCase) {
    setData(next); setDirty(true); setNotice('');
    const normalized = normalizeCase(next);
    setAdvanced(JSON.stringify(normalized, null, 2));
    const checked = validateCase(normalized);
    setInvalidMsg(checked.ok ? '' : checked.message);
  }

  function updateDraftJson(text: string) {
    setAdvanced(text); setDirty(true); setNotice('');
    try {
      const checked = validateCase(JSON.parse(text));
      if (checked.ok) { setData(checked.data); setInvalidMsg(''); }
      else setInvalidMsg(checked.message);
    } catch {
      setInvalidMsg('JSON 语法有误，请检查引号、逗号或括号匹配。');
    }
  }

  async function generateDraft() {
    await perform('正在根据线索整理草稿', async () => {
      const repoPaths = paths.split('\n').map(s => s.trim()).filter(Boolean);
      const repo = commit.trim() || repoPaths.length ? { commit: commit.trim(), paths: repoPaths } : undefined;
      const generated = await unify.benchDraft(cwd, id, model, note, repo);
      await loadSavedDraft(generated.id, generated.data, '已生成案例草稿，请审阅题面与评审标准。');
    });
  }

  async function saveCurrentDraft(): Promise<boolean> {
    return perform('正在保存草稿', async () => {
      const parsed = caseSchema.parse(JSON.parse(advanced));
      const previous = id && originalDraft.current ? { id, data: originalDraft.current } : undefined;
      const savedId = await unify.benchSaveDraft(cwd, parsed, previous);
      originalDraft.current = parsed;
      setId(savedId); setData(parsed); setAdvanced(JSON.stringify(parsed, null, 2));
      setDirty(false); setInvalidMsg('');
      setIndex(await unify.benchIndex(cwd));
      setNotice('草稿已保存。');
    });
  }

  async function publishCurrentDraft() {
    await perform('正在用错答与参考答对照校验并收录', async () => {
      const c = caseSchema.parse(JSON.parse(advanced));
      const options = view === 'revision' ? { previousId: id } : { collectionId: destination || undefined };
      const publishedId = await unify.benchPublish(cwd, c, c.review.grader.kind === 'rubric' ? model : undefined, options);
      setIndex(await unify.benchIndex(cwd));
      resetDetail(); setView('case'); setId(publishedId); setData(c); setAdvanced(JSON.stringify(c, null, 2));
      setNotice(view === 'revision' ? '新版已通过校验，所属案例集已更新。' : '对照校验已通过，案例已正式收录。');
    });
  }

  async function runBench(caseIds: string[]) {
    await perform(caseIds.length ? '正在运行本题模型对照' : '正在运行整库模型对照', async () => {
      setResults([]);
      const res = await unify.benchRun(cwd, caseIds, activeParticipants, needsJudge ? (model || undefined) : undefined, view === 'suite' ? scopeId || undefined : undefined);
      setResults(res);
      setNotice(`已完成 ${res.length} 份答卷评测。`);
    });
  }

  const totalCount = index ? index.cases.length + index.drafts.length + index.candidates.length : 0;
  const term = query.trim().toLowerCase();
  const matches = (item: { id: string; title: string; note?: string }) =>
    [item.title, item.id, item.note].some(value => value?.toLowerCase().includes(term));
  type Row = { id: string; title: string; note?: string; action: string; open: () => void };
  const groups: { key: Filter; title: string; icon: string; items: Row[]; empty: string }[] = view !== 'home' ? [] : [
    { key: 'cases', title: '已收录', icon: 'layers', empty: '收录后的案例会出现在这里。',
      items: scopeCases.filter(matches).map(c => ({ ...c, action: KIND_LABEL[c.kind], open: () => openCaseById(c.id) })) },
    { key: 'drafts', title: '草稿', icon: 'edit', empty: '从收藏线索或新建案例开始一份草稿。',
      items: (index?.drafts ?? []).filter(matches).map(d => ({ ...d, action: '草稿', open: () => openDraftById(d.id) })) },
    { key: 'candidates', title: '收藏线索', icon: 'bookmark', empty: '在对话回复旁点击「留题」，即可收藏线索。',
      items: (index?.candidates ?? []).filter(matches).map(c => ({ ...c, action: '线索', open: () => openCandidate(c) })) },
  ];
  const visibleGroups = groups.filter(group => scopeId ? group.key === 'cases' : filter === 'all' || group.key === filter);
  const collectionHits = !scopeId && term ? index?.collections.filter(c => c.name.toLowerCase().includes(term) || c.id.includes(term)) ?? [] : [];
  const isFreshEmpty = !!index && totalCount === 0 && index.collections.length === 0 && !scopeId && !term;
  const targetLabel = (tid: string) => targets.find(t => t.id === tid)?.label ?? tid;

  const judgePicker = (label: string) => (
    <label className="bench-inline-field">
      <span>{label}</span>
      <select className="bench-select" aria-label={label} value={model} onChange={e => setModel(e.target.value)}>
        <option value="" disabled>选择模型</option>
        {targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
    </label>
  );

  return (
    <section ref={page} className="page bench-page" aria-label="评测集">
      {view !== 'home' && (
        <nav className="bench-topbar" aria-label="评测集导航">
          <button type="button" className="bench-back" disabled={!!busy} onClick={goHome}>
            <span className="bench-ico bench-ico-back" aria-hidden="true"><Icon name="chevron" /></span>
            <span>返回评测集</span>
          </button>
          <span className="bench-crumb">
            {view === 'candidate' && '收藏线索'}
            {view === 'revision' && '修订已收录案例'}
            {view === 'draft' && (dirty ? '草稿 · 未保存' : '草稿')}
            {view === 'case' && (data ? `已收录 · ${KIND_LABEL[data.review.grader.kind]}` : '已收录案例')}
            {view === 'suite' && `${suiteLabel} · ${scopeCases.length} 题`}
          </span>
          {id && (view === 'case' || view === 'draft' || view === 'candidate') && (
            <button type="button" className="bench-btn bench-delete-entry" disabled={!!busy} onClick={() => { setConfirmDelete(true); page.current?.scrollTo(0, 0); }}>
              <Icon name="trash" size={14} />删除{view === 'case' ? '案例' : view === 'draft' ? '草稿' : '线索'}
            </button>
          )}
        </nav>
      )}

      {confirmDelete && (
        <div className="bench-banner" data-tone="warn" role="alertdialog" aria-label="确认删除条目">
          <p>删除「{data?.task.title ?? candidate?.title ?? id}」？{view === 'case' ? '它会从所有案例集中移除，历史版本仍可按 ID 读取。' : '删除后无法从此列表恢复。'}</p>
          <button className="bench-btn" disabled={!!busy} onClick={() => setConfirmDelete(false)}>取消</button>
          <button className="bench-btn" data-variant="danger" disabled={!!busy} onClick={() => void removeEntry()}>确认删除</button>
        </div>
      )}

      {index && collectionEditor && (
        <CollectionEditor initial={collectionEditor === 'new' ? undefined : collectionEditor} cases={index.cases}
          onClose={() => { setCollectionEditor(undefined); refreshIndex(); }}
          onSave={async (name, ids) => {
            const saved = await unify.benchSaveCollection(cwd, name, ids, collectionEditor === 'new' ? undefined : collectionEditor);
            setIndex(current => current && { ...current, collections: [...current.collections.filter(c => c.id !== saved.id), saved] });
            selectCollection(saved.id); setCollectionEditor(undefined); setNotice('案例集已保存。'); refreshIndex();
          }}
          onDelete={collectionEditor === 'new' ? undefined : async () => {
            await unify.benchDeleteCollection(cwd, collectionEditor);
            selectCollection(''); setCollectionEditor(undefined); setNotice('案例集已删除，题库中的案例已保留。'); refreshIndex();
          }}
        />
      )}

      {pendingNav && (
        <div className="bench-banner" data-tone="warn" role="alertdialog" aria-label="未保存的修改">
          <span className="bench-ico" aria-hidden="true"><Icon name="alert" /></span>
          <p>当前页面有尚未保存的改动，离开后将丢失这些修改。</p>
          <div className="bench-banner-actions">
            <button type="button" className="bench-btn" onClick={() => setPendingNav(null)}>继续编辑</button>
            {view === 'draft' && !invalidMsg && (
              <button type="button" className="bench-btn" data-variant="primary" onClick={() => void saveCurrentDraft().then(ok => {
                if (ok) { const next = pendingNav; setPendingNav(null); next(); }
              })}>保存并离开</button>
            )}
            <button type="button" className="bench-btn" data-variant="danger" onClick={() => {
              const next = pendingNav; setDirty(false); setPendingNav(null); next();
            }}>放弃改动</button>
          </div>
        </div>
      )}

      {busy && (
        <div className="bench-banner" data-tone="busy" role="status" aria-live="polite">
          <Spinner /><span>{busy}…</span>
        </div>
      )}
      {error && (
        <div className="bench-banner" data-tone="error" role="alert">
          <span className="bench-ico" aria-hidden="true"><Icon name="alert" /></span>
          <p>{error}</p>
          {index ? <button type="button" className="bench-icon-btn" aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="x" /></button>
            : <button type="button" className="bench-btn" onClick={() => void perform('正在读取案例集', async () => setIndex(await unify.benchIndex(cwd)))}>重试</button>}
        </div>
      )}
      {notice && !busy && !error && (
        <div className="bench-banner" data-tone="ok" role="status" aria-live="polite">
          <span className="bench-ico" aria-hidden="true"><Icon name="check" /></span>
          <p>{notice}</p>
          <button type="button" className="bench-icon-btn" aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="x" /></button>
        </div>
      )}

      {!index && !error && <div className="bench-loading"><Spinner /><span>正在加载评测集…</span></div>}

      {index && view === 'home' && (
        <div className={`bench-home${isFreshEmpty ? ' is-empty' : ''}`}>
          {isFreshEmpty ? (
            <div className="bench-empty-stage">
              <div className="bench-empty-mark" aria-hidden="true"><Icon name="bookmark" size={19} /></div>
              <h1>评测集</h1>
              <p className="bench-empty-lede">在对话回复旁点击「留题」收藏线索，或直接新建评测案例。</p>
              <div className="bench-empty-actions">
                <button type="button" className="bench-btn" data-variant="primary" disabled={!!busy} onClick={newCase}>
                  <Icon name="plus" size={15} />新建案例
                </button>
                <button type="button" className="bench-btn" disabled={!!busy} onClick={() => setCollectionEditor('new')}>
                  新建分组
                </button>
              </div>
            </div>
          ) : (
            <>
              <header className="bench-masthead">
                <div className="bench-masthead-title">
                  {collection && <p className="bench-eyebrow">{ws.name} · 评测集</p>}
                  <h1>{collection?.name ?? '评测集'}</h1>
                </div>
                <div className="bench-masthead-actions">
                  <button type="button" className="bench-btn" data-variant={scopeCases.length ? undefined : 'primary'} disabled={!!busy} onClick={newCase}>
                    <Icon name="plus" size={14} />新建案例
                  </button>
                  {scopeCases.length > 0 && (
                    <button type="button" className="bench-btn" data-variant="primary" disabled={!!busy} onClick={openSuite}>
                      <span className="bench-ico" aria-hidden="true"><Icon name="run" /></span>
                      <span>{suiteLabel}</span>
                    </button>
                  )}
                </div>
              </header>

              <div className="bench-library-tools">
                <div className="bench-scope-group">
                  <select className="bench-select" aria-label="选择分组" value={scopeId} disabled={!!busy} onChange={e => selectCollection(e.target.value)}>
                    <option value="">全部项目</option>
                    {index.collections.map(c => <option key={c.id} value={c.id}>{c.name}（{c.caseIds.length}）</option>)}
                  </select>
                  <button type="button" className="bench-btn bench-btn-subtle" disabled={!!busy} onClick={() => setCollectionEditor('new')}>
                    <Icon name="plus" size={14} />新建分组
                  </button>
                  {collection && (
                    <button type="button" className="bench-btn bench-btn-subtle" disabled={!!busy} onClick={() => setCollectionEditor(collection)}>
                      <Icon name="edit" size={13} />编辑分组
                    </button>
                  )}
                </div>
                <label className="bench-library-search">
                  <Icon name="search" size={14} />
                  <input
                    type="search"
                    aria-label="搜索案例"
                    placeholder={scopeId ? '搜索当前分组…' : '搜索案例、线索或分组…'}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                </label>
              </div>

              {!scopeId && (
                <div className="bench-tabs" role="group" aria-label="按阶段筛选">
                  {([
                    ['all', '全部', totalCount],
                    ['cases', '已收录', index.cases.length],
                    ['drafts', '草稿', index.drafts.length],
                    ['candidates', '收藏线索', index.candidates.length],
                  ] as const).map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={filter === key}
                      className="bench-tab"
                      data-active={filter === key || undefined}
                      onClick={() => setFilter(key)}
                    >
                      <span>{label}</span>
                      <span className="bench-count">{count}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="bench-sections">
                {collectionHits.length > 0 && (
                  <section className="bench-group" aria-label="匹配的分组">
                    <div className="bench-group-head"><h2><Icon name="folder" size={14} />分组</h2></div>
                    <ul className="bench-list">
                      {collectionHits.map(c => (
                        <li key={c.id}>
                          <button type="button" className="bench-row" onClick={() => selectCollection(c.id)}>
                            <span className="bench-row-body"><span className="bench-row-title">{c.name}</span></span>
                            <span className="bench-row-end">
                              <span className="bench-kind">{c.caseIds.length} 题</span>
                              <span className="bench-row-arrow" aria-hidden="true"><Icon name="chevron" size={13} /></span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {term && !collectionHits.length && visibleGroups.every(g => !g.items.length) && (
                  <p className="bench-empty-inline">没有找到与「{query.trim()}」匹配的条目。</p>
                )}

                {!term && totalCount === 0 && !scopeId && (
                  <div className="bench-empty-inline">
                    <p>当前项目还没有案例，点击右上角「新建案例」或在对话中「留题」开始。</p>
                  </div>
                )}

                {visibleGroups.map(group => {
                  if (!group.items.length && (term || (filter === 'all' && !scopeId))) return null;
                  return (
                    <section className="bench-group" key={group.key} aria-label={group.title}>
                      {!scopeId && <div className="bench-group-head"><h2><Icon name={group.icon} size={14} />{group.title}</h2></div>}
                      {group.items.length > 0 ? (
                        <ul className="bench-list">
                          {group.items.map(item => (
                            <li key={item.id}>
                              <button type="button" className="bench-row" disabled={!!busy} onClick={item.open}>
                                <span className="bench-row-body">
                                  <span className="bench-row-title">{item.title}</span>
                                  {item.note && <span className="bench-row-note">{item.note}</span>}
                                </span>
                                <span className="bench-row-end">
                                  <span className="bench-kind">{item.action}</span>
                                  <span className="bench-row-arrow" aria-hidden="true"><Icon name="chevron" size={13} /></span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : scopeId ? (
                        <div className="bench-empty-card">
                          <p>这个分组还是空的。</p>
                          <div className="bench-empty-actions">
                            {collection && (
                              <button type="button" className="bench-btn" disabled={!!busy} onClick={() => setCollectionEditor(collection)}>
                                <Icon name="edit" size={13} />添加已有案例
                              </button>
                            )}
                            <button type="button" className="bench-btn" data-variant="primary" disabled={!!busy} onClick={newCase}>
                              <Icon name="plus" size={14} />新建案例
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="bench-empty-inline">{group.empty}</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {index && view === 'candidate' && (
        <fieldset disabled={!!busy} className="bench-sheet">
          <div className="bench-cols">
            <article className="bench-main">
              <p className="bench-eyebrow">对话原题</p>
              <h1 className="bench-doc-title">{evidence?.question ?? candidate?.title ?? '读取线索中'}</h1>
              {evidence && (
                <>
                  <section className="bench-doc-block">
                    <h2>当时不满意的回答</h2>
                    <div className="bench-prose">{evidence.answer}</div>
                  </section>
                  {evidence.followUp && (
                    <section className="bench-followup">
                      <div className="bench-followup-head">
                        <h2>你在下一轮的追问纠正</h2>
                        <button type="button" className="bench-btn" onClick={() => { setNote(evidence.followUp); setDirty(true); }}>
                          采纳为期望说明
                        </button>
                      </div>
                      <p className="bench-prose">{evidence.followUp}</p>
                    </section>
                  )}
                </>
              )}
            </article>

            <aside className="bench-aside">
              <h2>整理为评测草稿</h2>
              <label className="bench-field">
                <span>你期望模型怎么做？</span>
                <textarea
                  rows={5}
                  value={note}
                  placeholder="说明哪里答偏了、遗漏了什么边界，或你理想中的处理方式（可选）"
                  onChange={e => { setNote(e.target.value); setDirty(true); }}
                />
              </label>

              <details className="bench-fold">
                <summary><span className="bench-ico" aria-hidden="true"><Icon name="branch" /></span>高级选项：引用 Git 仓库版本</summary>
                <div className="bench-fold-body">
                  <label className="bench-field">
                    <span>完整 commit SHA</span>
                    <input value={commit} placeholder="40 或 64 位十六进制提交哈希" onChange={e => { setCommit(e.target.value); setDirty(true); }} />
                  </label>
                  <label className="bench-field">
                    <span>关联仓库文件路径（每行一个）</span>
                    <textarea rows={3} value={paths} placeholder="例如：docs/release-notes.md" onChange={e => { setPaths(e.target.value); setDirty(true); }} />
                  </label>
                </div>
              </details>

              <div className="bench-action-stack">
                {judgePicker('出题模型')}
                <button type="button" className="bench-btn" data-variant="primary" disabled={!model || !evidence} onClick={() => void generateDraft()}>
                  <span className="bench-ico" aria-hidden="true"><Icon name="spark" /></span>
                  <span>生成案例草稿</span>
                </button>
              </div>
            </aside>
          </div>
        </fieldset>
      )}

      {index && (view === 'draft' || view === 'revision') && data && (
        <fieldset disabled={!!busy} className="bench-sheet">
          <DraftEditor
            data={data}
            advanced={advanced}
            invalidMsg={invalidMsg}
            modelPicker={data.review.grader.kind === 'rubric' ? judgePicker('校验与评审模型') : null}
            canPublish={!invalidMsg && (data.review.grader.kind !== 'rubric' || !!model)}
            onChangeForm={updateDraftForm}
            onChangeJson={updateDraftJson}
            destinationPicker={view === 'draft' && index.collections.length > 0 && (
              <label className="bench-inline-field">收录到<select className="bench-select" value={destination} onChange={e => setDestination(e.target.value)}>
                <option value="">项目题库</option>{index.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            )}
            onSave={view === 'draft' ? () => void saveCurrentDraft() : undefined}
            onPublish={() => void publishCurrentDraft()}
          />
        </fieldset>
      )}

      {index && (view === 'case' || view === 'suite') && (
        <fieldset disabled={!!busy} className="bench-sheet">
          {view === 'case' && data && (
            <div className="bench-case-doc">
              <header className="bench-doc-head">
                <p className="bench-eyebrow">{KIND_LABEL[data.review.grader.kind]}</p>
                <div className="bench-case-heading"><h1 className="bench-doc-title">{data.task.title}</h1>
                  <button className="bench-btn" onClick={() => { setConfirmDelete(false); setView('revision'); }}><Icon name="edit" size={14} />编辑案例</button>
                </div>
              </header>

              <section className="bench-doc-block">
                <h2>题面与材料（模型可见）</h2>
                <div className="bench-prose">{data.task.prompt}</div>
                <TaskMaterials task={data.task} />
              </section>

              <details className="bench-fold bench-review-panel">
                <summary><span className="bench-ico" aria-hidden="true"><Icon name="sliders" /></span>评审参考（仅评审可见：参考答案与判分标准）</summary>
                <div className="bench-fold-body">
                  <p className="bench-skill"><strong>考察重点：</strong>{data.review.skill}</p>
                  <div className="bench-contrast">
                    <div className="bench-contrast-card" data-polarity="neg">
                      <h3>代表性错答</h3>
                      <div className="bench-prose">{data.review.negative || '沿用原始起点'}</div>
                    </div>
                    <div className="bench-contrast-card" data-polarity="pos">
                      <h3>参考答案</h3>
                      <div className="bench-prose">{data.review.positive}</div>
                    </div>
                  </div>
                  <div className="bench-criteria-read">
                    <h3>判分依据</h3>
                    {data.review.grader.kind === 'rubric' ? (
                      <ol>{data.review.grader.criteria.map((c, i) => <li key={i}>{c}</li>)}</ol>
                    ) : data.review.grader.kind === 'exact' ? (
                      <div className="bench-prose">{data.review.grader.expected}</div>
                    ) : (
                      <pre className="bench-code">{JSON.stringify(data.review.grader, null, 2)}</pre>
                    )}
                  </div>
                </div>
              </details>
            </div>
          )}

          {view === 'suite' && (
            <header className="bench-doc-head">
              <p className="bench-eyebrow">{ws.name}</p>
              <h1 className="bench-doc-title">{collection?.name ?? suiteLabel}</h1>
              <p className="bench-muted">将对{scopeId ? '本集' : '全部'} {scopeCases.length} 道已收录案例逐题运行所选模型，并按题并排展示答卷与逐条评审理由。</p>
            </header>
          )}

          <section className="bench-runner" aria-label="模型对照配置">
            <div className="bench-runner-group">
              <span className="bench-runner-label">参评模型</span>
              <div className="bench-chips" role="group" aria-label="选择参评模型">
                {targets.map(t => {
                  const checked = activeParticipants.includes(t.id);
                  return (
                    <label key={t.id} className="bench-chip" data-checked={checked || undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => setParticipants(e.target.checked ? [...activeParticipants, t.id] : activeParticipants.filter(id => id !== t.id))}
                      />
                      <span>{t.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="bench-runner-bar">
              {needsJudge && judgePicker('开放题评审模型')}
              <button
                type="button"
                className="bench-btn"
                data-variant="primary"
                disabled={!activeParticipants.length || (needsJudge && !model) || (view === 'suite' && !scopeCases.length) || (view === 'case' && !data)}
                onClick={() => void runBench(view === 'case' ? [id] : [])}
              >
                <span className="bench-ico" aria-hidden="true"><Icon name="run" /></span>
                <span>{view === 'case' ? '运行本题对照' : scopeId ? '开始案例集对照' : '开始整库对照'}</span>
              </button>
            </div>
          </section>

          {results.length > 0 && (
            <ResultsBoard
              results={results}
              targetLabel={targetLabel}
              onOpenCase={view === 'suite' ? openCaseById : undefined}
            />
          )}
        </fieldset>
      )}
    </section>
  );
}

function TaskMaterials({ task }: { task: BenchCase['task'] }) {
  return <>
    {task.files.map(file => (
      <details className="bench-fold" key={file.path}>
        <summary>附件：{file.path}</summary>
        <pre className="bench-code">{file.content}</pre>
      </details>
    ))}
    {task.repository && (
      <details className="bench-fold">
        <summary><span className="bench-ico"><Icon name="branch" /></span>Git 版本 {task.repository.commit.slice(0, 12)}</summary>
        <pre className="bench-code">{[task.repository.commit, ...task.repository.paths].join('\n')}</pre>
      </details>
    )}
  </>;
}

function DraftEditor({
  data, advanced, invalidMsg, modelPicker, canPublish, destinationPicker, onChangeForm, onChangeJson, onSave, onPublish,
}: {
  data: BenchCase;
  advanced: string;
  invalidMsg: string;
  modelPicker: React.ReactNode;
  canPublish: boolean;
  onChangeForm: (next: BenchCase) => void;
  onChangeJson: (text: string) => void;
  destinationPicker: React.ReactNode;
  onSave?: () => void;
  onPublish: () => void;
}) {
  const { task, review } = data;
  const grader = review.grader;
  const isCodeGrader = grader.kind === 'javascript' || grader.kind === 'patch';

  function updateCriterion(idx: number, text: string) {
    if (grader.kind !== 'rubric') return;
    const next = grader.criteria.map((c, i) => (i === idx ? text : c));
    onChangeForm({ ...data, review: { ...review, grader: { ...grader, criteria: next } } });
  }

  function addCriterion() {
    if (grader.kind !== 'rubric') return;
    onChangeForm({ ...data, review: { ...review, grader: { ...grader, criteria: [...grader.criteria, ''] } } });
  }

  function removeCriterion(idx: number) {
    if (grader.kind !== 'rubric' || grader.criteria.length <= 1) return;
    const next = grader.criteria.filter((_, i) => i !== idx);
    onChangeForm({ ...data, review: { ...review, grader: { ...grader, criteria: next } } });
  }

  return (
    <div className="bench-editor">
      <div className="bench-editor-head">
        <span className="bench-kind">{KIND_LABEL[grader.kind]}</span>
        <div className="bench-editor-actions">
          {destinationPicker}
          {modelPicker}
          {onSave && <button type="button" className="bench-btn" disabled={!!invalidMsg} onClick={onSave}>保存草稿</button>}
          <button type="button" className="bench-btn" data-variant="primary" disabled={!canPublish} onClick={onPublish}>
            <span className="bench-ico" aria-hidden="true"><Icon name="check" /></span>
            <span>{onSave ? '对照校验并收录' : '校验并更新案例'}</span>
          </button>
        </div>
      </div>

      {invalidMsg && <p className="bench-inline-alert" role="alert">{invalidMsg}</p>}

      <div className="bench-cols bench-editor-cols">
        <section className="bench-main" aria-label="题面文稿">
          <p className="bench-eyebrow">题面文稿 · 参评模型可见</p>
          <label className="bench-field">
            <span className="bench-sr-only">案例标题</span>
            <input
              className="bench-title-input"
              aria-label="案例标题"
              placeholder="输入清晰描述场景的案例标题"
              value={task.title}
              onChange={e => onChangeForm({ ...data, task: { ...task, title: e.target.value } })}
            />
          </label>
          <label className="bench-field">
            <span>任务要求与原始材料</span>
            <textarea
              rows={11}
              value={task.prompt}
              placeholder="写明要求并附上真实上下文材料（对话、工单、文档摘录等）"
              onChange={e => onChangeForm({ ...data, task: { ...task, prompt: e.target.value } })}
            />
          </label>
          <TaskMaterials task={task} />
        </section>

        <section className="bench-aside bench-review-zone" aria-label="评审区">
          <p className="bench-eyebrow">评审手册 · 仅评审与校验使用</p>
          <label className="bench-field">
            <span>这道案例考察什么判断力？</span>
            <textarea
              rows={2}
              value={review.skill}
              placeholder="一句话说明最关键的考察点"
              onChange={e => onChangeForm({ ...data, review: { ...review, skill: e.target.value } })}
            />
          </label>

          <div className="bench-contrast">
            <label className="bench-field bench-contrast-card" data-polarity="neg">
              <span>审阅用代表性错答</span>
              <textarea
                rows={4}
                value={review.negative}
                placeholder="容易踩坑的典型错误回答，用于验证标准能拦住错答"
                onChange={e => onChangeForm({ ...data, review: { ...review, negative: e.target.value } })}
              />
            </label>
            <label className="bench-field bench-contrast-card" data-polarity="pos">
              <span>参考答案</span>
              <textarea
                rows={4}
                value={review.positive}
                placeholder="符合团队预期的理想回答，用于验证标准能放行好答"
                onChange={e => onChangeForm({ ...data, review: { ...review, positive: e.target.value } })}
              />
            </label>
          </div>

          {grader.kind === 'rubric' && (
            <div className="bench-criteria">
              <div className="bench-criteria-head">
                <span>逐条评审标准</span>
                <button type="button" className="bench-btn" onClick={addCriterion}>
                  <span className="bench-ico" aria-hidden="true"><Icon name="plus" /></span>
                  <span>添加标准</span>
                </button>
              </div>
              <ol className="bench-criteria-list">
                {grader.criteria.map((line, i) => (
                  <li key={i} className="bench-criterion">
                    <span className="bench-criterion-num" aria-hidden="true">{i + 1}</span>
                    <textarea
                      rows={2}
                      aria-label={`第 ${i + 1} 条评审标准`}
                      placeholder="写明一条可清晰判断通过或未通过的标准"
                      value={line}
                      onChange={e => updateCriterion(i, e.target.value)}
                    />
                    {grader.criteria.length > 1 && (
                      <button
                        type="button"
                        className="bench-icon-btn"
                        aria-label={`删除第 ${i + 1} 条评审标准`}
                        onClick={() => removeCriterion(i)}
                      >
                        <Icon name="x" />
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {grader.kind === 'exact' && (
            <label className="bench-field">
              <span>期望的精确输出</span>
              <textarea
                rows={3}
                value={grader.expected}
                onChange={e => onChangeForm({ ...data, review: { ...review, grader: { kind: 'exact', expected: e.target.value } } })}
              />
            </label>
          )}

          {isCodeGrader && (
            <p className="bench-muted">
              当前为「{KIND_LABEL[grader.kind]}」类型，请在下方高级 JSON 中编辑测试用例、镜像、执行命令或附件文件。
            </p>
          )}
        </section>
      </div>

      <details className="bench-fold" open={isCodeGrader}>
        <summary><span className="bench-ico" aria-hidden="true"><Icon name="sliders" /></span>{isCodeGrader ? '验收配置与完整 JSON' : '高级选项：编辑完整 JSON'}</summary>
        <div className="bench-fold-body">
          <label className="bench-field">
            <span>案例完整 JSON</span>
            <textarea
              className="bench-code-input"
              rows={14}
              spellCheck={false}
              value={advanced}
              onChange={e => onChangeJson(e.target.value)}
            />
          </label>
        </div>
      </details>
    </div>
  );
}

function ResultsBoard({
  results, targetLabel, onOpenCase,
}: {
  results: BenchResult[];
  targetLabel: (id: string) => string;
  onOpenCase?: (caseId: string) => void;
}) {
  const board = useRef<HTMLElement>(null);
  useLayoutEffect(() => { board.current?.scrollIntoView({ block: 'start' }); }, [results]);
  const groups: { caseId: string; title: string; items: BenchResult[] }[] = [];
  for (const r of results) {
    let g = groups.find(x => x.caseId === r.caseId);
    if (!g) { g = { caseId: r.caseId, title: r.title, items: [] }; groups.push(g); }
    g.items.push(r);
  }

  return (
    <section ref={board} className="bench-results" aria-label="模型对照结果">
      {groups.map(group => {
        const passed = group.items.filter(r => r.status === 'pass').length;
        return (
          <article key={group.caseId} className="bench-case-compare">
            <header className="bench-compare-head">
              <div>
                <h2>{group.title}</h2>
                <p className="bench-muted">{passed} / {group.items.length} 个模型通过</p>
              </div>
              {onOpenCase && (
                <button type="button" className="bench-btn" onClick={() => onOpenCase(group.caseId)}>
                  <span className="bench-ico" aria-hidden="true"><Icon name="open" /></span>
                  <span>查看案例详情</span>
                </button>
              )}
            </header>
            <div className="bench-model-grid">
              {group.items.map(r => (
                <div key={r.caseId + ':' + r.target} className="bench-model-card" data-status={r.status}>
                  <div className="bench-model-head">
                    <div>
                      <strong>{targetLabel(r.target)}</strong>
                      {r.model && <span className="bench-model-sub">{r.model}</span>}
                    </div>
                    <div className="bench-model-meta">
                      <span className="bench-status" data-status={r.status}>{STATUS_LABEL[r.status]}</span>
                      <span className="bench-duration">{(r.durationMs / 1000).toFixed(1)} 秒</span>
                    </div>
                  </div>
                  {r.answer && (
                    <div className="bench-answer">
                      <span className="bench-section-cap">模型答卷</span>
                      <div className="bench-prose">{r.answer}</div>
                    </div>
                  )}
                  {r.checks && r.checks.length > 0 ? (
                    <div className="bench-checks">
                      <span className="bench-section-cap">评审标准 · {r.checks.filter(check => check.pass).length} / {r.checks.length} 项通过</span>
                      <ol>
                        {r.checks.map((c, i) => (
                          <li key={i} className="bench-check" data-pass={c.pass || undefined}>
                            <span className="bench-ico" aria-hidden="true"><Icon name={c.pass ? 'check' : 'x'} /></span>
                            <div>
                              <p className="bench-check-criterion"><span className="bench-sr-only">{c.pass ? '通过' : '未通过'}：</span>{c.criterion}</p>
                              <p className="bench-check-reason">{c.reason}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : r.detail && (
                    <p className="bench-detail">{r.detail}</p>
                  )}
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </section>
  );
}
