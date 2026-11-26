import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';
import { isReviewOrReport } from '../core/collaboration.js';
import { advisorText } from '../core/advisor.js';
import { routingNotice, supplementActions, type SupplementAction } from '../core/routing.js';
import { readSessionSettings, runningStatus } from '../core/sessions.js';
import type { RunRecord } from '../core/store.js';
import { synthesisFormatter } from '../core/synth.js';
import { SESSION_TITLE_LIMIT } from '../core/types.js';
import type { WorkflowHandle } from '../core/workflow.js';
import type { MobileAnswer, MobileNetwork, MobileShareInfo, MobileTurn, MobileUpdate } from './types.js';

type TurnControls = Pick<WorkflowHandle, 'waitingForInput' | 'cancel'>;

interface SessionHost {
  cwd: string;
  session(id: string): RunRecord[];
  liveTurn(turnId: string): TurnControls | undefined;
  ask(question: string, parent: string, signal: AbortSignal): string | Promise<string>;
  supplement(turnId: string, action: SupplementAction, signal: AbortSignal): string | Promise<string>;
}

export function mobileNetworks(): MobileNetwork[] {
  const networks: MobileNetwork[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const { family, internal, address } of entries ?? []) {
      if (family !== 'IPv4' || internal) continue;
      const [a, b] = address.split('.').map(Number);
      if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
          (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)) networks.push({ name, address });
    }
  }
  return networks;
}

function publicTurn(run: RunRecord, controls?: TurnControls): MobileTurn {
  const answers: MobileAnswer[] = [];
  const add = (result: RunRecord['results'][number], label: string, text = result.text) => {
    answers.push({ id: result.runId, label, text, status: result.status, error: result.error });
  };
  for (const result of run.results) {
    const target = run.targets.find(t => t.id === result.targetId);
    add(result, (run.kind === 'execution' ? '实施 · ' : '') + (target?.label ?? result.targetId));
  }
  if (run.synthesis) add(run.synthesis.result, '汇总', synthesisFormatter(run)(run.synthesis.result.text));
  for (const call of run.calls) {
    if (isReviewOrReport(call.scope)) {
      const label = { 'plan-review': '方案复核', 'result-review': '实施复核', report: '结果汇报' }[call.scope];
      add(call.result, label + ' · ' + call.target.label);
    }
  }
  const busy = runningStatus(run.status);
  return {
    id: run.id, question: run.question, answers, status: run.status, busy, error: run.error,
    canCancel: busy && !!controls, waitingForInput: controls?.waitingForInput ?? false,
    routing: run.routing && routingNotice(run.routing), advisor: run.advisor && advisorText(run.advisor), actions: supplementActions(run),
  };
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readQuestion(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('消息太长，请缩短后再发送');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof data?.question !== 'string' || !data.question.trim() || typeof data.parent !== 'string' || !data.parent) {
    throw new Error('请输入追问并等待会话同步');
  }
  return { question: data.question.trim(), parent: data.parent as string };
}

