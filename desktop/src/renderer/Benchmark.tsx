import { useEffect, useState } from 'react';
import type { BenchCase, BenchIndex, BenchResult, WorkspaceInfo } from '../shared/api.js';
import { caseSchema } from '../../../src/bench/schema.js';
import { unify } from './api.js';
import { Spinner } from './ui.js';

type Stage = 'candidates' | 'drafts' | 'cases';
const stageName = { candidates: '失败线索', drafts: '草稿', cases: '已发布' };
const kindName = { exact: '精确答案', javascript: 'JavaScript 用例', patch: '补丁测试', rubric: '评审标准' };

export function BenchmarkPage({ ws }: { ws: WorkspaceInfo }) {
  const cwd = ws.cwd;
  const targets = ws.targets.filter(t => t.installed !== false);
  const [index, setIndex] = useState<BenchIndex>();
  const [stage, setStage] = useState<Stage>('candidates');
  const [id, setId] = useState('');
  const [model, setModel] = useState(ws.synthesizer || ws.defaults[0] || targets[0]?.id || '');
  const [participants, setParticipants] = useState<string[]>(ws.defaults.filter(name => targets.some(t => t.id === name)));
  const [evidence, setEvidence] = useState<{ question: string; answer: string; followUp: string }>();
  const [note, setNote] = useState('');
  const [commit, setCommit] = useState('');
  const [paths, setPaths] = useState('');
  const [data, setData] = useState<BenchCase>();
  const [invalid, setInvalid] = useState(false);
  const [advanced, setAdvanced] = useState('');
  const [results, setResults] = useState<BenchResult[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    unify.benchIndex(cwd).then(value => { if (active) setIndex(value); }, e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [cwd]);

  function clearSelection() {
    setId(''); setData(undefined); setAdvanced(''); setInvalid(false); setError(''); setEvidence(undefined); setResults([]); setNote(''); setCommit(''); setPaths('');
  }
  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }
  async function select(value: string) {
    clearSelection(); setId(value);
    if (!value) return;
    await perform('读取题目', async () => {
      if (stage === 'candidates') {
        setNote(index?.candidates.find(c => c.id === value)?.note ?? '');
        setEvidence(await unify.benchEvidence(cwd, value));
      } else {
        const c = await unify.benchRead(cwd, value, stage === 'cases');
        setData(c); setAdvanced(JSON.stringify(c, null, 2));
      }
    });
  }
  async function draft() {
    await perform('正在出题', async () => {
      const repository = commit.trim() || paths.trim() ? { commit: commit.trim(), paths: paths.split('\n').map(s => s.trim()).filter(Boolean) } : undefined;
      const generated = await unify.benchDraft(cwd, id, model, note, repository);
      setIndex(await unify.benchIndex(cwd)); setStage('drafts'); setId(generated.id); setData(generated.data);
      setAdvanced(JSON.stringify(generated.data, null, 2)); setEvidence(undefined);
    });
  }
  async function publish() {
    await perform('正在验证错解和参考解', async () => {
      const c: BenchCase = JSON.parse(advanced);
      const published = await unify.benchPublish(cwd, c, c.review.grader.kind === 'rubric' ? model : undefined);
      setIndex(await unify.benchIndex(cwd)); setStage('cases'); setId(published); setData(c);
    });
  }
  async function run() {
    await perform('正在运行评测', async () => {
      setResults([]); setResults(await unify.benchRun(cwd, id ? [id] : [], participants, model || undefined));
    });
  }
  const modelPicker = <label className="bench-field">{stage === 'candidates' ? '出题模型' : '开放题评审模型'}
    <select value={model} onChange={e => setModel(e.target.value)}>
      <option value="">选择模型</option>{targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
    </select>
  </label>;
  return <section className="page bench-page">
    <header className="page-head"><h1>项目评测集</h1></header>
    <div className="bench-tabs">{(Object.keys(stageName) as Stage[]).map(s =>
      <button className={'btn ' + (stage === s ? 'primary' : '')} key={s} disabled={!!busy} onClick={() => { clearSelection(); setStage(s); }}>
        {stageName[s]} · {index?.[s].length ?? 0}
      </button>)}</div>
    {!index && !error && <Spinner />}
    {index && <fieldset disabled={!!busy} className="bench-body">
      {index[stage].length > 0 ? <label className="bench-field">{stage === 'candidates' ? '失败线索' : '题目'}
        <select value={id} onChange={e => void select(e.target.value)}>
          <option value="">{stage === 'cases' ? '整个题集' : '选择一条记录'}</option>
          {index[stage].map(item => <option value={item.id} key={item.id}>{item.title} · {item.id.slice(0, 6)}</option>)}
        </select>
      </label> : <p className="lede">{stage === 'candidates' ? '在对话回答上点「留题」，即可把一次不符合预期的结果放到这里。'
        : stage === 'drafts' ? '从待出题的失败线索生成第一份草稿。' : '草稿经审阅并通过对照校验后，会出现在这里。'}</p>}
      {stage === 'candidates' && evidence && <>
        <h3>{evidence.question}</h3><details><summary>当时的回答</summary><pre>{evidence.answer}</pre></details>
        <label className="distill-field">你期望它怎么做？
          <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="可选，指出遗漏的条件或错误的行为" />
        </label>
        {evidence.followUp && <button className="btn" onClick={() => setNote(evidence.followUp)}>采用下一轮追问作为纠正</button>}
        <details><summary>引用已有 Git 版本</summary>
          <label className="bench-field">完整 commit SHA<input value={commit} onChange={e => setCommit(e.target.value)} /></label>
          <label className="distill-field">用于出题的仓库文件，每行一个路径<textarea rows={3} value={paths} onChange={e => setPaths(e.target.value)} /></label>
        </details>
        {modelPicker}<button className="btn primary" disabled={!model} onClick={() => void draft()}>生成草稿</button>
      </>}
      {data && <>
        <h3>{data.task.title}</h3>
        <details open key={id + '-task'}><summary>考生可见的题面</summary><pre>{data.task.prompt}</pre>
          {data.task.files.map(f => <details key={f.path}><summary>{f.path}</summary><pre>{f.content}</pre></details>)}
          {data.task.repository && <p>Git {data.task.repository.commit.slice(0, 12)} · {data.task.repository.paths.join('、')}</p>}
        </details>
        <details key={id + '-review'}><summary>评审侧 · {kindName[data.review.grader.kind]}</summary>
          <p>{data.review.skill}</p><b>代表性错解</b><pre>{data.review.negative || '未修改的起点'}</pre>
          <b>参考解</b><pre>{data.review.positive}</pre><b>判分依据</b><pre>{JSON.stringify(data.review.grader, null, 2)}</pre>
        </details>
      </>}
      {stage === 'drafts' && data && <>
        <details><summary>编辑题目与验收材料</summary>
          <label className="distill-field">草稿 JSON<textarea rows={16} value={advanced} onChange={e => {
            const text = e.target.value;
            setAdvanced(text);
            try { setData(caseSchema.parse(JSON.parse(text))); setInvalid(false); }
            catch { setInvalid(true); }
          }} /></label>
        </details>
        {invalid && <p role="alert">草稿 JSON 无效，上方显示最近一次有效预览。</p>}
        {data.review.grader.kind === 'rubric' && modelPicker}<button className="btn primary" disabled={invalid || (data.review.grader.kind === 'rubric' && !model)} onClick={() => void publish()}>确认难点一致，校验并发布</button>
      </>}
      {stage === 'cases' && index.cases.length > 0 && <>
        <div className="bench-field">参评模型<div className="bench-picks">{targets.map(t =>
          <label key={t.id}><input type="checkbox" checked={participants.includes(t.id)} onChange={e => setParticipants(
            e.target.checked ? [...participants, t.id] : participants.filter(x => x !== t.id))} /> {t.label}</label>)}</div></div>
        {(id ? data?.review.grader.kind === 'rubric' : index.cases.some(c => c.kind === 'rubric')) && modelPicker}<button className="btn primary" disabled={!participants.length} onClick={() => void run()}>运行评测</button>
        {results.map(r => <details key={r.caseId + r.target}><summary>{r.title} · {r.target} · {({ pass: '通过', fail: '未通过', error: '运行错误' })[r.status]}</summary>
          <p>{r.detail} · {(r.durationMs / 1000).toFixed(1)} 秒</p><pre>{r.answer}</pre></details>)}
      </>}
    </fieldset>}
    {busy && <p role="status"><Spinner /> {busy}…</p>}
    {error && <div className="error block" role="alert">{error}</div>}
  </section>;
}
