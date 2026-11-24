import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = () => reducedMotion.matches;

function subscribe(listener: () => void) {
  reducedMotion.addEventListener('change', listener);
  return () => reducedMotion.removeEventListener('change', listener);
}

export function usePresence<T>(value: T | undefined, exitMs = 180) {
  const reduced = useSyncExternalStore(subscribe, prefersReducedMotion);
  const [last, setLast] = useState(() => value);

  useLayoutEffect(() => {
    if (value !== undefined || reduced) {
      if (!Object.is(value, last)) setLast(() => value);
    } else if (last !== undefined) {
      const timer = window.setTimeout(() => setLast(undefined), exitMs);
      return () => window.clearTimeout(timer);
    }
  }, [value, last, exitMs, reduced]);

  return {
    rendered: value !== undefined ? value : reduced ? undefined : last,
    state: value === undefined ? 'closing' as const : 'open' as const,
  };
}

// Closing a native dialog releases focus immediately while CSS finishes the exit.
export function useAnimatedDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return ref;
}

export function tweenFrame(durationMs: number, onFrame: (progress: number) => void, onDone?: () => void) {
  const start = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const progress = prefersReducedMotion() ? 1 : Math.min(1, Math.max(0, (now - start) / durationMs));
    onFrame(1 - (1 - progress) ** 3);
    if (progress < 1) frame = requestAnimationFrame(tick);
    else onDone?.();
  };
  if (prefersReducedMotion()) tick(start);
  else frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
