import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';
import type { ModelTarget, NativeSession, RunRequest } from './types.js';

export interface NativeConversation {
  request: NonNullable<RunRequest['conversation']>;
  save(session: NativeSession): void;
}

/** A provider thread is mutable. Only one child of a completed answer may advance it.
 * Keep the handles local to this machine. Copied project records use public replay. */
export function nativeConversation(
  cwd: string, home: string | undefined, target: ModelTarget, session: string,
  callId: string, turnPrompt: string, parentCallId?: string, forkOnly = false,
): NativeConversation {
  const dir = join(home ?? homedir(), '.unify', 'provider-sessions');
  const identity = [realpathSync(cwd), session, target.id, target.adapter.id, target.model, target.reasoningEffort];
  const file = (id: string) => join(dir, createHash('sha256').update(JSON.stringify([...identity, id])).digest('hex'));
  const request: NativeConversation['request'] = { turnPrompt };
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][\w-]{0,255}$/.test(id);
  if (parentCallId) {
    try {
      const path = file(parentCallId);
      const saved: NativeSession = JSON.parse(readFileSync(path, 'utf8'));
      if (validId(saved.id) && (!forkOnly || saved.forkable)) {
        if (forkOnly || (saved.forkable && !saved.turnId)) {
          // Without a turn anchor every child forks, keeping this parent immutable.
          request.fork = true;
        } else {
          try { writeFileSync(path + '.continued', '', { flag: 'wx', mode: 0o600 }); }
          catch (err) {
            if (!saved.forkable || !validId(saved.turnId)) throw err;
            request.fork = true;
          }
        }
        request.resumeId = saved.id;
        request.turnId = saved.turnId;
      }
    } catch { /* Missing, unavailable, or claimed by another branch: use the full public prompt. */ }
  }
  return {
    request,
    save(checkpoint) {
      if (!validId(checkpoint.id) || (checkpoint.turnId !== undefined && !validId(checkpoint.turnId))) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        atomicWrite(file(callId), JSON.stringify(checkpoint));
      } catch { /* A read-only home still supports public replay. */ }
    },
  };
}
