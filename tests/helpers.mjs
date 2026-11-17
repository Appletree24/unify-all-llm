import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function workspace(t) {
  const path = mkdtempSync(join(tmpdir(), 'unify-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export function target(id, run, capabilities = { askPolicy: 'text-only', exec: false }) {
  return { id, label: id.toUpperCase(), adapter: {
    id, label: id.toUpperCase(), capabilities, detect: async () => ({ installed: true }), run,
  } };
}

export const options = (cwd, extra = {}) => ({ cwd, prompt: 'question', mode: 'ask', timeoutMs: 2000, ...extra });
export const aborted = (signal) => signal.aborted ? Promise.resolve() : new Promise((r) => signal.addEventListener('abort', r, { once: true }));
