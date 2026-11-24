import { useEffect, useId, useRef, useState } from 'react';
import type { InteractionQuestion, InteractionResponse, PendingInteraction } from '../shared/api.js';
import type { QuestionGroup } from './decisions.js';

export interface PendingInteractionItem {
  turnId: string;
  callId: string;
  targetId: string;
  targetLabel: string;
  request: PendingInteraction;
}

export type Respond = (turnId: string, id: string, response: InteractionResponse) => Promise<void>;
interface Draft { selected: number[]; other: boolean; text: string }
const empty: Draft = { selected: [], other: false, text: '' };
const fieldKey = (group: QuestionGroup, q: InteractionQuestion) => JSON.stringify([group.id, q.id]);

function answer(q: InteractionQuestion, draft: Draft) {
  const values = draft.selected.map(i => q.options?.[i]?.label).filter((s): s is string => !!s);
  if (draft.other || !q.options?.length) {
    if (!draft.text.trim()) return [];
    values.push(q.secret ? draft.text : draft.text.trim());
  }
  return values;
}

function QuestionField({ q, draft, change }: { q: InteractionQuestion; draft: Draft; change(value: Draft): void }) {
  const name = useId();
  const options = q.options ?? [];
  const type = q.multiSelect ? 'checkbox' : 'radio';
  return <fieldset className="decision-field">
    <legend>{q.header && <small>{q.header}</small>}{q.question}{q.multiSelect && <small>可多选</small>}</legend>
    {options.map((option, i) => <label className="decision-option" key={i}>
      <input type={type} name={name} checked={draft.selected.includes(i)} onChange={e => {
        const selected = q.multiSelect
          ? e.target.checked ? [...draft.selected, i] : draft.selected.filter(n => n !== i)
          : [i];
        change({ ...draft, selected, other: !!q.multiSelect && draft.other });
      }} />
      <span>{option.label}{option.description && <small>{option.description}</small>}</span>
    </label>)}
    {!!options.length && q.allowOther && <label className="decision-option">
      <input type={type} name={name} checked={draft.other} onChange={e =>
        change({ ...draft, other: e.target.checked, selected: q.multiSelect ? draft.selected : [] })} />
      <span>自定义回答</span>
    </label>}
    {(!options.length || draft.other) && <input className="interact-input" aria-label={q.question}
      type={q.secret ? 'password' : 'text'} autoComplete="off" placeholder="填写你的回答"
      value={draft.text} onChange={e => change({ ...draft, text: e.target.value })} />}
  </fieldset>;
}

type GroupResponse = { group: QuestionGroup; answers: Record<string, string[]> };

function QuestionPanel({ groups, submitLabel, onSubmit, onCancel, blocked }: {
  groups: QuestionGroup[]; submitLabel: string; blocked?: string;
  onSubmit(responses: GroupResponse[]): Promise<void>; onCancel?(group: QuestionGroup): Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const fields = groups.flatMap(group => group.questions.map(q => fieldKey(group, q)));
  // A resolved request can disappear while another model is still waiting.
  useEffect(() => {
    const valid = new Set(fields);
    setDrafts(prev => Object.keys(prev).every(key => valid.has(key)) ? prev :
      Object.fromEntries(Object.entries(prev).filter(([key]) => valid.has(key))));
  }, [groups]);
  const responses = groups.map(group => ({ group, answers: Object.fromEntries(group.questions.map(q =>
    [q.id, answer(q, drafts[fieldKey(group, q)] ?? empty)])) }));
  const answered = responses.reduce((n, r) => n + Object.values(r.answers).filter(values => values.length).length, 0);
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { lock.current = false; setBusy(false); }
  }

  return <section className="decision-panel" aria-label="待你选择">
    <header><h3>待你选择</h3><span aria-live="polite">已答 {answered} / {fields.length}</span></header>
    <fieldset className="decision-body" disabled={busy}>
      {groups.map(group => <div className="decision-group" key={group.id} data-interaction-id={group.id}>
        <div className="decision-source"><b>{group.label}</b>
          {onCancel && <button type="button" className="ghost" onClick={() => void perform(() => onCancel(group))}>取消这项请求</button>}
        </div>
        {group.detail && <pre className="interact-detail">{group.detail}</pre>}
        {group.questions.map(q => {
          const key = fieldKey(group, q);
          return <QuestionField key={key} q={q} draft={drafts[key] ?? empty}
            change={value => setDrafts(prev => ({ ...prev, [key]: value }))} />;
        })}
      </div>)}
    </fieldset>
    <footer>{error && <span role="alert">{error}</span>}{blocked && <span>{blocked}</span>}
      <button type="button" className="btn primary" disabled={busy || !!blocked || answered !== fields.length}
        onClick={() => void perform(() => onSubmit(responses))}>{busy ? '正在提交…' : submitLabel}</button>
    </footer>
  </section>;
}

export function LiveQuestions({ items, respond }: { items: PendingInteractionItem[]; respond: Respond }) {
  const groups = items.map(({ request, targetLabel }) => {
    const questions = request.questions?.length ? request.questions : [{
      id: 'text', question: request.title, secret: request.secret,
    }];
    return { id: request.id, label: request.questions?.length ? `${targetLabel} · ${request.title}` : targetLabel,
      detail: request.detail ?? (!request.questions?.length ? request.placeholder : undefined), questions };
  });
  return <QuestionPanel groups={groups} submitLabel="提交全部回答"
    onCancel={group => {
      const item = items.find(i => i.request.id === group.id)!;
      return respond(item.turnId, group.id, { cancelled: true });
    }}
    onSubmit={async responses => {
      const results = await Promise.allSettled(responses.map(({ group, answers }, index) => {
        const { turnId, request } = items[index];
        const response = request.kind === 'question' && request.questions?.length ? { answers } : { text: answers.text[0] };
        return respond(turnId, group.id, response);
      }));
      const failure = results.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }} />;
}

export function FollowUpQuestions({ groups, blocked, send }: {
  groups: QuestionGroup[]; blocked?: string; send(text: string): Promise<void>;
}) {
  return <QuestionPanel groups={groups} blocked={blocked} submitLabel="提交选择并继续讨论" onSubmit={async responses => {
    const choices = responses.map(({ group, answers }) => [
      group.label, ...group.questions.map(q => {
        const selected = answers[q.id].map(value => {
          const description = q.options?.find(o => o.label === value)?.description;
          return description ? `${value}（${description}）` : value;
        });
        return `${q.question}\n${selected.join('、')}`;
      }),
    ].join('\n'));
    await send(['请按以下选择继续讨论。', ...choices].join('\n\n'));
  }} />;
}

export function CollectQuestionsButton({ blocked, send }: { blocked?: string; send(text: string): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function collect() {
    setBusy(true);
    setError('');
    try { await send('请把上一轮仍需我决定的取舍整理成选择题，列出每个选项及其影响。如果已经没有待选事项，请直接说明。'); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="ghost" disabled={busy || !!blocked} title={blocked ?? '发起一轮追问，整理当前讨论里的待选事项'}
      onClick={() => void collect()}>{busy ? '正在整理…' : '整理为选择题'}</button>
    {error && <span className="error" role="alert">{error}</span>}
  </>;
}
