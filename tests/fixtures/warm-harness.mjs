import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [provider, ...args] = process.argv.slice(2);
const pid = process.pid;
const log = data => appendFileSync('harness.jsonl', JSON.stringify({ pid, provider, ...data }) + '\n');
const send = message => console.log(JSON.stringify(message));
log({ started: true, args });
let seq = 0;
const turns = new Map();
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const { id, method, params, type, message } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method) log({ method });
  if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (method === 'config/read') reply({ config: { model: 'pro' } });
  if (method === 'model/list') reply({ data: [{ model: 'pro', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }] });
  if (method === 'thread/start' || method === 'thread/fork') {
    reply({ thread: { id: 'thread-' + ++seq, turns: params.lastTurnId ? [{ id: params.lastTurnId }] : [] } });
  }
  if (method === 'thread/resume') reply({ thread: { id: params.threadId, turns: [{ id: turns.get(params.threadId) }] } });
  if (method === 'session/new' || method === 'session/load') reply({ sessionId: params.sessionId ?? 'session-' + ++seq });
  if (method === 'session/set_mode' || method === 'session/set_model' || method === 'thread/unsubscribe') reply({});
  if (method === 'turn/start' || method === 'session/prompt' || type === 'user') {
    const prompt = message?.content ?? params.input?.[0]?.text ?? params.prompt[0].text;
    const sessionId = params?.sessionId ?? params?.threadId ?? 'claude-' + pid;
    log({ prompt, sessionId });
    if (prompt.startsWith('HANG')) continue;
    if (prompt.startsWith('CRASH')) process.exit(2);
    const turn = 'msg-' + ++seq;
    const answer = prompt.startsWith('请结合已核对的证据') ? '更正：这次没有重试。'
      : prompt.startsWith('PROVE') ? '重试了三次。\n需独立核对：这次重试的次数' : 'answer ' + sessionId;
    if (provider === 'codex') {
      turns.set(sessionId, turn);
      reply({ turn: { id: turn } });
      send({ method: 'item/completed', params: { threadId: sessionId, turnId: turn, item: { type: 'agentMessage', text: answer } } });
      send({ method: 'turn/completed', params: { threadId: sessionId, turn: { id: turn, status: 'completed' } } });
    } else if (provider === 'claude') {
      send({ type: 'assistant', uuid: turn, message: { content: [{ type: 'text', text: answer }] } });
      send({ type: 'result', session_id: sessionId, result: answer });
    } else {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: answer } } } });
      reply({ stopReason: 'end_turn' });
    }
  }
}