/** Each listener and its bearer link belong to exactly one conversation. */
export class MobileShare {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly lifetime = new AbortController();
  private readonly turns = new Map<string, { revision: number; run: RunRecord }>();
  private readonly waiters = new Set<() => void>();
  private revision = 1;
  private fullRevision = 1;
  private lastDiskRead = 0;
  private flushTimer?: NodeJS.Timeout;
  private host = '';
  private lastSubmission?: { parent: string; question: string; turnId: string };
  private title: string;
  private readonly files: Map<string, { type: string; body: Buffer }>;
  private readonly server = createServer((req, res) => {
    void this.route(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) json(res, 500, { error: '电脑读取会话失败' });
    });
  });

  constructor(readonly ws: SessionHost, readonly id: string, assetDir: string) {
    const runs = ws.session(id);
    if (!runs.length) throw new Error('找不到可以共享的会话');
    for (const run of runs) this.turns.set(run.id, { revision: 1, run });
    this.title = readSessionSettings(ws.cwd, runs[0]).title ?? runs[0].question.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_LIMIT);
    this.files = new Map();
    for (const [path, name, type] of [
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/mobile.js', 'mobile.js', 'text/javascript; charset=utf-8'],
      ['/mobile.css', 'mobile.css', 'text/css; charset=utf-8'],
    ]) this.files.set(path, { type, body: readFileSync(join(assetDir, name)) });
  }

  async listen(address: string) {
    if (!mobileNetworks().some(n => n.address === address)) throw new Error('请选择电脑当前使用的局域网或 VPN 地址');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: address, port: 0, signal: this.lifetime.signal }, () => {
        this.server.off('error', reject);
        resolve();
      });
      this.server.once('close', () => reject(new Error('共享已停止')));
    });
    const bound = this.server.address();
    if (!bound || typeof bound === 'string') throw new Error('共享未能启动');
    this.host = address + ':' + bound.port;
    return this.info();
  }

  info(): MobileShareInfo {
    return { cwd: this.ws.cwd, sessionId: this.id, title: this.title, url: 'http://' + this.host + '/#' + this.token };
  }

  get ready() { return !!this.host; }

  update(run: RunRecord) {
    if (run.sessionId !== this.id) return;
    this.turns.set(run.id, { revision: ++this.revision, run });
    // Coalesce token bursts across models and send only the changed turns.
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      this.wake();
    }, 180);
  }

  rename(title: string) {
    this.title = title;
    this.revision++;
    this.wake();
  }

  private wake() {
    for (const send of this.waiters) send();
  }

  // Reconcile writes from other processes on reconnect and idle heartbeats.
  private refreshHistory() {
    const runs = this.ws.session(this.id);
    const present = new Set(runs.map(run => run.id));
    for (const id of this.turns.keys()) {
      if (!present.has(id)) { this.turns.delete(id); this.fullRevision = ++this.revision; }
    }
    for (const run of runs) {
      const saved = this.turns.get(run.id)?.run;
      if (!saved || saved.updatedAt !== run.updatedAt || saved.status !== run.status) {
        this.turns.set(run.id, { revision: ++this.revision, run });
      }
    }
    this.lastDiskRead = Date.now();
  }

  close() {
    this.lifetime.abort();
    clearTimeout(this.flushTimer);
    this.wake();
    this.server.close();
  }

  private updates(after: number, res: ServerResponse) {
    const send = () => {
      this.waiters.delete(send);
      clearTimeout(timer);
      if (this.lifetime.signal.aborted) return json(res, 410, { error: '电脑已停止共享' });
      if (after === 0 || Date.now() - this.lastDiskRead > 20_000) {
        try { this.refreshHistory(); }
        catch { return json(res, 503, { error: '暂时无法读取项目目录' }); }
      }
      const full = after < this.fullRevision || after > this.revision;
      const turns = Array.from(this.turns.values()).filter(t => full || t.revision > after)
        .map(t => publicTurn(t.run, this.ws.liveTurn(t.run.id)));
      const message: MobileUpdate = { revision: this.revision, project: basename(this.ws.cwd), title: this.title, full, turns };
      json(res, 200, message);
    };
    const timer = setTimeout(send, 20_000);
    if (after !== this.revision) return send();
    this.waiters.add(send);
    res.once('close', () => { clearTimeout(timer); this.waiters.delete(send); });
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (this.lifetime.signal.aborted) return json(res, 410, { error: '电脑已停止共享' });
    if (!this.host || req.headers.host !== this.host || (req.headers.origin && req.headers.origin !== 'http://' + this.host)) {
      return json(res, 403, { error: '请用电脑提供的地址连接' });
    }
    const url = new URL(req.url ?? '/', 'http://' + this.host);
    const file = req.method === 'GET' && this.files.get(url.pathname);
    if (file) { res.writeHead(200, { 'Content-Type': file.type }); res.end(file.body); return; }
    if (req.headers.authorization !== 'Bearer ' + this.token) return json(res, 401, { error: '请重新扫描电脑上的共享二维码' });
    if (req.method === 'GET' && url.pathname === '/updates') {
      const after = Number(url.searchParams.get('after'));
      return this.updates(Number.isSafeInteger(after) ? after : 0, res);
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const run = this.turns.get(url.searchParams.get('turnId') ?? '')?.run;
      if (!run) return json(res, 404, { error: '共享会话中找不到这一轮' });
      if (runningStatus(run.status)) {
        const controls = this.ws.liveTurn(run.id);
        if (!controls) return json(res, 409, { error: '请在启动本轮的终端或桌面窗口取消' });
        controls.cancel();
      }
      return json(res, 200, { turnId: run.id });
    }
    if (req.method === 'POST' && url.pathname === '/supplement') {
      const run = this.turns.get(url.searchParams.get('turnId') ?? '')?.run;
      if (!run) return json(res, 404, { error: '共享会话中找不到这一轮' });
      const action = url.searchParams.get('action');
      if ((action !== 'opinion' && action !== 'synthesis') || !supplementActions(run).includes(action)) {
        return json(res, 409, { error: '该轮没有可追加的操作' });
      }
      try {
        this.lifetime.signal.throwIfAborted();
        return json(res, 200, { turnId: await this.ws.supplement(run.id, action, this.lifetime.signal) });
      } catch (err) {
        return json(res, 409, { error: err instanceof Error ? err.message : '追加操作失败' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/ask') {
      let input;
      try { input = await readQuestion(req); }
      catch { return json(res, 400, { error: '消息无效或太长，请重新输入' }); }
      if (this.lastSubmission?.parent === input.parent && this.lastSubmission.question === input.question) {
        return json(res, 200, { turnId: this.lastSubmission.turnId });
      }
      try {
        this.lifetime.signal.throwIfAborted();
        const turnId = await this.ws.ask(input.question, input.parent, this.lifetime.signal);
        this.lastSubmission = { ...input, turnId };
        return json(res, 200, { turnId });
      } catch (err) {
        return json(res, 409, { error: err instanceof Error ? err.message : '追问失败' });
      }
    }
    json(res, 404, { error: '找不到该页面' });
  }
}
