import { useState } from 'react';
import type { Feedback, RunRecord } from '../shared/api.js';
import { useAnimatedDialog } from './motion.js';

type Context = { record: RunRecord; call?: string; quote?: string };
export type FeedbackContext = Context;

export function FeedbackDialog({ context, close, save, insert }: {
  context: Context; close(): void;
  save(note: string, feedback?: Feedback): Promise<void>; insert(note: string): void;
}) {
  const dialog = useAnimatedDialog(true);
  const { record, call, quote } = context;
  const answers = [...record.results, ...(record.synthesis ? [record.synthesis.result] : [])];
  const source = answers.find(r => r.runId === call);
  const label = (id: string) => {
    const r = answers.find(a => a.runId === id);
    if (record.synthesis?.result.runId === id) return '汇总';
    return record.targets.find(t => t.id === r?.targetId)?.label ?? r?.targetId ?? '回答';
  };
  const [kind, setKind] = useState<Feedback['kind']>(!call && answers.length > 1 ? '比较' : '标注');
  const [comment, setComment] = useState('');
  const original = quote || source?.text || '';
  const [revision, setRevision] = useState(original);
  const [ranking, setRanking] = useState<string[]>([]);
  const [excerpts, setExcerpts] = useState<Record<string, string>>({});
  const [score, setScore] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const feedback: Feedback = {
    kind, comment: comment.trim(), ...(quote ? { quote } : {}),
    ...(kind === '改写' ? { revision } : {}),
    ...(kind === '评分' ? { score } : {}),
    ...(kind === '比较' ? { ranked: ranking.map(id => ({ call: id, excerpt: excerpts[id]?.trim() || '' })) } : {}),
  };
  const observation = [
    kind + (call ? ' · ' + label(call) : ' · 整轮'),
    quote && '选中原文\n' + quote,
    kind === '改写' && '采用的版本\n' + (revision || '（删除选段）'),
    kind === '评分' && score && score + ' / 5',
    kind === '比较' && ranking.map((id, i) => (i + 1) + '. ' + label(id) + '\n' +
      (excerpts[id]?.trim() || answers.find(r => r.runId === id)?.text || '')).join('\n'),
    comment.trim(),
  ].filter(Boolean).join('\n\n');
  const ready = kind === '改写' ? revision !== original : kind === '比较' ? ranking.length > 0
    : kind === '评分' ? !!score : !!comment.trim() || (['正例', '反例'].includes(kind) && !!source);
  const modes: Feedback['kind'][] = ['标注', '正例', '反例', ...(source ? ['改写' as const] : []),
    ...(answers.length > 1 ? ['比较' as const] : []), '评分', '验收标准', '实际结果'];
  async function submit(bare = false) {
    setBusy(true); setError('');
    try { await save(bare ? '' : observation, bare ? undefined : feedback); close(); }
    catch (err) { setError(String(err instanceof Error ? err.message : err)); setBusy(false); }
  }
  function move(id: string, dir: number) {
    const next = [...ranking], index = next.indexOf(id);
    [next[index], next[index + dir]] = [next[index + dir], next[index]]; setRanking(next);
  }
  return <dialog className="modal feedback-dialog" ref={dialog} aria-labelledby="input-feedback-title"
    onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <header><h2 id="input-feedback-title">对话反馈</h2><button className="ghost" disabled={busy} onClick={close}>关闭</button></header>
    <div className="feedback-scroll"><small>{call ? label(call) : '整轮回答'} · {record.question}</small>
      <div className="feedback-modes" aria-label="反馈类型">{modes.map(mode => <button type="button" key={mode}
        aria-pressed={kind === mode} onClick={() => setKind(mode)}>{mode}</button>)}</div>
      {quote ? <blockquote>{quote}</blockquote> : source && <details><summary>查看原回答</summary><pre>{source.text || source.error}</pre></details>}
      {kind === '改写' && <label>采用的版本<textarea value={revision} rows={7} onChange={e => setRevision(e.target.value)} /></label>}
      {kind === '评分' && <div className="feedback-modes" aria-label="评分">{[1, 2, 3, 4, 5].map(n =>
        <button key={n} aria-pressed={n === score} onClick={() => setScore(n)}>{n} 分</button>)}</div>}
      {kind === '比较' && <div className="feedback-ranking">
        <p>勾选采用的回答，按偏好排序。可以为每份回答摘出要保留的部分。</p>
        {[...ranking, ...answers.map(r => r.runId).filter(id => !ranking.includes(id))].map(id => {
          const i = ranking.indexOf(id);
          return <div key={id}><div className="ranking-line"><label><input type="checkbox" checked={i >= 0}
            onChange={e => setRanking(e.target.checked ? [...ranking, id] : ranking.filter(v => v !== id))} />
            {i >= 0 && (i + 1) + '. '}{label(id)}</label>
            {i >= 0 && <><button disabled={!i} onClick={() => move(id, -1)} aria-label={'上移 ' + label(id)}>↑</button>
              <button disabled={i === ranking.length - 1} onClick={() => move(id, 1)} aria-label={'下移 ' + label(id)}>↓</button></>}</div>
            <details><summary>查看回答</summary><pre>{answers.find(r => r.runId === id)?.text}</pre></details>
            {i >= 0 && <input aria-label={label(id) + ' 采用的片段'} placeholder="采用整份，或填写要保留的片段" value={excerpts[id] ?? ''}
              onChange={e => setExcerpts(prev => ({ ...prev, [id]: e.target.value }))} />}
          </div>;
        })}
      </div>}
      <label>{kind === '验收标准' ? '怎样算通过？' : kind === '实际结果' ? '实际发生了什么？' : '说明'}
        <textarea rows={3} value={comment} onChange={e => setComment(e.target.value)} placeholder="写下你的观察或判断依据…" /></label>
      {error && <p role="alert" className="input-error">{error}</p>}
    </div>
    <footer><button className="ghost" disabled={busy} onClick={() => void submit(true)}>{call ? '仅收藏原回答' : '仅收藏本轮'}</button>
      <button className="btn" disabled={!ready || busy} onClick={() => {
        insert(source && !quote && kind !== '比较' ? observation + '\n\n对应原文\n' + source.text : observation); close();
      }}>放入输入框</button>
      <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>留作评测</button></footer>
  </dialog>;
}
