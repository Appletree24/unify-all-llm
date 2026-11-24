import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { synthesisFormatter } from '../../../src/core/synth.js';
import { graphIssue, graphPlanResult, graphStages, roleNames, type Collaboration } from '../../../src/core/collaboration.js';
import type { DistillApplyResult, DistillCandidate, DistillPreparation, DistillSourceRef, DuplicateCheckResult, ExecPreview, InteractionOption, RunRecord, RunResultRecord, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { unify } from './api.js';
import { useAnimatedDialog, usePresence } from './motion.js';
import { Icon, Markdown, Spinner, hue, isActive, kilo, quotaSummary, seconds, statusText, useTicker } from './ui.js';
import { SynthesisMarkdown } from './SynthesisMarkdown.js';

import { decisionGroups } from './decisions.js';
import { MaterialInput, SavedMaterials, useMaterialInput } from './MaterialInput.js';
import type { MaterialSelection } from '../shared/api.js';
import { CollectQuestionsButton, FollowUpQuestions, LiveQuestions, type PendingInteractionItem, type Respond } from './QuestionPanel.js';

type CardKind = 'answer' | 'synthesis' | 'exec' | 'plan-review' | 'result-review';

/** When each call was first seen running, for elapsed-time labels. */
const firstSeen = new Map<string, number>();

export interface FollowUpChoice {
  turnId: string;
  targetId: string;
  label: string;
}

export interface TurnActions {
  confirmGraph?(record: RunRecord): void;
  reviseGraph?(record: RunRecord): void;
  closeGraph?(record: RunRecord): void;
  zoom(turnId: string, runId: string, trigger: HTMLButtonElement): void;
  exec(turnId: string, from?: string): void;
  retry(turnId: string, targetIds?: string[]): void;
  cancel(turnId: string): void;
  cancelTarget(turnId: string, targetId: string): void;
  respondInteraction: Respond;
  openInteraction(item: PendingInteractionItem): void;
  sendChoices(text: string, record: RunRecord): Promise<void>;
  followUp?(choice?: FollowUpChoice): void;
  benchmark?(turnId: string, call?: string): void;
  feedback(record: RunRecord, call?: string, quote?: string): void;
  distill?(source: DistillSourceRef): void;
}

function ApprovalPrompt({ item, respond }: { item: PendingInteractionItem; respond: Respond }) {
  const { request } = item;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options: InteractionOption[] = request.options?.length ? request.options : [
    { id: 'accept', label: '允许', tone: 'primary' }, { id: 'decline', label: '拒绝', tone: 'danger' },
  ];
  async function submit(optionId: string) {
    setBusy(true);
    setError('');
    try { await respond(item.turnId, request.id, { optionId }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <section className="interact-box" data-interaction-id={request.id} aria-label={request.title}>
    <div className="interact-head"><span className="interact-badge"><Icon name="alert" size={12} />需要确认</span>
      <b>{item.targetLabel}</b>{request.tool && <span className="interact-tool">{request.tool}</span>}</div>
    <div className="interact-title">{request.title}</div>
    {request.detail && <pre className="interact-detail">{request.detail}</pre>}
    <div className="interact-actions">{options.map(opt =>
      <button key={opt.id} type="button" disabled={busy} title={opt.description}
        className={`interact-btn ${opt.tone ?? ''}`} onClick={() => void submit(opt.id)}>{opt.label}</button>)}</div>
    {error && <span role="alert">{error}</span>}
  </section>;
}

const toolStatuses = { pending: '待执行', in_progress: '执行中', completed: '完成', failed: '失败', denied: '权限受限' };

// ── a single model's output ───────────────────────────────────────────────
export function Card({ record, result, kind, showReasoning, interactions, actions, zoomed, canFollowUp, followUpSelected, stagger = 0 }: {
  record: RunRecord; result: RunResultRecord; kind: CardKind; showReasoning: boolean;
  interactions?: PendingInteractionItem[]; actions: TurnActions; zoomed?: boolean; canFollowUp?: boolean; followUpSelected?: boolean; stagger?: number;
}) {
  const emptyAnswer = kind !== 'exec' && result.ok && !result.text.trim();
  const status = emptyAnswer ? 'failed' : result.status;
  const error = result.error ?? (emptyAnswer ? '模型已结束，但没有返回回答正文' : undefined);
  const running = status === 'running';
  const needsInput = !!interactions?.length;
  const now = useTicker(running);
  if (running && !firstSeen.has(result.runId)) firstSeen.set(result.runId, Date.now());
  const call = record.calls.find((c) => c.id === result.runId);
  const target = call?.target ?? record.targets.find((t) => t.id === result.targetId);
  const prefix = { answer: '', synthesis: '汇总', exec: '实施', 'plan-review': '方案复核', 'result-review': '实施复核' }[kind];
  const label = (prefix ? prefix + ' · ' : '') + (target?.label ?? result.targetId);
  const review = kind === 'plan-review' || kind === 'result-review';
  const meta = [result.model, result.reasoningEffort && `思考 ${result.reasoningEffort}`].filter(Boolean).join(' · ');
  const elapsed = running ? now - (firstSeen.get(result.runId) ?? now) : result.durationMs;
  const turnRunning = isActive(record);

  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && (running || needsInput) && stick.current) el.scrollTop = el.scrollHeight;
  }, [result.text, result.reasoning, result.tools, interactions?.length, running, needsInput]);

  const [thinkOpen, setThinkOpen] = useState(showReasoning);
  const [quote, setQuote] = useState('');
  const readSelection = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !body.current?.contains(selection.anchorNode) || !body.current.contains(selection.focusNode)) { setQuote(''); return; }
    const anchor = selection.anchorNode?.parentElement?.closest('.md');
    setQuote(anchor && anchor.contains(selection.focusNode) ? selection.toString().trim() : '');
  };
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const copyAnswer = async () => {
    try { await unify.copy(text); }
    catch { return; }
    window.clearTimeout(copyTimer.current);
    setCopied(true);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
  };
  const waiting = running && !result.text && !result.reasoning && !needsInput;
  const format = kind === 'synthesis' ? synthesisFormatter(record) : undefined;
  const sourceCheck = kind === 'synthesis' ? record.synthesis?.sourceCheck : undefined;
  const text = format?.(result.text) ?? result.text;
  const reasoning = format?.(result.reasoning) ?? result.reasoning;
  const tools = result.tools;

  return (
    <article id={zoomed ? undefined : 'call-' + result.runId} className={`card ${kind} ${status}${needsInput ? ' needs-input' : ''}${zoomed ? ' zoomed' : ''}`}
      style={{ '--h': hue(result.targetId), '--stagger': stagger } as CSSProperties}>
      <span className="card-activity" aria-hidden="true" />
      <header>
        {kind === 'synthesis' ? <span className="mark"><Icon name="spark" size={14} /></span> : kind === 'exec' ? <span className="mark"><Icon name="run" size={14} /></span> : <i className="dot" />}
        <div className="who">
          <b>{label}</b>
          {meta && <span className="model">{meta}</span>}
        </div>
        <span className={`status ${needsInput ? 'waiting-input' : status}`}>
          {needsInput ? <Icon name="alert" size={12} /> : running ? <Spinner /> : null}
          {needsInput ? '等待交互' : running ? seconds(elapsed) : `${statusText[status]}${result.durationMs ? ` · ${seconds(result.durationMs)}` : ''}`}
        </span>
      </header>
      <div
        className="body" ref={body} onMouseUp={readSelection} onKeyUp={readSelection}
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
        {sourceCheck && (sourceCheck.excerpts.length ? (
          <details className="think">
            <summary>源码证据<span>{sourceCheck.excerpts.length} 处</span></summary>
            <div className="source-evidence">
              {sourceCheck.excerpts.map(({ path, line, quote }, i) => (
                <div key={i}><code>{path}:{line}</code><pre>{quote}</pre></div>
              ))}
            </div>
          </details>
        ) : <p className="hint" title={sourceCheck.question}>定点核查未匹配到源码原文</p>)}
        {result.reasoning && (
          <details className="think" open={thinkOpen || (running && !result.text && showReasoning)} onToggle={(e) => setThinkOpen((e.target as HTMLDetailsElement).open)}>
            <summary>思考过程<span>{kilo(reasoning.length)} 字</span></summary>
            <div className="think-text">{reasoning}</div>
          </details>
        )}
        {tools && tools.length > 0 && (
          <ul className="tools">
            {tools.map((tool, index) => {
              const label = <><b>{tool.name}</b>{tool.detail && <span>{tool.detail}</span>}
                {tool.status && <small className={tool.status}>{toolStatuses[tool.status]}</small>}</>;
              return (
                <li key={tool.id ?? index}>
                  {tool.detail || tool.error ? (
                    <details>
                      <summary><Icon name="chevron" size={12} />{label}</summary>
                      {tool.detail && <pre>{tool.detail}</pre>}
                      {tool.error && <pre className="tool-error">{tool.error}</pre>}
                    </details>
                  ) : <div className="tool-label">{label}</div>}
                </li>
              );
            })}
          </ul>
        )}
        {waiting ? (
          <div className="skeleton"><i /><i /><i /></div>
        ) : result.text ? (
          kind === 'synthesis' ? <SynthesisMarkdown record={record} text={result.text} /> : <Markdown text={text} />
        ) : !running && !error ? <p className="empty">没有输出</p> : null}
        {interactions?.length ? <button type="button" className="btn" onClick={() => actions.openInteraction(interactions[0])}>
          查看待处理问题
        </button> : null}
        {error && <div className="error"><Icon name="alert" size={14} /><span>{error}</span></div>}
      </div>
      <footer>
        <span className="usage">
          {result.usage && (result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined || result.usage.cachedInputTokens !== undefined)
            ? `↑${kilo(result.usage.inputTokens)}${result.usage.cachedInputTokens !== undefined ? ` (缓存 ${kilo(result.usage.cachedInputTokens)})` : ''} ↓${kilo(result.usage.outputTokens)} tokens`
            : ''}
        </span>
        <span className="acts">
          {running && kind === 'answer' && record.status === 'answering' && (
            <button title="取消这个模型，其余继续" onClick={() => actions.cancelTarget(record.id, result.targetId)}><Icon name="x" /></button>
          )}
          {text && <button className="copy-answer" data-copied={copied || undefined} title={copied ? '已复制' : '复制'}
            aria-label={copied ? '已复制' : '复制'} onClick={() => void copyAnswer()}><Icon key={String(copied)} name={copied ? 'check' : 'copy'} /></button>}
          {!review && !turnRunning && !running && <button title="标注、改写、评分或留作评测" onClick={() => actions.feedback(record, result.runId, quote)}>{quote ? '标注选段' : '反馈 / 留题'}</button>}
          {!review && result.ok && !turnRunning && text && actions.distill && (
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
          {kind === 'answer' && !record.collaboration && !running && !turnRunning && (
            <button title="只重新调用这个模型" onClick={() => actions.retry(record.id, [result.targetId])}><Icon name="retry" /></button>
          )}
          {kind === 'answer' && result.ok && !emptyAnswer && !turnRunning && canFollowUp && actions.followUp && (
            <button
              className={followUpSelected ? 'on' : undefined}
              title={followUpSelected ? '已选为下轮追问上下文（再次点击恢复默认）' : '下轮追问沿用这个回答'}
              onClick={() => actions.followUp!(followUpSelected ? undefined : { turnId: record.id, targetId: result.targetId, label })}
            >
              <Icon name="check" />
            </button>
          )}
          {kind === 'answer' && !record.collaboration && result.ok && !emptyAnswer && !turnRunning && (
            <button title="按这个回答实施" onClick={() => actions.exec(record.id, result.targetId)}><Icon name="run" /></button>
          )}
          <button data-zoom-close={zoomed || undefined} title={zoomed ? '退出放大 (Esc)' : '放大阅读'}
            onClick={e => actions.zoom(record.id, zoomed ? '' : result.runId, e.currentTarget)}><Icon name={zoomed ? 'shrink' : 'expand'} /></button>
        </span>
      </footer>
    </article>
  );
}

// ── one round: question, answers, synthesis ───────────────────────────────
function GraphProgress({ graph, record, execution, pending }: { graph: Collaboration; record: RunRecord; execution?: RunRecord; pending: boolean }) {
  const scope = { plan:'answer', merge:'synthesis', check:'plan-review', execution:'exec', audit:'result-review' } as const;
  const calls = [...record.calls, ...(execution?.calls ?? [])];
  return <nav className="cg-progress" aria-label={graph.name + '进度'}><b>{graph.name}</b>{graphStages(graph).map(step => {
    const matching = step === 'confirm' ? [] : calls.filter(c => c.scope === scope[step]);
    const running = matching.find(c => c.result.status === 'running');
    const ended = step === 'confirm' ? !!execution : matching.length > 0 && matching.every(c => c.result.ok);
    const current = !!running || (step === 'confirm' && pending);
    const failed = matching.some(c => !c.result.ok && c.result.status !== 'running');
    const dest = step === 'confirm' ? 'gate-' + record.id : matching[0] && 'call-' + (running ?? matching[0]).id;
    const label = step === 'confirm' ? roleNames.confirm : step === 'plan' ? graph.plans[0].label ?? '方案' : graph[step]?.label ?? roleNames[step];
    return <button key={step} aria-current={current ? 'step' : undefined} className={current ? 'current' : failed ? 'failed' : ''}
      aria-label={ended ? label + '，已完成' : failed ? label + '，失败' : undefined}
      disabled={!dest} onClick={() => dest && document.getElementById(dest)?.scrollIntoView({block:'center'})}>
      {ended ? <span className="cg-step-done" aria-hidden="true">✓</span> : failed ? <span aria-hidden="true">×</span> : current ? <span className="cg-step-dot" aria-hidden="true" /> : null}
      {label}
    </button>;
  })}</nav>;
}
export function Turn({ record, notices, interactions, showReasoning, actions, isLatestComparison, isLatestTurn, followUp, execution, graphExecutor, choiceBlocker }: {
  record: RunRecord; notices: string[]; interactions?: Record<string, PendingInteractionItem[]>; showReasoning: boolean; actions: TurnActions;
  isLatestComparison?: boolean; isLatestTurn?: boolean; followUp?: FollowUpChoice; execution?: RunRecord; graphExecutor?: string; choiceBlocker?: string;
}) {
  const active = isActive(record);
  const messages = [...new Set([...notices, ...record.calls.flatMap(c =>
    (c.result.cacheWarnings ?? []).map(w => '缓存监控 · ' + c.target.label + ' · ' + w))])];
  const noticesView = messages.length > 0 && <div className="notices" role="status">{messages.map(m => <div key={m}>{m}</div>)}</div>;
  const pendingItems = Object.values(interactions ?? {}).flat().filter(item => item.turnId === record.id);
  const live = pendingItems.filter(item => item.request.kind !== 'approval');
  const requests = <>
    {pendingItems.filter(item => item.request.kind === 'approval').map(item =>
      <ApprovalPrompt key={item.request.id} item={item} respond={actions.respondInteraction} />)}
    {live.length > 0 && <LiveQuestions items={live} respond={actions.respondInteraction} />}
  </>;
  const showChoices = isLatestTurn && !active && record.kind === 'comparison' && !record.collaborationClosed;
  const from = followUp?.turnId === record.id ? followUp.targetId : undefined;
  const choices = useMemo(() => showChoices ? decisionGroups(record, from) : [], [showChoices, record, from]);
  const time = new Date(record.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const reviewCards = record.calls.filter(c => c.scope === 'plan-review' || c.scope === 'result-review').map(c =>
    <Card key={c.id} record={record} result={c.result} kind={c.scope as 'plan-review' | 'result-review'} showReasoning={showReasoning} actions={actions} interactions={interactions?.[c.id]} />);
  if (record.kind === 'execution') {
    const result = record.results[0];
    const src = record.planSource;
    const srcLabel = src ? (src.scope === 'synthesis' ? '汇总' : src.scope === 'plan-review' ? '复核后的方案' : record.targets.find((t) => t.id === src.targetId)?.label ?? src.targetId) : '';
    return (
      <section className="turn exec-turn" id={'turn-' + record.id}>
        <div className="q small">
          <div className="q-kicker"><Icon name="run" size={13} />实施方案{srcLabel && <> · 依据「{srcLabel}」</>}<span>{time}</span></div>
        </div>
        {noticesView}
        {result ? <Card key={result.runId} record={record} result={result} kind="exec" showReasoning={showReasoning} interactions={interactions?.[result.runId]} actions={actions} />
          : <div className="pending"><Spinner />正在准备实施…</div>}
        {reviewCards}
        {requests}
        {record.error && <div className="error"><Icon name="alert" size={14} /><span>{record.error}</span></div>}
        <div className="turn-foot">
          {active ? <button className="ghost" onClick={() => actions.cancel(record.id)}><Icon name="stop" size={14} />停止实施</button>
            : result?.ok ? <span className="hint"><Icon name="check" size={14} />实施完成，请用 git diff 检查改动</span> : null}
          {record.collaboration && isLatestTurn && !active && <button className="btn" onClick={() => actions.reviseGraph?.(record)}>带回方案讨论</button>}
        </div>
      </section>
    );
  }

  const answers = record.results;
  const failed = answers.filter((r) => !r.ok && r.status !== 'running');
  const anyOk = answers.some((r) => r.ok) || record.synthesis?.result.ok;
  const n = Math.min(Math.max(answers.length, 1), 3);
  const pending = !!(isLatestComparison && !execution && graphPlanResult(record));
  return (
    <section className="turn" id={'turn-' + record.id}>
      <div className="q">
        <div className="q-text">{record.question}</div>
        <SavedMaterials record={record} />
        <div className="q-meta">
          <span>{time}</span>
          {record.retryOf && <span>重试</span>}
          {answers.length > 0 && <span>{answers.length} 个模型</span>}
        </div>
      </div>
      {record.collaboration && <GraphProgress graph={record.collaboration} record={record} execution={execution} pending={pending} />}
      {record.status === 'deciding' && <div className="pending"><Spinner />正在决定由哪些模型回答…</div>}
      {record.status === 'created' && <div className="pending"><Spinner />正在检查模型…</div>}
      {noticesView}
      {answers.length > 0 && (
        <div className={`answers n${n}`}>
          {answers.map((r, index) => (
            <Card
              key={r.runId} record={record} result={r} kind="answer" stagger={index} showReasoning={showReasoning}
              interactions={interactions?.[r.runId]} actions={actions}
              canFollowUp={isLatestComparison}
              followUpSelected={followUp?.turnId === record.id && followUp.targetId === r.targetId}
            />
          ))}
        </div>
      )}
      {record.synthesis && <Card key={record.synthesis.result.runId} record={record} result={record.synthesis.result} kind="synthesis" showReasoning={showReasoning} interactions={interactions?.[record.synthesis.result.runId]} actions={actions} />}
      {reviewCards}
      {requests}
      {choices.length > 0 && <FollowUpQuestions key={from ?? ''} groups={choices} blocked={choiceBlocker}
        send={text => actions.sendChoices(text, record)} />}
      {record.collaboration && <div id={'gate-' + record.id}>
        {pending ? <div className="cg-confirm"><b>方案已就绪，交由 {graphExecutor ?? record.collaboration.execution.target} 开始实施？</b>
          <footer><button className="btn primary" onClick={() => actions.confirmGraph?.(record)}>确认并实施</button>
          <button className="btn" onClick={() => actions.reviseGraph?.(record)}>继续修改方案</button>
          <button className="ghost" onClick={() => actions.closeGraph?.(record)}>终止协作</button></footer></div>
          : record.collaborationClosed ? <span className="hint">协作已终止</span> : null}
      </div>}
      {record.error && <div className="error"><Icon name="alert" size={14} /><span>{record.error}</span></div>}
      <div className="turn-foot">
        {active ? (
          <button className="ghost" onClick={() => actions.cancel(record.id)}><Icon name="stop" size={14} />取消本轮</button>
        ) : (
          <>
            {anyOk && !record.collaboration && <button className="ghost" onClick={() => actions.exec(record.id)}><Icon name="run" size={14} />实施方案…</button>}
            {anyOk && showChoices && !choices.length && <CollectQuestionsButton blocked={choiceBlocker} send={text => actions.sendChoices(text, record)} />}
            {actions.benchmark && <button className="ghost" onClick={() => actions.feedback(record)}>{answers.length > 1 ? '比较回答 / 整轮留题' : '整轮反馈 / 留题'}</button>}
            {(record.collaboration ? isLatestComparison && !execution && ['failed','partial','interrupted','cancelled'].includes(record.status) : failed.length > 0) && <button className="ghost" onClick={() => actions.retry(record.id)}><Icon name="retry" size={14} />{record.collaboration ? '重新运行协作方案' : '重试未成功的 ' + failed.length + ' 个'}</button>}
            <button className="ghost subtle" onClick={() => void unify.reveal('run', record.id)}><Icon name="folder" size={14} />记录</button>
          </>
        )}
      </div>
    </section>
  );
}

// ── composer ──────────────────────────────────────────────────────────────
export interface ComposerState { selected: string[]; synth: string; graph?: string }

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

function ModePicker({ graphs, value, revision, route, onSelect, onManage }: {
  graphs: WorkspaceInfo['collaborationGraphs'];
  value?: string;
  revision?: Collaboration;
  route?: string;
  onSelect(id?: string): void;
  onManage(): void;
}) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const current = revision ? 'revision' : value ?? '';
  const items: { value: string; label: string; detail?: string; icon: string }[] = [
    { value: '', label: '普通问答', detail: '自由选择参与模型与汇总', icon: 'chat' },
    ...(revision ? [{ value: 'revision', label: `修改 · ${revision.name}`, detail: '由原方案模型沿用记录调整', icon: 'edit' }] : []),
    ...Object.entries(graphs).map(([id, g]) => ({ value: id, label: g.name, detail: '组合模版', icon: 'layers' })),
  ];
  const active = items.find((item) => item.value === current) ?? items[0];
  const isGraph = !!current;

  return (
    <div className="synth-picker mode-picker">
      <button
        ref={trigger} type="button" className={`synth-trigger mode-trigger${isGraph ? ' on' : ''}`}
        popoverTarget={menuId} aria-haspopup="menu" aria-label="本轮协作模式" title={route ?? '选择普通问答或组合模版'}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      >
        <Icon name="layers" size={13} />
        <span>{active.label}</span>
        <Icon name="chevron" size={12} />
      </button>
      <div
        id={menuId} popover="auto" role="menu" className="synth-popover mode-popover" aria-label="本轮协作模式"
        onToggle={(event) => {
          if (event.currentTarget.matches(':popover-open')) {
            event.currentTarget.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') { event.currentTarget.hidePopover(); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')];
          const index = buttons.findIndex((item) => item === document.activeElement);
          const step = event.key === 'ArrowUp' ? -1 : 1;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {items.map((item) => {
          const checked = item.value === active.value;
          return (
            <button
              key={item.value} type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1}
              className="synth-item" onClick={(event) => {
                onSelect(item.value || undefined);
                event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                trigger.current?.focus();
              }}
            >
              <Icon name={item.icon} size={14} />
              <span className="synth-item-label"><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
              {checked && <Icon name="check" size={14} />}
            </button>
          );
        })}
        <div className="popover-sep" role="separator" />
        <button
          type="button" role="menuitem" tabIndex={-1} className="synth-item"
          onClick={(event) => {
            event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
            onManage();
          }}
        >
          <Icon name="sliders" size={14} />
          <span className="synth-item-label"><strong>管理组合模版…</strong></span>
        </button>
      </div>
    </div>
  );
}

export function Composer({ home = false, ws, quota, busy, state, onToggleTarget, onSynthesisChange, onSend, onCancel, autoFocusKey, followUp, onClearFollowUp, pendingMemoryUpdates, onClearMemoryUpdates, onGraph, editGraph, revision, inserted, consumed }: {
  home?: boolean; ws: WorkspaceInfo; quota: Map<string, TargetQuota>; busy: boolean;
  onGraph(id?: string): void; editGraph(): void; revision?: Collaboration;
  state: ComposerState; onToggleTarget(id: string): void; onSynthesisChange(value: string): void;
  onSend(text: string, materials?: MaterialSelection[]): Promise<boolean>; onCancel(): void; autoFocusKey: string;
  inserted?: { text: string }; consumed?(): void;
  followUp?: FollowUpChoice; onClearFollowUp?: () => void;
  pendingMemoryUpdates?: string[]; onClearMemoryUpdates?: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const materials = useMaterialInput(ws.cwd);
  const area = useRef<HTMLTextAreaElement>(null);
  const previousInsert = useRef<typeof inserted>(undefined);
  useEffect(() => {
    if (!inserted || inserted === previousInsert.current) return;
    previousInsert.current = inserted;
    setText(value => [value.trimEnd(), inserted.text].filter(Boolean).join('\n\n'));
    consumed?.(); area.current?.focus();
  }, [inserted, consumed]);
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const followUpPresence = usePresence(followUp);
  const memoryPresence = usePresence(pendingMemoryUpdates?.length || undefined);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text, home]);
  useEffect(() => { area.current?.focus(); }, [autoFocusKey]);

  const usable = ws.targets.filter((t) => t.installed !== false);
  const graph = revision ?? (state.graph ? ws.collaborationGraphs[state.graph] : undefined);
  const problem = graph && graphIssue(graph, ws.targets);
  const count = graph ? (problem ? 0 : graph.plans.length) : state.selected.length;
  const route = graph && graphStages(graph).map(s => s === 'confirm' ? '本人确认' : s === 'plan' ? graph.plans.map(p => p.target).join(' + ') : graph[s]!.target).join(' → ');
  const send = async () => {
    const q = text.trim() || (materials.drafts.length ? '请根据附上的材料作答。' : '');
    if (!q || busy || sending || materials.pending || materials.recording || !count) return;
    setSending(true);
    const ok = await onSend(q, materials.drafts.map(d => ({ id: d.item.id, note: d.note })));
    setSending(false);
    if (ok) {
      history.current = [q, ...history.current.filter((h) => h !== q)].slice(0, 50);
      cursor.current = -1;
      setText('');
      materials.clear();
    }
  };

  return (
    <div className={`composer-wrap${home ? ' home' : ''}`}>
      {followUpPresence.rendered && (
        <div className="motion-fold" data-presence={followUpPresence.state} inert={followUpPresence.state === 'closing'}>
          <div className="motion-fold-inner">
            <div className="followup-bar">
              <span><Icon name="check" size={12} />下轮追问将沿用「<b>{followUpPresence.rendered.label}</b>」的回答</span>
              <button type="button" onClick={onClearFollowUp} title="恢复默认上下文"><Icon name="x" size={12} /></button>
            </div>
          </div>
        </div>
      )}
      {memoryPresence.rendered && (
        <div className="motion-fold" data-presence={memoryPresence.state} inert={memoryPresence.state === 'closing'}>
          <div className="motion-fold-inner">
            <div className="followup-bar">
              <span><Icon name="bookmark" size={12} />下轮追问将尾部附带 <b>{memoryPresence.rendered}</b> 条新沉淀记忆（不破坏前序缓存）</span>
              <button type="button" onClick={onClearMemoryUpdates} title="取消本会话增量附带"><Icon name="x" size={12} /></button>
            </div>
          </div>
        </div>
      )}
      <div className={`composer${busy ? ' busy' : ''}`} onPaste={e => { if (!sending) materials.paste(e); }} onDrop={e => { if (!sending) materials.drop(e); }}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}>
        <textarea
          ref={area} value={text} rows={home ? 2 : 1} spellCheck={false}
          placeholder={problem ?? (revision ? '告诉方案模型你想调整什么…' : graph ? '描述要协作完成的任务…' : count ? (home ? '问点什么，或描述你想做的事…' : '继续提问…') : '先选择一个回答模型')}
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
        <MaterialInput input={materials} disabled={sending} />
        <div className="composer-bar">
          <ModePicker graphs={ws.collaborationGraphs} value={state.graph} revision={revision} route={route} onSelect={onGraph} onManage={editGraph} />
          {graph ? (
            <button type="button" className="synth-trigger" onClick={editGraph} title="编辑组合模版"><Icon name="sliders" size={13} /><span>编辑模版</span></button>
          ) : (
            <span className="composer-sep" aria-hidden="true" />
          )}
          <div className="chips">
            {!graph && usable.map((t) => {
              const q = quotaSummary(quota.get(t.id)?.reading, t);
              const on = state.selected.includes(t.id);
              return (
                <button
                  key={t.id} type="button" className={`chip${on ? ' on' : ''}${q?.ratio !== undefined && q.ratio < 0.15 ? ' low' : ''}`}
                  style={{ '--h': hue(t.id) } as CSSProperties} onClick={() => onToggleTarget(t.id)} aria-pressed={on}
                  title={`${t.label}${t.model ? ` · ${t.model}` : ''}${t.reasoningEffort ? ` · 思考 ${t.reasoningEffort}` : ''}${t.installed === undefined ? '\n正在检测…' : ''}${q?.title ? `\n${q.title}` : ''}`}
                >
                  <i className={`dot${t.installed === undefined ? ' probing' : ''}`} />
                  {t.label}
                  {q?.text && <small>{q.text}</small>}
                </button>
              );
            })}
          </div>
          {!graph && <SynthesisPicker targets={usable} defaultId={ws.synthesizer} value={state.synth} onChange={onSynthesisChange} />}
          <button type="button" className={`send${busy ? ' stop' : ''}`} disabled={!busy && ((!text.trim() && !materials.drafts.length) || !count || sending || !!materials.pending || !!materials.recording)}
            onClick={busy ? onCancel : () => void send()} title={busy ? '停止 (Esc)' : '发送 (Enter)'}>
            <Icon key={busy ? 'stop' : 'send'} name={busy ? 'stop' : 'send'} />
          </button>
        </div>
      </div>
      {revision && <p className="cg-note">下一轮由原方案模型接手，沿用这份协作图和已有记录。</p>}
      {problem && <p className="cg-warning" role="status">{problem}</p>}
      {!home && <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · ↑ 历史{busy ? ' · Esc 停止' : ''}</div>}
    </div>
  );
}

