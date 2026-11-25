import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { graphIssue, graphStages, roleNames, type Collaboration, type GraphRole, type GraphStep } from '../../../src/core/collaboration.js';
import type { WorkspaceInfo } from '../shared/api.js';
import { unify } from './api.js';
import { Icon } from './ui.js';
import { usePresence } from './motion.js';
import { CombinationCanvas } from './CombinationCanvas.js';
import './CollaborationGraph.css';

type EditableStep = Exclude<GraphStep, 'confirm'>;
type Selection = { step: EditableStep; index: number };
const symbols = { plan: 'chat', merge: 'layers', check: 'check', execution: 'run', audit: 'search', report: 'chat' };

export function CollaborationGraph({ ws, initial, connect, notify }: {
  ws: WorkspaceInfo; initial?: string; connect(): void; notify(message: string, kind?: 'ok' | 'err'): void;
}) {
  const [id,setId] = useState(initial || Object.keys(ws.collaborationGraphs)[0] || '');
  const [editing,setEditing] = useState<Selection & { role: GraphRole }>();
  const menuPresence = usePresence(editing);
  const [naming,setNaming] = useState<'rename' | 'copy'>();
  const [name,setName] = useState('');
  const [saving,setSaving] = useState(false);
  const lock = useRef(false);
  const history = useRef<{ id: string; graph: Collaboration | undefined }[]>([]);
  const menu = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const graph = ws.collaborationGraphs[id];
  const visibleEditing = menuPresence.rendered;
  const role = visibleEditing && ((editing && graph && (editing.step === 'plan' ? graph.plans[editing.index] : graph[editing.step])) ?? visibleEditing.role);
  const selectedTarget = visibleEditing?.step === 'report' ? graph?.report?.target : role?.target;
  const targetLabel = (target: string) => ws.targets.find(t => t.id === target)?.label ?? target;
  const issue = graph && graphIssue(graph, ws.targets);
  function dismiss() {
    if (menu.current?.matches(':popover-open')) menu.current.hidePopover();
    setEditing(undefined);
  }
  function choose(next: string) { dismiss(); setId(next); setNaming(undefined); }
  async function persist(key: string, next: Collaboration | undefined, remember = true) {
    if (lock.current) return false;
    lock.current = true; setSaving(true);
    try {
      await unify.saveCollaboration(ws.cwd, key, next);
      if (remember) history.current.push({ id:key, graph:ws.collaborationGraphs[key] });
      return true;
    } catch (err) { notify(String(err instanceof Error ? err.message : err),'err'); return false; }
    finally { lock.current = false; setSaving(false); }
  }
  async function change(next: Collaboration) { dismiss(); await persist(id,next); }
  async function undo() {
    const previous = history.current.at(-1);
    if (previous && await persist(previous.id,previous.graph,false)) {
      history.current.pop();
      choose(previous.graph ? previous.id : Object.keys(ws.collaborationGraphs).find(key => key !== previous.id) ?? '');
    }
  }
  useLayoutEffect(() => {
    const pop = menu.current, trigger = anchor.current;
    if (!editing || !pop || !trigger) return;
    pop.showPopover();
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      pop.style.left = Math.max(8,Math.min(rect.left,window.innerWidth-pop.offsetWidth-8)) + 'px';
      pop.style.top = (rect.bottom + pop.offsetHeight < window.innerHeight-8 ? rect.bottom + 4 : Math.max(8,rect.top-pop.offsetHeight-4)) + 'px';
    };
    position();
    pop.querySelector<HTMLElement>('[aria-pressed="true"]:not(:disabled),button:not(:disabled)')?.focus();
    window.addEventListener('resize',position);
    document.addEventListener('scroll',position,true);
    return () => { window.removeEventListener('resize',position); document.removeEventListener('scroll',position,true); };
  }, [editing]);
  async function createTemplate() {
    const available = ws.targets.filter(t => t.installed !== false);
    const plan = ws.defaults.find(key => available.some(t => t.id === key)) ?? available[0]?.id ?? ws.targets[0]?.id;
    const executors = ws.targets.filter(t => t.exec);
    const execution = executors.find(t => t.id === ws.executor && t.installed !== false) ?? executors.find(t => t.installed !== false) ?? executors[0];
    if (!plan || !execution) { notify('请先接入方案模型和支持实施的模型','err'); connect(); return; }
    const names = new Set(Object.values(ws.collaborationGraphs).map(g => g.name));
    let title = '未命名组合';
    for (let n = 2; names.has(title); n++) title = '未命名组合 ' + n;
    const key = 'graph-' + crypto.randomUUID();
    if (await persist(key, { name:title, plans:[{ target:plan }], execution:{ target:execution.id } })) {
      choose(key); setName(title); setNaming('rename');
    }
  }
  function nextRole(excluded: string[]): GraphRole | undefined {
    const candidates = ws.targets.filter(t => !excluded.includes(t.id));
    const target = candidates.find(t => t.installed !== false) ?? candidates[0];
    return target && { target:target.id };
  }
  function addBranch() {
    if (graph.plans.length >= 3) return;
    const ids = graph.plans.map(p => p.target);
    const peer = nextRole(ids);
    if (!peer) { notify('请先接入另一个模型','err'); return; }
    void change({ ...graph, plans:[...graph.plans,peer], merge:graph.merge ?? nextRole([...ids,peer.target]) ?? graph.plans[0] });
  }
  function insert(step: 'check' | 'audit') {
    const excluded = step === 'audit' ? [graph.execution.target] : graph.plans.map(p => p.target);
    void change({ ...graph,[step]:nextRole(excluded) ?? { target:excluded[0] } });
  }
  function updateRole(value: GraphRole) {
    if (!editing) return;
    void change(editing.step === 'plan'
      ? { ...graph, plans:graph.plans.map((p,i) => i === editing.index ? value : p) }
      : { ...graph,[editing.step]:value });
  }
  function removable(step: EditableStep) {
    return step === 'audit' || step === 'check' || step === 'report' || (step === 'plan' && graph.plans.length > 1);
  }
  function remove(selection: Selection) {
    const { step,index } = selection;
    if (!removable(step)) return;
    const layout = graph.layout && structuredClone(graph.layout);
    if (step !== 'plan') {
      if (layout) delete layout.offsets[step];
      void change({ ...graph,[step]:undefined, layout });
      return;
    }
    const plans = graph.plans.filter((_,i) => i !== index);
    if (layout) {
      for (let i = index; i < graph.plans.length; i++) {
        const next = layout.offsets['plan-' + (i + 1)];
        if (next) layout.offsets['plan-' + i] = next;
        else delete layout.offsets['plan-' + i];
      }
      if (plans.length === 1) delete layout.offsets.merge;
    }
    void change({ ...graph, plans, layout, merge:plans.length > 1 ? graph.merge : undefined });
  }
  const [roleLabel,setRoleLabel] = useState('');
  function edit(step: EditableStep,index: number,element: HTMLElement,selected: GraphRole) {
    anchor.current = element; setRoleLabel(selected.label ?? roleNames[step]); setEditing({ step,index,role:selected });
  }
  function node(step: EditableStep, selected: GraphRole, index: number) {
    const target = ws.targets.find(t => t.id === selected.target);
    const unavailable = !target || target.installed === false || (step === 'execution' && !target.exec);
    return <div className="cg-model-position" key={index} data-node={step === 'plan' ? 'plan-' + index : step}>
      <button type="button" data-port={step} className={'cg-node' + (unavailable ? ' missing' : '')} disabled={saving}
      aria-haspopup="dialog" aria-expanded={editing?.step === step && editing.index === index}
      onClick={e => edit(step,index,e.currentTarget,selected)}
      onKeyDown={e => { if (e.key === 'Backspace') { e.preventDefault(); remove({step,index}); } }}>
      <span className="cg-role"><Icon name={symbols[step]} size={14} />{selected.label ?? roleNames[step]}</span>
      <b>{targetLabel(selected.target)}</b>{unavailable && <small>未接入</small>}
      </button>
      {step === 'plan' && index === graph.plans.length - 1 && graph.plans.length < 3 &&
        <button className="cg-branch" disabled={saving} onClick={addBranch}>＋ 并行</button>}
    </div>;
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || (e.target as HTMLElement).closest('input,textarea,[contenteditable]')) return;
      if (history.current.length) { e.preventDefault(); void undo(); }
    };
    document.addEventListener('keydown',listener);
    return () => document.removeEventListener('keydown',listener);
  });
  return <section className="cg-editor page-enter" aria-label="组合模版">
    {Object.keys(ws.collaborationGraphs).length > 0 ? <div className="cg-templates" aria-label="已保存的组合模版">
      {Object.entries(ws.collaborationGraphs).map(([key, value]) =>
        <button key={key} type="button" disabled={saving} aria-pressed={key === id} onClick={() => choose(key)}>{value.name}</button>)}
      <button type="button" disabled={saving} onClick={() => void createTemplate()}><Icon name="plus" size={14}/>新建模版</button>
    </div> : <div className="cg-empty">
      <p>还没有组合模版</p>
      <button type="button" className="btn primary" disabled={saving} onClick={() => void createTemplate()}><Icon name="plus" size={14}/>新建模版</button>
    </div>}
    {graph && <>
      <div className="cg-toolbar">
        <button className="cg-title" title="重命名模版" onClick={() => { setName(graph.name); setNaming('rename'); }}>
          <strong>{graph.name}</strong><Icon name="edit" size={13}/>
        </button>
        <span className="cg-space" />
        <button className="ghost" disabled={saving || !history.current.length} onClick={() => void undo()}>撤销</button>
        <button className="ghost" disabled={saving || !graph.layout} onClick={() => void change({ ...graph, layout:undefined })}>自动排列</button>
        <button className="btn" disabled={saving} onClick={() => { setName(graph.name + ' 副本'); setNaming('copy'); }}>另存为模版</button>
      </div>
      {naming && <form className="cg-name" onSubmit={async e => {
        e.preventDefault();
        const title = name.trim();
        if (!title) return;
        const key = naming === 'copy' ? 'graph-' + crypto.randomUUID() : id;
        if (await persist(key,{ ...graph, name:title })) choose(key);
      }}>
        <input aria-label="模版名称" maxLength={60} value={name} autoFocus onFocus={e => e.target.select()}
          onKeyDown={e => { if (e.key === 'Escape') setNaming(undefined); }} onChange={e => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim() || saving}>保存</button>
        <button className="ghost" type="button" onClick={() => setNaming(undefined)}>取消</button>
      </form>}
      <CombinationCanvas key={id} graph={graph} busy={saving} onInsert={insert} onLayout={layout => persist(id,{ ...graph, layout })}>
        <div className="cg-level end"><span className="cg-terminal" data-node="start" data-port="start" tabIndex={0}>需求</span></div>
        {graphStages(graph).map(step => <div key={step} className={'cg-level ' + step}>
          {step === 'confirm' ? <span className="cg-gate" data-node="confirm" data-port="confirm" tabIndex={0}><Icon name="check" size={14}/>本人确认</span>
            : step === 'plan' ? graph.plans.map((p,i) => node('plan',p,i)) : node(step,graph[step]!,0)}
        </div>)}
        <div className="cg-level end">
          {graph.report ? <span className="cg-terminal" data-node="end" data-port="end" tabIndex={0}>交付</span>
            : <button type="button" className="cg-terminal" data-node="end" data-port="end" disabled={saving}
                aria-haspopup="dialog" aria-expanded={editing?.step === 'report'} aria-label="交付，选择结果汇报模型" title="选择结果汇报模型"
                onClick={e => edit('report', 0, e.currentTarget, { target: graph.plans[0].target })}>交付 ＋</button>}
        </div>
      </CombinationCanvas>
      {issue && <p className="cg-warning"><Icon name="alert" size={14}/>{issue}<button className="link" onClick={connect}>去接入模型</button></p>}
      {saving && <p className="cg-note" role="status">正在保存…</p>}
      {visibleEditing && role && <div ref={menu} popover="auto" role="dialog" aria-label={'编辑' + roleNames[visibleEditing.step]} className="cg-menu"
        inert={menuPresence.state === 'closing'}
        onToggle={e => { if (!e.currentTarget.matches(':popover-open')) setEditing(undefined); }}>
        <form onSubmit={e => { e.preventDefault(); updateRole({ ...role,label:roleLabel.trim() || undefined }); }}>
          <input aria-label="角色名称" maxLength={40} value={roleLabel} onChange={e => setRoleLabel(e.target.value)}/><button className="ghost" title="保存角色名"><Icon name="check" size={14}/></button>
        </form>
        {ws.targets.filter(t => visibleEditing.step !== 'execution' || t.exec).map(t => <button key={t.id} className="cg-choice"
          aria-pressed={t.id === selectedTarget} disabled={t.installed === false || (visibleEditing.step === 'plan' && graph.plans.some((p,i) => i !== visibleEditing.index && p.target === t.id))}
          onClick={() => updateRole({ ...role,target:t.id })}><span>{t.label}<small>{t.id}</small></span>{t.installed === false ? '未接入' : t.id === selectedTarget ? '✓' : ''}</button>)}
        <button className="link" onClick={connect}>去接入模型</button>
        {removable(visibleEditing.step) && (visibleEditing.step !== 'report' || graph.report) && <button className="link" onClick={() => remove(visibleEditing)}>移除此节点</button>}
      </div>}
    </>}
  </section>;
}
