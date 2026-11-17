import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConflictError, deleteMemory, editEntry, listBackups, readBackup, restoreBackup, writeMemory } from './edit.js';
import { effectiveContext, scanMemory } from './scan.js';
import type { MemoryContext } from './types.js';

export interface MemoryServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const page = () => readFileSync(new URL('../../assets/memory.html', import.meta.url), 'utf8');

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > 4 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象');
  return value;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`缺少参数 ${name}`);
  return v;
};
const optional = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A local, single-user server for the memory manager. It listens on loopback
 * only, and every API call must carry the random token from the printed URL
 * and a loopback Host header, so neither another site (CSRF, DNS rebinding)
 * nor another local user who merely knows the port can read or write memory.
 */
export async function startMemoryServer(ctx: MemoryContext, port = 0): Promise<MemoryServer> {
  const token = randomBytes(18).toString('base64url');
  const expected = Buffer.from(token);
  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers['x-unify-token'] ?? ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const api = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') return scanMemory(ctx);
    if (route === 'GET /api/effective') return { text: effectiveContext(scanMemory(ctx), str(url.searchParams.get('harness'), 'harness')) };
    if (route === 'GET /api/backups') return { backups: listBackups(ctx, url.searchParams.get('path') ?? undefined) };
    if (route === 'GET /api/backup') return readBackup(ctx, str(url.searchParams.get('id'), 'id'));
    if (req.method !== 'POST') throw Object.assign(new Error('未找到'), { status: 404 });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('需要 application/json'), { status: 415 });
    const b = await body(req);
    if (route === 'POST /api/file') return writeMemory(ctx, str(b.path, 'path'), str(b.content, 'content'), optional(b.baseHash));
    if (route === 'POST /api/delete') return deleteMemory(ctx, str(b.path, 'path'), optional(b.baseHash)), {};
    if (route === 'POST /api/entry') {
      if (!['update', 'delete', 'add', 'copy', 'move'].includes(b.op)) throw new Error('未知操作');
      const num = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);
      editEntry(ctx, { op: b.op, path: str(b.path, 'path'), baseHash: optional(b.baseHash), start: num(b.start), end: num(b.end), text: optional(b.text), heading: optional(b.heading), to: optional(b.to) });
      return {};
    }
    if (route === 'POST /api/restore') return restoreBackup(ctx, str(b.id, 'id'));
    throw Object.assign(new Error('未找到'), { status: 404 });
  };

  const server: Server = createServer((req, res) => {
    const send = (status: number, type: string, data: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(data);
    };
    void (async () => {
      const { port: bound } = server.address() as AddressInfo;
      if (![`127.0.0.1:${bound}`, `localhost:${bound}`].includes(req.headers.host ?? '')) return send(403, 'text/plain', 'forbidden');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${bound}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', page());
        return send(404, 'text/plain', 'not found');
      }
      if (!authorized(req)) return send(401, 'application/json', JSON.stringify({ error: '令牌无效，请使用 unify memory 打印的完整链接' }));
      try {
        send(200, 'application/json', JSON.stringify(await api(req, url)));
      } catch (err) {
        const status = err instanceof ConflictError ? 409 : (err as { status?: number }).status ?? 400;
        send(status, 'application/json', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })().catch(() => { if (!res.headersSent) send(500, 'text/plain', 'error'); });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}/#${token}`,
    port: bound,
    token,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