// ── execution confirmation ────────────────────────────────────────────────
function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
}

export function ExecDialog({ initial, open, onClose, onStarted, onError }: {
  initial: ExecPreview; open: boolean; onClose(): void; onStarted(ids: { turnId: string; sessionId: string }): void; onError(msg: string): void;
}) {
  const dialog = useAnimatedDialog(open);
  const [preview, setPreview] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fromValue = preview.source.scope === 'synthesis' ? '' : preview.source.targetId;

  const reportError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (dialog.current?.open) setError(message);
    else onError(message);
  };
  const update = async (from: string | undefined, executor: string) => {
    setError('');
    try { setPreview(await unify.previewExec(preview.turnId, from, executor)); }
    catch (err) { reportError(err); }
  };

  return (
    <dialog className="modal exec-dialog" ref={dialog} aria-labelledby="exec-title" inert={!open}
      onCancel={e => { e.preventDefault(); onClose(); }} onMouseDown={e => { if (isBackdrop(e)) onClose(); }}>
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
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="modal-acts">
        <button className="btn" onClick={onClose}>取消</button>
        <button
          className="btn primary" disabled={busy} autoFocus
          onClick={async () => {
            setBusy(true);
            setError('');
            try { onStarted(await unify.exec(preview.turnId, fromValue || undefined, preview.executor.id)); }
            catch (err) { reportError(err); setBusy(false); }
          }}
        >
          开始实施
        </button>
      </div>
    </dialog>
  );
}

