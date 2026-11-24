import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { roleNames, type Collaboration, type GraphLayout } from '../../../src/core/collaboration.js';
import { Icon } from './ui.js';

type Point = GraphLayout['pan'];
type Wire = { path: string; middle: Point; insert?: 'check' | 'audit' };
type Gesture = {
  pointer: number;
  origin: Point;
  node?: string;
  before: GraphLayout;
  moved: boolean;
};
const zero = { x: 0, y: 0 };
const automatic: GraphLayout = { offsets: {}, pan: zero };
const translate = ({ x, y }: Point) => `translate(${x}px, ${y}px)`;

/** Attach to the facing edges, including after a node has been dragged past its neighbour. */
function wireBetween(a: DOMRect, b: DOMRect, canvas: DOMRect): Wire {
  const aCenter = { x: a.left + a.width / 2 - canvas.left, y: a.top + a.height / 2 - canvas.top };
  const bCenter = { x: b.left + b.width / 2 - canvas.left, y: b.top + b.height / 2 - canvas.top };
  const dx = bCenter.x - aCenter.x, dy = bCenter.y - aCenter.y;
  const horizontal = Math.abs(dx) / (a.width + b.width) >= Math.abs(dy) / (a.height + b.height);
  if (horizontal) {
    aCenter.x += Math.sign(dx) * a.width / 2;
    bCenter.x -= Math.sign(dx) * (b.width / 2 + 2);
  } else {
    aCenter.y += Math.sign(dy) * a.height / 2;
    bCenter.y -= Math.sign(dy) * (b.height / 2 + 2);
  }
  const middle = { x: (aCenter.x + bCenter.x) / 2, y: (aCenter.y + bCenter.y) / 2 };
  const controls = horizontal ? `${middle.x} ${aCenter.y},${middle.x} ${bCenter.y}` : `${aCenter.x} ${middle.y},${bCenter.x} ${middle.y}`;
  return { path: `M${aCenter.x} ${aCenter.y} C${controls},${bCenter.x} ${bCenter.y}`, middle };
}

export function CombinationCanvas({ graph, busy, onLayout, onInsert, children }: {
  graph: Collaboration;
  busy: boolean;
  onLayout(layout: GraphLayout): Promise<boolean>;
  onInsert(step: 'check' | 'audit'): void;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const layout = useRef(graph.layout ?? automatic);
  const saved = useRef(layout.current);
  const suppressClick = useRef(false);
  const [wires, setWires] = useState<Wire[]>([]);
  const marker = useId();

  function draw() {
    const el = canvas.current;
    if (!el || !frame.current) return;
    const { offsets, pan } = layout.current;
    el.style.transform = translate(pan);
    frame.current.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
    for (const node of el.querySelectorAll<HTMLElement>('[data-node]')) {
      node.style.transform = translate(offsets[node.dataset.node!] ?? zero);
    }
    const box = el.getBoundingClientRect();
    const levels = [...el.querySelectorAll('.cg-level')].map(level =>
      [...level.querySelectorAll<HTMLElement>('[data-port]')].map(port => ({ id: port.dataset.port, rect: port.getBoundingClientRect() })));
    const next: Wire[] = [];
    for (let i = 1; i < levels.length; i++) {
      for (const from of levels[i - 1]) for (const to of levels[i]) {
        const wire = wireBetween(from.rect, to.rect, box);
        if (to.id === 'confirm' && !graph.check) wire.insert = 'check';
        if (to.id === 'end' && !graph.audit) wire.insert = 'audit';
        next.push(wire);
      }
    }
    setWires(next);
  }
  useLayoutEffect(() => {
    saved.current = graph.layout ?? automatic;
    if (!gesture.current) layout.current = saved.current;
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas.current!);
    for (const port of canvas.current!.querySelectorAll('[data-port]')) observer.observe(port);
    return () => observer.disconnect();
  }, [graph]);

  function move(before: GraphLayout, node: string | undefined, dx: number, dy: number) {
    const origin = node ? before.offsets[node] ?? zero : before.pan;
    const point = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
    layout.current = node
      ? { ...before, offsets: { ...before.offsets, [node]: point } }
      : { ...before, pan: point };
    draw();
  }
  async function commit() {
    if (!await onLayout(layout.current)) {
      layout.current = saved.current;
      draw();
    }
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || busy || gesture.current) return;
    suppressClick.current = false;
    const target = event.target as HTMLElement;
    const port = target.closest<HTMLElement>('[data-port]');
    if (!port && target.closest('button')) return;
    gesture.current = {
      pointer: event.pointerId, origin: { x: event.clientX, y: event.clientY },
      node: port?.closest<HTMLElement>('[data-node]')?.dataset.node, before: layout.current, moved: false,
    };
    // Keep a short click on its original node so normal mouse and keyboard activation both work.
    (port ?? event.currentTarget).setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.origin.x, dy = event.clientY - drag.origin.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    suppressClick.current = true;
    event.currentTarget.classList.add('dragging');
    move(drag.before, drag.node, dx, dy);
  }
  function finish(cancelled: boolean) {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = undefined;
    frame.current?.classList.remove('dragging');
    if (!drag.moved) return;
    if (cancelled) { layout.current = drag.before; draw(); }
    else void commit();
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { finish(true); return; }
    const directions: Record<string, Point> = {
      ArrowLeft: { x: -12, y: 0 }, ArrowRight: { x: 12, y: 0 }, ArrowUp: { x: 0, y: -12 }, ArrowDown: { x: 0, y: 12 },
    };
    const delta = directions[event.key];
    if (!delta || busy) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    if (event.shiftKey) {
      move(layout.current, target.closest<HTMLElement>('[data-node]')?.dataset.node, delta.x, delta.y);
      void commit();
    } else {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')];
      const at = items.indexOf(target);
      if (at >= 0) items[(at + Math.sign(delta.x || delta.y) + items.length) % items.length]?.focus();
    }
  }
  return <div className="cg-frame" ref={frame} role="group" aria-label="组合模版画布"
    onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={event => { if (gesture.current?.pointer === event.pointerId) { pointerMove(event); finish(false); } }}
    onPointerCancel={event => { if (gesture.current?.pointer === event.pointerId) finish(true); }}
    onLostPointerCapture={event => { if (gesture.current?.pointer === event.pointerId) finish(true); }}
    onClickCapture={event => {
      if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
    }}
    onKeyDown={keyboard}>
    <div className="cg-canvas" ref={canvas}>
      {children}
      <svg aria-hidden="true" className="cg-wires"><defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 7 4 1 7" fill="none" stroke="currentColor" /></marker></defs>
        {wires.map((wire, i) => <path key={i} d={wire.path} fill="none" stroke="currentColor" markerEnd={`url(#${marker})`} />)}
      </svg>
      {wires.map((wire, i) => wire.insert && <button key={i} type="button" className="cg-joint" disabled={busy} style={{ left: wire.middle.x, top: wire.middle.y }}
        aria-label={'插入' + roleNames[wire.insert]} title={'插入' + roleNames[wire.insert]} onClick={() => onInsert(wire.insert!)}><Icon name="plus" size={13} /></button>)}
    </div>
  </div>;
}
