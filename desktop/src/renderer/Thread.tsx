import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { synthesisFormatter } from '../../../src/core/synth.js';
import type { DistillApplyResult, DistillCandidate, DistillPreparation, DistillSourceRef, DuplicateCheckResult, ExecPreview, InteractionResponse, PendingInteraction, RunRecord, RunResultRecord, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { unify } from './api.js';
import { Icon, Markdown, Spinner, hue, isActive, kilo, quotaSummary, seconds, statusText, useTicker } from './ui.js';

export interface Activity { name: string; detail?: string }
export interface PendingInteractionItem {
  turnId: string;
  callId: string;
  targetId: string;
  targetLabel: string;
  request: PendingInteraction;
}
type CardKind = 'answer' | 'synthesis' | 'exec';

/** When each call was first seen running, for elapsed-time labels. */
const firstSeen = new Map<string, number>();

export interface FollowUpChoice {
  turnId: string;
  targetId: string;
  label: string;
}

export interface TurnActions {
  zoom(turnId: string, runId: string): void;
  exec(turnId: string, from?: string): void;
  retry(turnId: string, targetIds?: string[]): void;
  cancel(turnId: string): void;
  cancelTarget(turnId: string, targetId: string): void;
  respondInteraction?(turnId: string, interactionId: string, response: InteractionResponse): void;
  followUp?(choice?: FollowUpChoice): void;
  distill?(source: DistillSourceRef): void;
}

function InteractionPrompt({ item, onRespond }: {
  item: PendingInteractionItem;
  onRespond: (turnId: string, interactionId: string, response: InteractionResponse) => void;
}) {
  const { request } = item;
  const [submitting, setSubmitting] = useState(false);
  const [inputText, setInputText] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of request.questions ?? []) {
      if (q.options?.length) init[q.id] = q.options[0].label;
    }
    return init;
  });
  const [custom, setCustom] = useState<Record<string, string>>({});

  const submit = (response: InteractionResponse) => {
    if (submitting) return;
    setSubmitting(true);
    onRespond(item.turnId, request.id, response);
  };

  if (request.kind === 'approval') {
    const options = request.options?.length
      ? request.options
      : [
          { id: 'accept', label: '允许', tone: 'primary' as const },
          { id: 'decline', label: '拒绝', tone: 'danger' as const },
        ];
    return (
      <div className="interact-box" data-interaction-id={request.id} role="region" aria-label={request.title}>
        <div className="interact-head">
          <span className="interact-badge"><Icon name="alert" size={12} />需要确认</span>
          {request.tool && <span className="interact-tool">{request.tool}</span>}
        </div>
        <div className="interact-title">{request.title}</div>
        {request.detail && <pre className="interact-detail">{request.detail}</pre>}
        <div className="interact-actions">
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={submitting}
              className={`interact-btn${opt.tone ? ` ${opt.tone}` : ''}`}
              title={opt.description}
              onClick={() => submit({ optionId: opt.id })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (request.kind === 'question' && request.questions?.length) {
    const submitQuestions = () => {
      const answers: Record<string, string[]> = {};
      for (const q of request.questions!) {
        const customVal = (custom[q.id] ?? '').trim();
        const picked = selected[q.id];
        if (customVal) answers[q.id] = [customVal];
        else if (picked) answers[q.id] = [picked];
        else answers[q.id] = [];
      }
      submit({ answers });
    };
    return (
      <div className="interact-box" data-interaction-id={request.id} role="region" aria-label={request.title}>
        <div className="interact-head">
          <span className="interact-badge"><Icon name="alert" size={12} />等待回答</span>
          {request.tool && <span className="interact-tool">{request.tool}</span>}
        </div>
        <div className="interact-title">{request.title}</div>
        {request.detail && <pre className="interact-detail">{request.detail}</pre>}
        <div className="interact-questions">
          {request.questions.map((q) => {
            const hasOpts = !!q.options?.length;
            const picked = selected[q.id];
            const customVal = custom[q.id] ?? '';
            return (
              <div key={q.id} className="interact-q">
                {q.header && <div className="interact-q-head">{q.header}</div>}
                <div className="interact-q-text">{q.question}</div>
                {hasOpts && (
                  <div className="interact-opts">
                    {q.options!.map((o) => {
                      const on = !customVal.trim() && picked === o.label;
                      return (
                        <button
                          key={o.label}
                          type="button"
                          disabled={submitting}
                          className={`interact-opt${on ? ' on' : ''}`}
                          onClick={() => {
                            setSelected((prev) => ({ ...prev, [q.id]: o.label }));
                            setCustom((prev) => ({ ...prev, [q.id]: '' }));
                          }}
                        >
                          <b>{o.label}</b>
                          {o.description && <span>{o.description}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {(!hasOpts || q.allowOther) && (
                  <input
                    className="interact-input"
                    type={q.secret ? 'password' : 'text'}
                    disabled={submitting}
                    value={customVal}
                    placeholder={hasOpts ? '或输入自定义回答…' : '请输入回答…'}
                    onChange={(e) => setCustom((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        submitQuestions();
                      }
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="interact-actions">
          <button type="button" className="interact-btn primary" disabled={submitting} onClick={submitQuestions}>提交回答</button>
          <button type="button" className="interact-btn danger" disabled={submitting} onClick={() => submit({ cancelled: true })}>取消</button>
        </div>
      </div>
    );
  }

  return (
    <div className="interact-box" data-interaction-id={request.id} role="region" aria-label={request.title}>
      <div className="interact-head">
        <span className="interact-badge"><Icon name="alert" size={12} />等待输入</span>
        {request.tool && <span className="interact-tool">{request.tool}</span>}
      </div>
      <div className="interact-title">{request.title}</div>
      {request.detail && <pre className="interact-detail">{request.detail}</pre>}
      <input
        className="interact-input"
        type={request.secret ? 'password' : 'text'}
        disabled={submitting}
        value={inputText}
        placeholder={request.placeholder ?? '请输入内容…'}
        onChange={(e) => setInputText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit({ text: inputText });
          }
        }}
      />
      <div className="interact-actions">
        <button type="button" className="interact-btn primary" disabled={submitting || !inputText.trim()} onClick={() => submit({ text: inputText })}>发送</button>
        <button type="button" className="interact-btn danger" disabled={submitting} onClick={() => submit({ cancelled: true })}>取消</button>
      </div>
    </div>
  );
}

// ── a single model's output ───────────────────────────────────────────────
export function Card({ record, result, kind, showReasoning, activity, interactions, actions, zoomed, canFollowUp, followUpSelected }: {
  record: RunRecord; result: RunResultRecord; kind: CardKind; showReasoning: boolean;
  activity?: Activity[]; interactions?: PendingInteractionItem[]; actions: TurnActions; zoomed?: boolean; canFollowUp?: boolean; followUpSelected?: boolean;
}) {
  const running = result.status === 'running';
  const needsInput = !!interactions?.length;
  const now = useTicker(running);
  if (running && !firstSeen.has(result.runId)) firstSeen.set(result.runId, Date.now());
  const call = record.calls.find((c) => c.id === result.runId);
  const target = call?.target ?? record.targets.find((t) => t.id === result.targetId);
  const label = kind === 'synthesis' ? `汇总 · ${target?.label ?? result.targetId}` : kind === 'exec' ? `实施 · ${target?.label ?? result.targetId}` : target?.label ?? result.targetId;
  const meta = [result.model, result.reasoningEffort && `思考 ${result.reasoningEffort}`].filter(Boolean).join(' · ');
  const elapsed = running ? now - (firstSeen.get(result.runId) ?? now) : result.durationMs;
  const turnRunning = isActive(record);

  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && (running || needsInput) && stick.current) el.scrollTop = el.scrollHeight;
  }, [result.text, result.reasoning, activity?.length, interactions?.length, running, needsInput]);

  const [thinkOpen, setThinkOpen] = useState(showReasoning);
  const waiting = running && !result.text && !result.reasoning && !needsInput;
  const format = kind === 'synthesis' ? synthesisFormatter(record) : undefined;
  const text = format?.(result.text) ?? result.text;
  const reasoning = format?.(result.reasoning) ?? result.reasoning;
  const tools = activity?.length ? activity : result.tools;

  return (
    <article className={`card ${kind} ${result.status}${needsInput ? ' needs-input' : ''}${zoomed ? ' zoomed' : ''}`} style={{ '--h': hue(result.targetId) } as CSSProperties}>
      <header>
        {kind === 'synthesis' ? <span className="mark"><Icon name="spark" size={14} /></span> : kind === 'exec' ? <span className="mark"><Icon name="run" size={14} /></span> : <i className="dot" />}
        <div className="who">
          <b>{label}</b>
          {meta && <span className="model">{meta}</span>}
        </div>
        <span className={`status ${needsInput ? 'waiting-input' : result.status}`}>
          {needsInput ? <Icon name="alert" size={12} /> : running ? <Spinner /> : null}
          {needsInput ? '等待交互' : running ? seconds(elapsed) : `${statusText[result.status]}${result.durationMs ? ` · ${seconds(result.durationMs)}` : ''}`}
        </span>
      </header>
      <div
        className="body" ref={body}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
        {!!call?.input.memorySnapshot?.items.length && (
          <details className="think">
            <summary>已注入共享记忆<span>{call.input.memorySnapshot.items.length} 个文件 · Unify 已发送</span></summary>
            <ul className="memory-injected">
              {call.input.memorySnapshot.items.map((item, i) => (
                <li key={i}><code>{item.logicalPath}</code><span>{item.bytes} B{item.truncated ? ' · 已截断' : ''}</span></li>
              ))}
            </ul>
          </details>
        )}
        {!!result.memoryReferences?.length && (
          <details className="think">
            <summary>记忆依据<span>{result.memoryReferences.length} 条 · 模型自报</span></summary>
            <dl className="memory-references">
              {result.memoryReferences.map((ref, i) => (
                <div key={i}><dt>{ref.source}</dt><dd>{ref.content}</dd><dd>影响：{ref.effect}</dd></div>
              ))}
            </dl>
          </details>
        )}
        {result.reasoning && (
          <details className="think" open={thinkOpen || (running && !result.text && showReasoning)} onToggle={(e) => setThinkOpen((e.target as HTMLDetailsElement).open)}>
            <summary>思考过程<span>{kilo(reasoning.length)} 字</span></summary>
            <div className="think-text">{reasoning}</div>
          </details>
        )}
        {tools && tools.length > 0 && (
          <ul className="tools">
            {tools.slice(-40).map((a, i) => (
              <li key={i}><Icon name="chevron" size={12} /><b>{a.name}</b>{a.detail && <span>{a.detail}</span>}</li>
            ))}
          </ul>
        )}
        {waiting ? (
          <div className="skeleton"><i /><i /><i /></div>
        ) : result.text ? (
          <Markdown text={text} />
        ) : !running && !result.error ? <p className="empty">没有输出</p> : null}
        {interactions && actions.respondInteraction && interactions.map((item) => (
          <InteractionPrompt key={item.request.id} item={item} onRespond={actions.respondInteraction!} />
        ))}
        {result.error && <div className="error"><Icon name="alert" size={14} /><span>{result.error}</span></div>}
      </div>
      <footer>
        <span className="usage">
          {result.usage?.inputTokens || result.usage?.outputTokens
            ? `↑${kilo(result.usage?.inputTokens)}${result.usage?.cachedInputTokens ? ` (缓存 ${kilo(result.usage.cachedInputTokens)})` : ''} ↓${kilo(result.usage?.outputTokens)} tokens`
            : ''}
        </span>
        <span className="acts">
          {running && kind === 'answer' && record.status === 'answering' && (
            <button title="取消这个模型，其余继续" onClick={() => actions.cancelTarget(record.id, result.targetId)}><Icon name="x" /></button>
          )}
          {text && <button title="复制" onClick={() => void unify.copy(text)}><Icon name="copy" /></button>}
          {result.ok && !turnRunning && text && actions.distill && (
            <button
              title="存为记忆…（可先划选一段文字）"
              onClick={() => {
                const sel = window.getSelection();
                const selectedText = sel && body.current && sel.rangeCount > 0 && body.current.contains(sel.anchorNode)
                  ? sel.toString().trim()
                  : undefined;
                actions.distill!({
                  turnId: record.id,
                  runId: result.runId,
                  scope: kind,
                  ...(selectedText ? { selectedText } : {}),
                });
              }}
            >
              <Icon name="bookmark" size={14} />
            </button>
          )}
          {kind === 'answer' && !running && !turnRunning && (
            <button title="只重新调用这个模型" onClick={() => actions.retry(record.id, [result.targetId])}><Icon name="retry" /></button>
          )}
          {kind === 'answer' && result.ok && !turnRunning && canFollowUp && actions.followUp && (
            <button
              className={followUpSelected ? 'on' : undefined}
              title={followUpSelected ? '已选为下轮追问上下文（再次点击恢复默认）' : '下轮追问沿用这个回答'}
              onClick={() => actions.followUp!(followUpSelected ? undefined : { turnId: record.id, targetId: result.targetId, label })}
            >
              <Icon name="check" />
            </button>
          )}
          {kind === 'answer' && result.ok && !turnRunning && (
            <button title="按这个回答实施" onClick={() => actions.exec(record.id, result.targetId)}><Icon name="run" /></button>
          )}
          <button title={zoomed ? '退出放大 (Esc)' : '放大阅读'} onClick={() => actions.zoom(record.id, zoomed ? '' : result.runId)}><Icon name={zoomed ? 'shrink' : 'expand'} /></button>
        </span>
      </footer>
    </article>
  );
}

// ── one round: question, answers, synthesis ───────────────────────────────
export function Turn({ record, notices, activity, interactions, showReasoning, actions, isLatestComparison, followUp }: {
  record: RunRecord; notices: string[]; activity: Record<string, Activity[]>; interactions?: Record<string, PendingInteractionItem[]>; showReasoning: boolean; actions: TurnActions;
  isLatestComparison?: boolean; followUp?: FollowUpChoice;
}) {
  const active = isActive(record);
  const time = new Date(record.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (record.kind === 'execution') {
    const result = record.results[0];
    const src = record.planSource;
    const srcLabel = src ? (src.scope === 'synthesis' ? '汇总' : record.targets.find((t) => t.id === src.targetId)?.label ?? src.targetId) : '';
    return (
      <section className="turn exec-turn">
        <div className="q small">
          <div className="q-kicker"><Icon name="run" size={13} />实施方案{srcLabel && <> · 依据「{srcLabel}」</>}<span>{time}</span></div>
        </div>
        {result ? <Card record={record} result={result} kind="exec" showReasoning={showReasoning} activity={activity[result.runId]} interactions={interactions?.[result.runId]} actions={actions} />
          : <div className="pending"><Spinner />正在准备实施…</div>}
        {record.error && <div className="error"><Icon name="alert" size={14} /><span>{record.error}</span></div>}
        <div className="turn-foot">
          {active ? <button className="ghost" onClick={() => actions.cancel(record.id)}><Icon name="stop" size={14} />停止实施</button>
            : result?.ok ? <span className="hint"><Icon name="check" size={14} />实施完成，请用 git diff 检查改动</span> : null}
        </div>
      </section>
    );
  }

  const answers = record.results;
  const failed = answers.filter((r) => !r.ok && r.status !== 'running');
  const anyOk = answers.some((r) => r.ok) || record.synthesis?.result.ok;
  const n = Math.min(Math.max(answers.length, 1), 3);
  return (
    <section className="turn">
      <div className="q">
        <div className="q-text">{record.question}</div>
        <div className="q-meta">
          <span>{time}</span>
          {record.retryOf && <span>重试</span>}
          {answers.length > 0 && <span>{answers.length} 个模型</span>}
        </div>
      </div>
      {record.status === 'deciding' && <div className="pending"><Spinner />正在决定由哪些模型回答…</div>}
      {record.status === 'created' && <div className="pending"><Spinner />正在检查模型…</div>}
      {notices.length > 0 && <div className="notices">{notices.map((m, i) => <div key={i}>{m}</div>)}</div>}
      {answers.length > 0 && (
        <div className={`answers n${n}`}>
          {answers.map((r) => (
            <Card
              key={r.runId} record={record} result={r} kind="answer" showReasoning={showReasoning}
              activity={activity[r.runId]} interactions={interactions?.[r.runId]} actions={actions}
              canFollowUp={isLatestComparison}
              followUpSelected={followUp?.turnId === record.id && followUp.targetId === r.targetId}
            />
          ))}
        </div>
      )}
      {record.synthesis && <Card record={record} result={record.synthesis.result} kind="synthesis" showReasoning={showReasoning} interactions={interactions?.[record.synthesis.result.runId]} actions={actions} />}
      {record.error && <div className="error"><Icon name="alert" size={14} /><span>{record.error}</span></div>}
      <div className="turn-foot">
        {active ? (
          <button className="ghost" onClick={() => actions.cancel(record.id)}><Icon name="stop" size={14} />取消本轮</button>
        ) : (
          <>
            {anyOk && <button className="ghost" onClick={() => actions.exec(record.id)}><Icon name="run" size={14} />实施方案…</button>}
            {failed.length > 0 && <button className="ghost" onClick={() => actions.retry(record.id)}><Icon name="retry" size={14} />重试未成功的 {failed.length} 个</button>}
            <button className="ghost subtle" onClick={() => void unify.reveal('run', record.id)}><Icon name="folder" size={14} />记录</button>
          </>
        )}
      </div>
    </section>
  );
}

// ── composer ──────────────────────────────────────────────────────────────
export interface ComposerState { selected: string[]; manual: boolean; synth: string }

function SynthesisPicker({ targets, defaultId, value, onChange }: {
  targets: WorkspaceInfo['targets']; defaultId?: string; value: string; onChange(value: string): void;
}) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const defaultTarget = targets.find((target) => target.id === defaultId);
  const choices = [
    { value: '', label: '默认', detail: defaultTarget?.label, icon: 'spark' },
    ...targets.map((target) => ({ value: target.id, label: target.label, detail: target.model, icon: undefined })),
    { value: 'off', label: '不汇总', detail: undefined, icon: 'x' },
  ];
  const selected = choices.find((choice) => choice.value === value) ?? choices[0];
  const triggerLabel = selected.value === 'off' ? selected.label : `汇总 · ${selected.value === '' ? defaultTarget?.label ?? selected.label : selected.label}`;

  return (
    <div className="synth-picker">
      <button
        ref={trigger} type="button" className="synth-trigger" popoverTarget={menuId} aria-haspopup="menu"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      >
        <Icon name="spark" size={13} />
        <span>{triggerLabel}</span>
        <Icon name="chevron" size={12} />
      </button>
      <div
        id={menuId} popover="auto" role="menu" className="synth-popover" aria-label="汇总模型"
        onToggle={(event) => {
          if (event.currentTarget.matches(':popover-open')) {
            event.currentTarget.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') { event.currentTarget.hidePopover(); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const index = items.findIndex((item) => item === document.activeElement);
          const step = event.key === 'ArrowUp' ? -1 : 1;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + step + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {choices.map((choice) => {
          const checked = choice === selected;
          return (
            <button
              key={choice.value} type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1}
              className="synth-item" onClick={(event) => {
                onChange(choice.value);
                event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                trigger.current?.focus();
              }}
            >
              {choice.icon ? <Icon name={choice.icon} size={14} /> : <i className="dot" style={{ '--h': hue(choice.value) } as CSSProperties} />}
              <span className="synth-item-label"><strong>{choice.label}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
              {checked && <Icon name="check" size={14} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Composer({ ws, quota, busy, state, setState, onSend, onCancel, autoFocusKey, followUp, onClearFollowUp, pendingMemoryUpdates, onClearMemoryUpdates }: {
  ws: WorkspaceInfo; quota: Map<string, TargetQuota>; busy: boolean;
  state: ComposerState; setState: (s: ComposerState) => void;
  onSend(text: string): Promise<boolean>; onCancel(): void; autoFocusKey: string;
  followUp?: FollowUpChoice; onClearFollowUp?: () => void;
  pendingMemoryUpdates?: string[]; onClearMemoryUpdates?: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);
  useEffect(() => { area.current?.focus(); }, [autoFocusKey]);

  const usable = ws.targets.filter((t) => t.installed !== false);
  const count = state.selected.length;
  const toggle = (id: string) => {
    const on = state.selected.includes(id);
    setState({ ...state, manual: true, selected: on ? state.selected.filter((s) => s !== id) : [...state.selected, id] });
  };

  const send = async () => {
    const q = text.trim();
    if (!q || busy || sending || !count) return;
    setSending(true);
    const ok = await onSend(q);
    setSending(false);
    if (ok) {
      history.current = [q, ...history.current.filter((h) => h !== q)].slice(0, 50);
      cursor.current = -1;
      setText('');
    }
  };

  return (
    <div className="composer-wrap">
      {followUp && (
        <div className="followup-bar">
          <span><Icon name="check" size={12} />下轮追问将沿用「<b>{followUp.label}</b>」的回答</span>
          <button type="button" onClick={onClearFollowUp} title="恢复默认上下文"><Icon name="x" size={12} /></button>
        </div>
      )}
      {pendingMemoryUpdates && pendingMemoryUpdates.length > 0 && (
        <div className="followup-bar">
          <span><Icon name="bookmark" size={12} />下轮追问将尾部附带 <b>{pendingMemoryUpdates.length}</b> 条新沉淀记忆（不破坏前序缓存）</span>
          <button type="button" onClick={onClearMemoryUpdates} title="取消本会话增量附带"><Icon name="x" size={12} /></button>
        </div>
      )}
      <div className={`composer${busy ? ' busy' : ''}`}>
        <textarea
          ref={area} value={text} rows={1} spellCheck={false}
          placeholder={count ? `向 ${count} 个模型提问…` : usable.length ? '先在下方选择至少一个模型' : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            else if (e.key === 'Escape' && busy) { e.preventDefault(); onCancel(); }
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              const atEdge = e.key === 'ArrowUp' ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
              if (!atEdge || (text && cursor.current === -1)) return;
              const next = cursor.current + (e.key === 'ArrowUp' ? 1 : -1);
              if (next < -1 || next >= history.current.length) return;
              e.preventDefault();
              cursor.current = next;
              setText(next === -1 ? '' : history.current[next]);
            }
          }}
        />
        <div className="composer-bar">
          <div className="chips">
            {usable.map((t) => {
              const q = quotaSummary(quota.get(t.id)?.reading);
              const on = state.selected.includes(t.id);
              return (
                <button
                  key={t.id} type="button" className={`chip${on ? ' on' : ''}${q?.ratio !== undefined && q.ratio < 0.15 ? ' low' : ''}`}
                  style={{ '--h': hue(t.id) } as CSSProperties} onClick={() => toggle(t.id)}
                  title={`${t.label}${t.model ? ` · ${t.model}` : ''}${t.reasoningEffort ? ` · 思考 ${t.reasoningEffort}` : ''}${t.installed === undefined ? '\n正在检测…' : ''}${q?.title ? `\n${q.title}` : ''}`}
                >
                  <i className={`dot${t.installed === undefined ? ' probing' : ''}`} />
                  {t.label}
                  {q?.text && <small>{q.text}</small>}
                </button>
              );
            })}
          </div>
          <SynthesisPicker targets={usable} defaultId={ws.synthesizer} value={state.synth}
            onChange={(synth) => setState({ ...state, synth })} />
          {busy ? (
            <button type="button" className="send stop" onClick={onCancel} title="停止 (Esc)"><Icon name="stop" /></button>
          ) : (
            <button type="button" className="send" disabled={!text.trim() || !count || sending} onClick={() => void send()} title="发送 (Enter)">
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · ↑ 历史{busy ? ' · Esc 停止' : ''}</div>
    </div>
  );
}

// ── execution confirmation ────────────────────────────────────────────────
export function ExecDialog({ initial, onClose, onStarted, onError }: {
  initial: ExecPreview; onClose(): void; onStarted(ids: { turnId: string; sessionId: string }): void; onError(msg: string): void;
}) {
  const [preview, setPreview] = useState(initial);
  const [busy, setBusy] = useState(false);
  const fromValue = preview.source.scope === 'synthesis' ? '' : preview.source.targetId;

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const update = async (from: string | undefined, executor: string) => {
    try { setPreview(await unify.previewExec(preview.turnId, from, executor)); }
    catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="exec-title">
        <h2 id="exec-title">实施方案</h2>
        <p className="lede">执行模型将获得修改项目文件的权限。Unify 不会自动提交或推送。</p>
        <dl className="kv">
          <dt>需求</dt><dd className="clamp">{preview.question}</dd>
          <dt>方案</dt>
          <dd>
            <select value={fromValue} onChange={(e) => void update(e.target.value || undefined, preview.executor.id)}>
              {preview.sources.map((s) => <option key={s.id ?? ''} value={s.id ?? ''}>{s.label}</option>)}
            </select>
          </dd>
          <dt>执行</dt>
          <dd>
            <select value={preview.executor.id} onChange={(e) => void update(preview.from ?? (fromValue || undefined), e.target.value)}>
              {preview.executors.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </dd>
          <dt>目录</dt><dd className="mono">{preview.cwd}</dd>
        </dl>
        <div className="modal-acts">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary" disabled={busy} autoFocus
            onClick={async () => {
              setBusy(true);
              try { onStarted(await unify.exec(preview.turnId, fromValue || undefined, preview.executor.id)); }
              catch (err) { onError(err instanceof Error ? err.message : String(err)); setBusy(false); }
            }}
          >
            开始实施
          </button>
        </div>
      </div>
    </div>
  );
}

// ── save to memory (distill) dialog ───────────────────────────────────────
export function DistillDialog({ initial, source, onClose, onSaved, onError }: {
  initial: DistillPreparation;
  source: DistillSourceRef;
  onClose(): void;
  onSaved(result: DistillApplyResult, applyInSession: boolean): void;
  onError(msg: string): void;
}) {
  const [text, setText] = useState(() => {
    const t = initial.defaultText.trim();
    return t && !t.startsWith('-') && !t.includes('\n') ? `- ${t}` : t;
  });
  const [targetPath, setTargetPath] = useState(initial.defaultTargetPath ?? initial.targets[0]?.path ?? '');
  const [heading, setHeading] = useState('');
  const [replaceRange, setReplaceRange] = useState<{ start: number; end: number }>();
  const [applyInSession, setApplyInSession] = useState(false);
  const [candidates, setCandidates] = useState<DistillCandidate[]>();
  const [distilling, setDistilling] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCheckResult>();
  const [saving, setSaving] = useState(false);

  const selectedTarget = initial.targets.find((t) => t.path === targetPath);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  useEffect(() => {
    if (!targetPath || !text.trim()) { setDuplicates(undefined); return; }
    let stale = false;
    const timer = setTimeout(() => {
      void unify.checkDistillDuplicate(targetPath, text).then((res) => { if (!stale) setDuplicates(res); }, () => undefined);
    }, 200);
    return () => { stale = true; clearTimeout(timer); };
  }, [targetPath, text]);

  const runDistill = async () => {
    setDistilling(true);
    try {
      const list = await unify.distillCandidates({ ...source, selectedText: text.trim() || source.selectedText });
      setCandidates(list);
      if (list.length === 1) setText(list[0].text);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDistilling(false);
    }
  };

  const save = async () => {
    if (!targetPath || !text.trim()) return;
    setSaving(true);
    try {
      const res = await unify.applyDistill({
        source,
        targetPath,
        text: text.trim(),
        heading: heading.trim() || undefined,
        mode: replaceRange ? 'replace' : 'append',
        replaceStart: replaceRange?.start,
        replaceEnd: replaceRange?.end,
        baseHash: selectedTarget?.baseHash,
      });
      onSaved(res, applyInSession);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal distill-modal" role="dialog" aria-modal="true" aria-labelledby="distill-title">
        <header className="distill-head">
          <div>
            <h2 id="distill-title">存为记忆</h2>
            <p className="lede">源自「{initial.sourceLabel}」 · 只写入审阅后的干净规则，来源记录保存在本地审计日志</p>
          </div>
          <button className="btn" type="button" disabled={distilling || saving} onClick={() => void runDistill()}>
            {distilling ? <><Spinner />提炼中…</> : <><Icon name="spark" size={14} />提炼候选</>}
          </button>
        </header>

        {initial.scope === 'exec' && initial.planText && initial.execOutcome && (
          <div className="distill-source-tabs">
            <button type="button" className="btn" onClick={() => { setText(initial.planText!); setReplaceRange(undefined); }}>填入采纳的方案</button>
            <button type="button" className="btn" onClick={() => { setText(initial.execOutcome!); setReplaceRange(undefined); }}>填入实施回报</button>
          </div>
        )}

        {candidates && (
          <div className="distill-cands">
            {candidates.length === 0 ? (
              <p className="faint small">模型未发现值得长期复用的规则，你仍可直接手工编辑并保存。</p>
            ) : candidates.map((c, i) => (
              <button key={i} type="button" className="distill-cand" onClick={() => { setText(c.text); setReplaceRange(undefined); }}>
                <b>{c.text}</b>
                {c.quote && <span>依据：{c.quote}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="distill-field">
          <label>将要写入的记忆条目（Markdown）</label>
          <textarea
            value={text} rows={5} spellCheck={false}
            placeholder="- 例如：本项目的记忆同步必须支持无软链权限的 Windows 环境"
            onChange={(e) => { setText(e.target.value); setReplaceRange(undefined); }}
          />
        </div>

        <dl className="kv distill-kv">
          <dt>目标文件</dt>
          <dd>
            <select value={targetPath} onChange={(e) => { setTargetPath(e.target.value); setReplaceRange(undefined); }}>
              {initial.targets.map((t) => (
                <option key={t.path} value={t.path}>
                  {t.harnessName} · {t.layerTitle} · {t.display}{t.exists ? '' : '（将新建）'}
                </option>
              ))}
            </select>
            {selectedTarget && (
              <div className="faint small distill-target-hint">
                路径：{selectedTarget.path}
                {selectedTarget.sharedWith?.length ? ` · 同时被 ${selectedTarget.sharedWith.join('、')} 读取` : ''}
              </div>
            )}
          </dd>
          <dt>归属小节</dt>
          <dd>
            <input type="text" value={heading} placeholder="留空则追加到文件末尾（可选）" onChange={(e) => setHeading(e.target.value)} />
            {selectedTarget && selectedTarget.headings.length > 0 && (
              <div className="distill-chips">
                {selectedTarget.headings.slice(0, 6).map((hd) => (
                  <button key={hd} type="button" className="distill-chip" onClick={() => setHeading(hd)}>{hd}</button>
                ))}
              </div>
            )}
          </dd>
        </dl>

        {duplicates?.exact && (
          <div className="distill-dup warn">
            <b>已存在相同条目（第 {duplicates.exact.start} 行）</b>
            <span>{duplicates.exact.text}</span>
          </div>
        )}
        {!duplicates?.exact && !!duplicates?.similar.length && (
          <div className="distill-dup">
            <b>发现相似条目（可选择替换或继续追加）</b>
            {duplicates.similar.slice(0, 2).map((s, i) => (
              <div key={i} className="distill-dup-row">
                <span>L{s.start}: {s.text}</span>
                <button
                  type="button" className="link"
                  onClick={() => setReplaceRange(replaceRange?.start === s.start ? undefined : { start: s.start, end: s.end })}
                >
                  {replaceRange?.start === s.start ? '取消替换' : '替换此条'}
                </button>
              </div>
            ))}
          </div>
        )}

        <label className="check distill-session-opt">
          <input type="checkbox" checked={applyInSession} onChange={(e) => setApplyInSession(e.target.checked)} />
          本对话后续追问也遵循此条（以尾部增量附带，不破坏当前 API 前缀缓存）
        </label>

        <div className="modal-acts">
          <span className="faint small" style={{ marginRight: 'auto' }}>立即写入磁盘并自动备份旧版本</span>
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className="btn primary" type="button" disabled={saving || !text.trim() || !targetPath} onClick={() => void save()}>
            {saving ? <><Spinner />保存中…</> : replaceRange ? `替换第 ${replaceRange.start} 行` : '写入记忆'}
          </button>
        </div>
      </div>
    </div>
  );
}
