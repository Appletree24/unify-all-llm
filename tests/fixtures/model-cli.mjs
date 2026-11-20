import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const name = basename(process.argv[1]).replace(/\.cmd$/, '');
if (process.env.UNIFY_TEST_LOG) appendFileSync(process.env.UNIFY_TEST_LOG, JSON.stringify({ name, args: process.argv.slice(2) }) + '\n');
if (process.argv.includes('--version')) {
  process.stdout.write('fixture-1.0\n');
} else {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  const scenario = process.env.UNIFY_TEST_SCENARIO;
  const modelFlag = process.argv.findIndex((a) => a === '-m' || a === '--model');
  const answer = `answer-${modelFlag >= 0 ? process.argv[modelFlag + 1] : name}`;
  if (name === 'codex') {
    if (scenario === 'turn-failed' || scenario === 'error-exit') {
      emit({ type: 'error', message: 'fixture connection error' });
      if (scenario === 'turn-failed') emit({ type: 'turn.failed', error: { message: 'fixture upstream failure' } });
      process.exitCode = 1;
    } else {
      if (scenario === 'reconnected') emit({ type: 'error', message: 'Reconnecting... 1/5' });
      emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
      if (scenario === 'wait') await new Promise(() => setInterval(() => {}, 1000));
      if (scenario !== 'truncate') emit({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } });
    }
  } else if (name === 'claude') {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } });
    if (scenario !== 'truncate') emit({ type: 'result', result: answer });
  } else if (name === 'gemini') {
    emit({ type: 'error', severity: 'warning', message: 'advisory' });
    emit({ type: 'message', role: 'assistant', content: answer });
    if (scenario !== 'truncate') emit({ type: 'result', status: 'success', stats: { input_tokens: 3, output_tokens: 5 } });
  } else if (name === 'agy') {
    const { event, message } = JSON.parse(prompt);
    if (event !== 'user' || typeof message.content !== 'string') throw new Error('invalid stdin');
    const text = message.content.includes('CHAT_TWO') && message.content.includes('CHAT_ONE') ? 'remembered' : answer;
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: text } });
    if (scenario === 'signed-out') emit({ event: 'result', result: { status: 'ERROR', error: 'authentication required' } });
    else if (scenario !== 'truncate') emit({ event: 'result', result: { status: 'SUCCESS', response: text, usage: { input_tokens: 3, output_tokens: 5 } } });
  }
  if (scenario === 'late-failure') process.exitCode = 2;
}
