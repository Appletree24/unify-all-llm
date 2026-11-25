import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { MobileAnswer, MobileTurn, MobileUpdate } from '../src/mobile/types.js';
import './mobile.css';

function readLink() {
  const fromLink = location.hash.slice(1);
  if (fromLink) {
    sessionStorage.setItem('unify-share', fromLink);
    history.replaceState(null, '', location.pathname);
  }
  return fromLink || sessionStorage.getItem('unify-share');
}
const token = readLink();
const headers = { Authorization: 'Bearer ' + (token ?? '') };
const draftKey = 'unify-draft-' + token;

async function postTurn(path: string, body?: string) {
  const ctl = new AbortController();
  const timeout = window.setTimeout(() => ctl.abort(), 35_000);
  try {
    const res = await fetch(path, {
      method: 'POST', headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body, signal: ctl.signal,
    });
    return { ok: res.ok, result: await res.json() };
  } finally { clearTimeout(timeout); }
}

const turnStatus: Record<MobileTurn['status'], string> = {
  created: '准备中', deciding: '选择模型', answering: '回答中', synthesizing: '汇总中',
  completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
const answerStatus: Record<MobileAnswer['status'], string> = {
  running: '生成中', succeeded: '完成', failed: '失败', cancelled: '已取消', timed_out: '超时', interrupted: '已中断',
};

function useConversation() {
  const [turns, setTurns] = useState<MobileTurn[]>([]);
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const [online, setOnline] = useState(false);
  const [ended, setEnded] = useState(token ? '' : '请扫描电脑上的共享二维码');
  useEffect(() => {
    if (!token) return;
    let revision = 0;
    let active: AbortController | undefined;
    let retry: number | undefined;
    let finished = false;
    async function poll() {
      if (finished || document.hidden) return;
      const ctl = new AbortController();
      active = ctl;
      const timeout = window.setTimeout(() => ctl.abort(), 35_000);
      let delay = 0;
      try {
        const res = await fetch('/updates?after=' + revision, { headers, signal: ctl.signal });
        if (res.status === 401 || res.status === 410) {
          finished = true;
          setOnline(false);
          setEnded(res.status === 410 ? '电脑已停止共享' : '请重新扫描电脑上的共享二维码');
          setTurns([]);
          return;
        }
        if (!res.ok) throw new Error();
        const data: MobileUpdate = await res.json();
        if (active !== ctl) return;
        if (data.full || data.turns.length) setTurns(previous => {
          const byId = new Map((data.full ? [] : previous).map(t => [t.id, t]));
          for (const turn of data.turns) byId.set(turn.id, turn);
          return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
        });
        setTitle(data.title);
        setProject(data.project);
        setOnline(true);
        revision = data.revision;
      } catch {
        if (active !== ctl) return;
        revision = 0;
        setOnline(false);
        delay = 2000;
      } finally {
        clearTimeout(timeout);
        if (active === ctl && !finished) retry = window.setTimeout(poll, delay);
      }
    }
    function resume() {
      const prev = active;
      active = undefined;
      prev?.abort();
      clearTimeout(retry);
      revision = 0;
      if (!finished) { setOnline(false); void poll(); }
    }
    void poll();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      finished = true;
      resume();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, []);
  return { turns, title, project, online, ended };
}

const Answer = memo(function Answer({ answer }: { answer: MobileAnswer }) {
  const html = useMemo(() => answer.status === 'running' ? '' : DOMPurify.sanitize(marked.parse(answer.text, { async: false }), {
    ALLOWED_TAGS: ['p','br','strong','em','del','ul','ol','li','blockquote','pre','code','a','h1','h2','h3','h4','hr','table','thead','tbody','tr','td','th'],
    ALLOWED_ATTR: ['href','start'],
  }), [answer.status, answer.text]);
  return <section className="answer">
    <header><h3>{answer.label}</h3>{answer.status !== 'succeeded' && <small>{answerStatus[answer.status]}</small>}</header>
    {html ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="plain">{answer.text}</div>}
    {answer.error && <p className="error">{answer.error}</p>}
  </section>;
});

const Turn = memo(function Turn({ turn }: { turn: MobileTurn }) {
  return <article>
    <header className="question-head"><small>你</small><small>{turn.waitingForInput ? '等待电脑端确认' : turnStatus[turn.status]}</small></header>
    <h2>{turn.question}</h2>
    {turn.answers.map(a => <Answer key={a.id} answer={a} />)}
    {turn.error && <p className="error">{turn.error}</p>}
  </article>;
});

function App() {
  const { turns, title, project, online, ended } = useConversation();
  const list = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const [draft, setDraft] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const [ack, setAck] = useState('');
  const [cancellation, setCancellation] = useState<{ turnId: string; error?: string }>();
  const [error, setError] = useState('');
  const pending = useRef<{ question: string; parent: string } | undefined>(undefined);
  const latest = turns[turns.length - 1];
  const awaitingTurn = ack && !turns.some(t => t.id === ack) ? ack : undefined;
  const busy = turns.some(t => t.busy) || !!awaitingTurn;
  const cancelId = awaitingTurn ?? turns.find(t => t.canCancel)?.id;
  const cancelRequest = cancellation?.turnId === cancelId ? cancellation : undefined;
  const stopping = !!cancelRequest && !cancelRequest.error;
  const alert = cancelRequest?.error || error;
  useEffect(() => {
    if (ack && !awaitingTurn) setAck('');
  }, [ack, awaitingTurn]);
  useLayoutEffect(() => {
    if (list.current && follow.current) list.current.scrollTop = list.current.scrollHeight;
  }, [turns]);
  function changeDraft(value: string) {
    setDraft(value);
    sessionStorage.setItem(draftKey, value);
    setError('');
  }
  async function send() {
    const question = draft.trim();
    if (!latest || !question || busy || !online || sending) return;
    const body = pending.current?.question === question ? pending.current : { question, parent: latest.id };
    pending.current = body;
    setSending(true);
    setError('');
    try {
      const { ok, result } = await postTurn('/ask', JSON.stringify(body));
      if (!ok) { pending.current = undefined; throw new Error(result.error || '发送失败'); }
      pending.current = undefined;
      follow.current = true;
      setAck(result.turnId);
      changeDraft('');
      list.current?.scrollTo(0, list.current.scrollHeight);
    } catch (err) {
      setError(pending.current ? '暂未收到电脑确认，可以重试这条追问' : err instanceof Error ? err.message : '发送失败');
    } finally { setSending(false); }
  }
  async function cancel(turnId: string) {
    setCancellation({ turnId });
    setError('');
    let failure: string;
    try {
      const { ok, result } = await postTurn('/cancel?turnId=' + encodeURIComponent(turnId));
      if (ok) return;
      failure = result.error || '取消失败，请重试';
    } catch {
      failure = '暂未收到电脑确认，请重试取消';
    }
    setCancellation(current => current?.turnId === turnId ? { turnId, error: failure } : current);
  }
  return <>
    <header className="bar"><b>Unify</b><span>{project}</span><small role="status" className={online ? 'live' : ''}>{ended ? '共享不可用' : online ? '已连接' : '正在连接电脑'}</small></header>
    <main ref={list} onScroll={() => {
      const el = list.current!;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    }}>
      <div className="thread">
        <h1>{ended || title || '共享会话'}</h1>
        {!ended && turns.map(turn => <Turn key={turn.id} turn={turn} />)}
        {!ended && !online && <p className="connection">请保持电脑在线，并确认手机可访问共享地址。若已重新开启共享，请扫描新的二维码。</p>}
      </div>
    </main>
    {!ended && <footer><form onSubmit={event => { event.preventDefault(); void send(); }}>
      {alert && <p role="alert" className="error">{alert}</p>}
      <label htmlFor="draft">{busy ? '本轮生成结束后可继续追问' : '继续对话'}</label>
      <div className="composer"><textarea id="draft" rows={2} value={draft} onChange={e => changeDraft(e.target.value)} readOnly={sending} placeholder="输入追问…" />
        {cancelId ? <button type="button" className="cancel-turn" disabled={!online || stopping}
          onClick={() => void cancel(cancelId)}>{stopping ? '取消中…' : '取消本轮'}</button>
          : <button type="submit" disabled={!online || !latest || busy || sending || !draft.trim()}>{sending ? '发送中' : '发送'}</button>}</div>
    </form></footer>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
