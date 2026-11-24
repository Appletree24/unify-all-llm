import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { roleNames, type Collaboration, type GraphLayout } from '../../../src/core/collaboration.js';
import { prefersReducedMotion, tweenFrame } from './motion.js';
import { Icon } from './ui.js';

type Point = GraphLayout['pan'];
type Wire = { path: string; middle: Point; insert?: 'check' | 'audit' };
type Gesture = {
  pointer: number;
  origin: Point;
  node?: string;
  element?: HTMLElement;
  before: GraphLayout;
  moved: boolean;
};
const zero = { x: 0, y: 0 };
const automatic: GraphLayout = { offsets: {}, pan: zero };
const translate = ({ x, y }: Point) => `translate(${x}px, ${y}px)`;
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const mixPoint = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function sameLayout(a: GraphLayout, b: GraphLayout) {
  return samePoint(a.pan, b.pan)
    && Object.keys(a.offsets).every(key => samePoint(a.offsets[key], b.offsets[key] ?? zero))
    && Object.keys(b.offsets).every(key => samePoint(b.offsets[key], a.offsets[key] ?? zero));
}

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
  const currentGraph = useRef(graph);
  const gesture = useRef<Gesture | undefined>(undefined);
  const layout = useRef(graph.layout ?? automatic);
  const saved = useRef(layout.current);
  const suppressClick = useRef(false);
  const tween = useRef<() => void>(undefined);
  const [wires, setWires] = useState<Wire[]>([]);
  const [highlightedWire, setHighlightedWire] = useState<number>();
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
        if (to.id === 'confirm' && !currentGraph.current.check) wire.insert = 'check';
        if (to.id === 'end' && !currentGraph.current.audit) wire.insert = 'audit';
        next.push(wire);
      }
    }
    setWires(next);
  }
  useLayoutEffect(() => () => tween.current?.(), []);
  useLayoutEffect(() => {
    currentGraph.current = graph;
    const next = graph.layout ?? automatic;
    const changed = !sameLayout(saved.current, next);
    saved.current = next;
    if (changed && !gesture.current?.moved) {
      tween.current?.();
      tween.current = undefined;
      const before = layout.current;
      if (prefersReducedMotion() || sameLayout(before, next)) {
        layout.current = next;
      } else {
        const keys = new Set([...Object.keys(before.offsets), ...Object.keys(next.offsets)]);
        tween.current = tweenFrame(280, t => {
          layout.current = t === 1 ? next : {
            pan: mixPoint(before.pan, next.pan, t),
            offsets: Object.fromEntries([...keys].map(key => [key, mixPoint(before.offsets[key] ?? zero, next.offsets[key] ?? zero, t)])),
          };
          // The paths use the node positions measured in this frame.
          flushSync(draw);
        }, () => { tween.current = undefined; });
      }
    }
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
    const element = port?.closest<HTMLElement>('[data-node]') ?? undefined;
    gesture.current = {
      pointer: event.pointerId, origin: { x: event.clientX, y: event.clientY },
      node: element?.dataset.node, element, before: layout.current, moved: false,
    };
    // Keep a short click on its original node so normal mouse and keyboard activation both work.
    (port ?? event.currentTarget).setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.origin.x, dy = event.clientY - drag.origin.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      tween.current?.();
      tween.current = undefined;
      drag.before = layout.current;
      drag.moved = true;
      suppressClick.current = true;
      event.currentTarget.classList.add('dragging');
      drag.element?.setAttribute('data-dragging', 'true');
    }
    flushSync(() => move(drag.before, drag.node, dx, dy));
  }
  function finish(cancelled: boolean) {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = undefined;
    frame.current?.classList.remove('dragging');
    drag.element?.removeAttribute('data-dragging');
    if (!drag.moved) return;
    if (cancelled) { layout.current = saved.current; draw(); }
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
      if (gesture.current) return;
      tween.current?.();
      tween.current = undefined;
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
        {wires.map((wire, i) => <path key={i} d={wire.path} fill="none" stroke="currentColor"
          data-highlighted={highlightedWire === i || undefined} markerEnd={`url(#${marker})`} />)}
      </svg>
      {wires.map((wire, i) => wire.insert && <button key={i} type="button" className="cg-joint" disabled={busy} style={{ left: wire.middle.x, top: wire.middle.y }}
        onPointerEnter={() => setHighlightedWire(i)} onPointerLeave={() => setHighlightedWire(undefined)}
        onFocus={() => setHighlightedWire(i)} onBlur={() => setHighlightedWire(undefined)}
        aria-label={'插入' + roleNames[wire.insert]} title={'插入' + roleNames[wire.insert]} onClick={() => onInsert(wire.insert!)}><Icon name="plus" size={13} /></button>)}
    </div>
  </div>;
}
