import type { Bridge, Method, Push, UnifyApi } from '../shared/api.js';

const bridge = (window as unknown as { unifyBridge: Bridge }).unifyBridge;

/** A typed client: every main-process method, with errors rethrown as plain Errors. */
export const unify = new Proxy({} as UnifyApi, {
  get: (_, method: string) => async (...args: unknown[]) => {
    const reply = await bridge.invoke(method as Method, ...args);
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  },
});

export const onPush = (listener: (push: Push) => void) => bridge.onPush(listener);
