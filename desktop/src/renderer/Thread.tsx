import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { synthesisFormatter } from '../../../src/core/synth.js';
import type { ExecPreview, RunRecord, RunResultRecord, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { unify } from './api.js';
import { Icon, Markdown, Spinner, hue, isActive, kilo, quotaSummary, seconds, statusText, useTicker } from './ui.js';

export interface Activity { name: string; detail?: string }
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
  followUp?(choice?: FollowUpChoice): void;
}

// ── a single model's output ───────────────────────────────────────────────
export function Card({ record, result, kind, showReasoning, activity, actions, zoomed, canFollowUp, followUpSelected }: {
  record: RunRecord; result: RunResultRecord; kind: CardKind; showReasoning: boolean;
  activity?: Activity[]; actions: TurnActions; zoomed?: boolean; canFollowUp?: boolean; followUpSelected?: boolean;
}) {
  const running = result.status === 'running';
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
    if (el && running && stick.current) el.scrollTop = el.scrollHeight;
  }, [result.text, result.reasoning, activity?.length, running]);

  const [thinkOpen, setThinkOpen] = useState(showReasoning);
  const waiting = running && !result.text && !result.reasoning;
  const format = kind === 'synthesis' ? synthesisFormatter(record) : undefined;
  const text = format?.(result.text) ?? result.text;
  const reasoning = format?.(result.reasoning) ?? result.reasoning;
  const tools = activity?.length ? activity : result.tools;

  return (
    <article className={`card ${kind} ${result.status}${zoomed ? ' zoomed' : ''}`} style={{ '--h': hue(result.targetId) } as CSSProperties}>
      <header>
        {kind === 'synthesis' ? <span className="mark"><Icon name="spark" size={14} /></span> : kind === 'exec' ? <span className="mark"><Icon name="run" size={14} /></span> : <i className="dot" />}
        <div className="who">
          <b>{label}</b>
          {meta && <span className="model">{meta}</span>}
        </div>
        <span className={`status ${result.status}`}>
          {running ? <Spinner /> : null}
          {running ? seconds(elapsed) : `${statusText[result.status]}${result.durationMs ? ` · ${seconds(result.durationMs)}` : ''}`}
        </span>
      </header>
      <div
        className="body" ref={body}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
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
        {result.error && <div className="error"><Icon name="alert" size={14} /><span>{result.error}</span></div>}
      </div>
      <footer>
        <span className="usage">
          {result.usage?.inputTokens || result.usage?.outputTokens ? `↑${kilo(result.usage?.inputTokens)} ↓${kilo(result.usage?.outputTokens)} tokens` : ''}
        </span>
        <span className="acts">
          {running && kind === 'answer' && record.status === 'answering' && (
            <button title="取消这个模型，其余继续" onClick={() => actions.cancelTarget(record.id, result.targetId)}><Icon name="x" /></button>
          )}
          {text && <button title="复制" onClick={() => void unify.copy(text)}><Icon name="copy" /></button>}
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
export function Turn({ record, notices, activity, showReasoning, actions, isLatestComparison, followUp }: {
  record: RunRecord; notices: string[]; activity: Record<string, Activity[]>; showReasoning: boolean; actions: TurnActions;
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
        {result ? <Card record={record} result={result} kind="exec" showReasoning={showReasoning} activity={activity[result.runId]} actions={actions} />
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
              activity={activity[r.runId]} actions={actions}
              canFollowUp={isLatestComparison}
              followUpSelected={followUp?.turnId === record.id && followUp.targetId === r.targetId}
            />
          ))}
        </div>
      )}
      {record.synthesis && <Card record={record} result={record.synthesis.result} kind="synthesis" showReasoning={showReasoning} actions={actions} />}
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

export function Composer({ ws, quota, busy, state, setState, onSend, onCancel, autoFocusKey, followUp, onClearFollowUp }: {
  ws: WorkspaceInfo; quota: Map<string, TargetQuota>; busy: boolean;
  state: ComposerState; setState: (s: ComposerState) => void;
  onSend(text: string): Promise<boolean>; onCancel(): void; autoFocusKey: string;
  followUp?: FollowUpChoice; onClearFollowUp?: () => void;
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