// ── save to memory (distill) dialog ───────────────────────────────────────
export function DistillDialog({ initial, source, open, onClose, onSaved, onError }: {
  initial: DistillPreparation;
  source: DistillSourceRef;
  open: boolean;
  onClose(): void;
  onSaved(result: DistillApplyResult, applyInSession: boolean): void;
  onError(msg: string): void;
}) {
  const dialog = useAnimatedDialog(open);
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
  const [error, setError] = useState('');

  const selectedTarget = initial.targets.find((t) => t.path === targetPath);

  const reportError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (dialog.current?.open) setError(message);
    else onError(message);
  };

  useEffect(() => {
    if (!open) return;
    if (!targetPath || !text.trim()) { setDuplicates(undefined); return; }
    let stale = false;
    const timer = setTimeout(() => {
      void unify.checkDistillDuplicate(targetPath, text).then((res) => { if (!stale) setDuplicates(res); }, () => undefined);
    }, 200);
    return () => { stale = true; clearTimeout(timer); };
  }, [open, targetPath, text]);

  const runDistill = async () => {
    setDistilling(true);
    setError('');
    try {
      const list = await unify.distillCandidates({ ...source, selectedText: text.trim() || source.selectedText });
      setCandidates(list);
      if (list.length === 1) setText(list[0].text);
    } catch (err) {
      reportError(err);
    } finally {
      setDistilling(false);
    }
  };

  const save = async () => {
    if (!targetPath || !text.trim()) return;
    setSaving(true);
    setError('');
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
      reportError(err);
      setSaving(false);
    }
  };

  return (
    <dialog className="modal distill-modal" ref={dialog} aria-labelledby="distill-title" inert={!open}
      onCancel={e => { e.preventDefault(); onClose(); }} onMouseDown={e => { if (isBackdrop(e)) onClose(); }}>
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

      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="modal-acts">
        <span className="faint small" style={{ marginRight: 'auto' }}>立即写入磁盘并自动备份旧版本</span>
        <button className="btn" type="button" onClick={onClose}>取消</button>
        <button className="btn primary" type="button" disabled={saving || !text.trim() || !targetPath} onClick={() => void save()}>
          {saving ? <><Spinner />保存中…</> : replaceRange ? `替换第 ${replaceRange.start} 行` : '写入记忆'}
        </button>
      </div>
    </dialog>
  );
}
