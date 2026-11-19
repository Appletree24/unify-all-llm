import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
