import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runOne } from '../dist/core/orchestrator.js';
import { startComparison, startExecution } from '../dist/core/workflow.js';
import { createAntigravityAdapter } from '../dist/providers/antigravity.js';
import { createClaudeAdapter } from '../dist/providers/claude.js';
import { createCodexAdapter } from '../dist/providers/codex.js';
import { customAdapter } from '../dist/providers/custom.js';
import { createGeminiAdapter } from '../dist/providers/gemini.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'unify-interact-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function collectEvents(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('universal mid-turn interaction channel', () => {
  it('orchestrator pauses timeout while awaiting user interaction and resumes afterwards', async () => {
    const adapter = {
      id: 'mock',
      label: 'Mock',
      capabilities: { askPolicy: 'text-only', exec: true },
      async detect() { return { installed: true }; },
      async *run(req) {
        await new Promise((r) => setTimeout(r, 40));
        const res = await req.interact({
          kind: 'approval',
          title: 'Allow mock command?',
          options: [{ id: 'accept', label: 'Allow' }, { id: 'decline', label: 'Deny' }],
        });
        await new Promise((r) => setTimeout(r, 40));
        yield { type: 'done', text: `decision=${res.optionId}` };
      },
    };
    const target = { id: 'mock', label: 'Mock', adapter };
    const result = await runOne(
      target,
      {
        prompt: 'hi',
        cwd: process.cwd(),
        mode: 'exec',
        timeoutMs: 220,
        interact: async () => {
          // Wait longer than timeoutMs; timeout must remain paused during human response.
          await new Promise((r) => setTimeout(r, 340));
          return { optionId: 'accept' };
        },
      },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, 'decision=accept');
  });

  it('workflow coordinates parallel interactions across targets and resolves cleanly on respond & cancel', async () => {
    await withTempDir(async (cwd) => {
      const makeTarget = (id, label, kind) => ({
        id,
        label,
        adapter: {
          id,
          label,
          capabilities: { askPolicy: 'read-tools', exec: true },
          async detect() { return { installed: true }; },
          async *run(req) {
            assert.ok(req.interact, 'expected req.interact when interactive: true');
            const res = await req.interact(
              kind === 'approval'
                ? { kind: 'approval', title: `${label} approval`, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }
                : { kind: 'question', title: `${label} question`, questions: [{ id: 'q1', question: 'Pick one?' }] },
            );
            yield { type: 'done', text: JSON.stringify(res) };
          },
        },
      });

      const targets = [makeTarget('a', 'Model A', 'approval'), makeTarget('b', 'Model B', 'question')];
      const seen = [];
      const resolved = [];

      const handle = startComparison({
        cwd,
        config: { memoryReport: false },
        targets,
        question: 'Parallel interact test',
        selected: ['a', 'b'],
        manualSelection: true,
        synthesize: false,
        interactive: true,
        onEvent(ev) {
          if (ev.type === 'interaction') seen.push(ev);
          if (ev.type === 'interaction-resolved') resolved.push(ev.interactionId);
        },
      });

      // Wait until both parallel targets emit their interaction requests.
      const deadline = Date.now() + 3000;
      while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
      assert.equal(seen.length, 2);

      const evB = seen.find((e) => e.targetId === 'b');
      const evA = seen.find((e) => e.targetId === 'a');
      assert.ok(evA && evB);

      // Respond out-of-order (B first, then A).
      assert.equal(handle.respondInteraction(evB.request.id, { answers: { q1: ['Option 2'] } }), true);
      assert.equal(handle.respondInteraction(evA.request.id, { optionId: 'yes' }), true);
      assert.equal(handle.respondInteraction(evA.request.id, { optionId: 'no' }), false);

      const rec = await handle.done;
      assert.equal(rec.status, 'completed');
      assert.equal(resolved.length, 2);
      assert.deepEqual(JSON.parse(rec.results.find((r) => r.targetId === 'a').text), { optionId: 'yes' });
      assert.deepEqual(JSON.parse(rec.results.find((r) => r.targetId === 'b').text), { answers: { q1: ['Option 2'] } });

      // Test cancellation resolves pending interaction in startExecution as { cancelled: true }.
      let execSeen;
      let resolvedReply;
      const hangExecTarget = {
        id: 'exec-hang',
        label: 'Exec Hang',
        adapter: {
          id: 'exec-hang',
          label: 'Exec Hang',
          capabilities: { askPolicy: 'read-tools', exec: true },
          async detect() { return { installed: true }; },
          async *run(req) {
            resolvedReply = await req.interact({ kind: 'approval', title: 'Dangerous command' });
            yield { type: 'done', text: 'cancelled' };
          },
        },
      };
      const execHandle = startExecution({
        cwd,
        config: { memoryReport: false },
        targets: [...targets, hangExecTarget],
        executor: hangExecTarget,
        source: rec,
        from: 'a',
        interactive: true,
        onEvent(ev) {
          if (ev.type === 'interaction') execSeen = ev;
        },
      });
      const deadline2 = Date.now() + 3000;
      while (!execSeen && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 15));
      assert.ok(execSeen);
      execHandle.cancel();
      const execRec = await execHandle.done;
      assert.equal(execRec.status, 'cancelled');
      assert.deepEqual(resolvedReply, { cancelled: true });
    });
  });

  it('Codex adapter bridges app-server handshake, approvals, requestUserInput, elicitation, deltas & cached usage', async () => {
    await withTempDir(async (cwd) => {
      const fixture = join(cwd, 'codex-mock.mjs');
      writeFileSync(fixture, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let stage = 0;
const replies = {};
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'codex-mock' } });
  } else if (msg.method === 'thread/start') {
    if (msg.params.approvalPolicy !== 'on-request') process.exit(11);
    send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
  } else if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [] } } });
    send({ method: 'item/started', params: { item: { id: 'fc_1', type: 'fileChange', changes: [{ path: 'src/a.ts' }] } } });
    send({ id: 101, method: 'item/commandExecution/requestApproval', params: { itemId: 'cmd_1', threadId: 'thr_1', turnId: 'turn_1', command: 'npm test', cwd: '${cwd.replace(/\\/g, '\\\\')}', reason: 'Run tests' } });
    stage = 1;
  } else if (msg.id === 101) {
    replies.cmd = msg.result;
    send({ id: 102, method: 'item/fileChange/requestApproval', params: { itemId: 'fc_1', threadId: 'thr_1', turnId: 'turn_1', reason: 'Update file' } });
  } else if (msg.id === 102) {
    replies.file = msg.result;
    send({ id: 103, method: 'item/permissions/requestApproval', params: { itemId: 'p_1', threadId: 'thr_1', turnId: 'turn_1', cwd: '.', permissions: { network: { enabled: true } }, reason: 'Need net' } });
  } else if (msg.id === 103) {
    replies.perm = msg.result;
    send({ id: 104, method: 'item/tool/requestUserInput', params: { itemId: 'u_1', threadId: 'thr_1', turnId: 'turn_1', isBlocking: true, questions: [{ id: 'db', header: 'Database', question: 'Which DB?', options: [{ label: 'SQLite', description: 'Local' }], isOther: true }] } });
  } else if (msg.id === 104) {
    replies.input = msg.result;
    send({ id: 105, method: 'mcpServer/elicitation/request', params: { serverName: 'docs', threadId: 'thr_1', message: 'API token?' } });
  } else if (msg.id === 105) {
    replies.mcp = msg.result;
    send({ method: 'item/reasoning/textDelta', params: { itemId: 'r_1', delta: 'thinking...' } });
    send({ method: 'item/agentMessage/delta', params: { itemId: 'm_1', delta: 'OK ' } });
    send({ method: 'item/agentMessage/delta', params: { itemId: 'm_1', delta: JSON.stringify(replies) } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { total: { inputTokens: 120, outputTokens: 45, cachedInputTokens: 80, cacheWriteInputTokens: 0, reasoningOutputTokens: 10, totalTokens: 165 }, last: { inputTokens: 120, outputTokens: 45, cachedInputTokens: 80, cacheWriteInputTokens: 0, reasoningOutputTokens: 10, totalTokens: 165 } } } });
    send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed', items: [] } } });
  }
});
`);

      const adapter = createCodexAdapter({ cmd: process.execPath, prefixArgs: [fixture], nativeExecutable: true });
      const prompts = [];
      const events = await collectEvents(adapter.run({
        prompt: 'run checks',
        cwd,
        mode: 'exec',
        interact: async (req) => {
          prompts.push(req);
          if (req.tool === 'shell') return { optionId: 'accept' };
          if (req.tool === 'edit') return { optionId: 'acceptForSession' };
          if (req.tool === 'permissions') return { optionId: 'session' };
          if (req.kind === 'question') return { answers: { db: ['SQLite'] } };
          if (req.kind === 'input') return { text: 'tok-123' };
          return { cancelled: true };
        },
      }));

      assert.equal(prompts.length, 5);
      assert.match(prompts[0].detail, /npm test/);
      assert.match(prompts[1].detail, /src\/a\.ts/);
      const done = events.find((e) => e.type === 'done');
      assert.ok(done);
      assert.equal(done.usage.cachedInputTokens, 80);
      assert.equal(done.usage.inputTokens, 120);
      const parsed = JSON.parse(done.text.slice(3));
      assert.deepEqual(parsed.cmd, { decision: 'accept' });
      assert.deepEqual(parsed.file, { decision: 'acceptForSession' });
      assert.deepEqual(parsed.perm, { permissions: { network: { enabled: true } }, scope: 'session' });
      assert.deepEqual(parsed.input, { answers: { db: { answers: ['SQLite'] } } });
      assert.deepEqual(parsed.mcp, { action: 'accept', content: { value: 'tok-123' } });
    });
  });

  it('Claude adapter bridges stream-json control_request (tool approval & AskUserQuestion)', async () => {
    await withTempDir(async (cwd) => {
      const fixture = join(cwd, 'claude-mock.mjs');
      writeFileSync(fixture, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
if (!args.includes('--permission-prompts') || !args.includes('host')) process.exit(21);
const seen = {};
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    send({ type: 'control_request', request_id: 'req_bash', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf tmp' } } });
  } else if (msg.type === 'control_response' && msg.response.request_id === 'req_bash') {
    seen.bash = msg.response.response;
    send({ type: 'control_request', request_id: 'req_ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ header: 'Env', question: 'Target env?', options: [{ label: 'Staging', description: 'Safe' }] }] } } });
  } else if (msg.type === 'control_response' && msg.response.request_id === 'req_ask') {
    seen.ask = msg.response.response;
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(seen) } } });
    send({ type: 'result', is_error: false, result: JSON.stringify(seen), usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 30 } });
  }
});
`);
      const adapter = createClaudeAdapter({ cmd: process.execPath, prefixArgs: [fixture], nativeExecutable: true });
      const events = await collectEvents(adapter.run({
        prompt: 'deploy',
        cwd,
        mode: 'exec',
        interact: async (req) => {
          if (req.tool === 'Bash') return { optionId: 'deny' };
          if (req.tool === 'AskUserQuestion') return { answers: { 'Target env?': ['Staging'] } };
          return { cancelled: true };
        },
      }));
      const done = events.find((e) => e.type === 'done');
      assert.ok(done);
      assert.equal(done.usage.cachedInputTokens, 30);
      const parsed = JSON.parse(done.text);
      assert.equal(parsed.bash.behavior, 'deny');
      assert.equal(parsed.ask.behavior, 'allow');
      assert.deepEqual(parsed.ask.updatedInput.answers, { 'Target env?': 'Staging' });
    });
  });

  it('Gemini adapter bridges ACP session/request_permission and falls back to stream-json if ACP unsupported', async () => {
    await withTempDir(async (cwd) => {
      const acpFixture = join(cwd, 'gemini-acp.mjs');
      writeFileSync(acpFixture, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let picked = null;
let promptId;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_1' } });
  else if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 'sess_1', toolCall: { title: 'Run shell', kind: 'execute', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] } });
  } else if (msg.id === 77) {
    picked = msg.result.outcome;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP:' + JSON.stringify(picked) } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`);
      const acpAdapter = createGeminiAdapter({ cmd: process.execPath, prefixArgs: [acpFixture], nativeExecutable: true });
      const acpEvents = await collectEvents(acpAdapter.run({
        prompt: 'hello',
        cwd,
        mode: 'exec',
        interact: async () => ({ optionId: 'allow_once' }),
      }));
      const acpDone = acpEvents.find((e) => e.type === 'done');
      assert.equal(acpDone.text, 'ACP:{"outcome":"selected","optionId":"allow_once"}');

      // Fallback fixture: exits non-zero when --experimental-acp is passed, succeeds on --output-format stream-json.
      const fallbackFixture = join(cwd, 'gemini-fallback.mjs');
      writeFileSync(fallbackFixture, `
if (process.argv.includes('--experimental-acp')) {
  process.stderr.write('unknown flag --experimental-acp\\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: 'fallback-ok' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
`);
      const fallbackAdapter = createGeminiAdapter({ cmd: process.execPath, prefixArgs: [fallbackFixture], nativeExecutable: true });
      const fallbackEvents = await collectEvents(fallbackAdapter.run({
        prompt: 'hello',
        cwd,
        mode: 'ask',
        interact: async () => ({ optionId: 'allow_once' }),
      }));
      const fallbackDone = fallbackEvents.find((e) => e.type === 'done');
      assert.equal(fallbackDone.text, 'fallback-ok');
    });
  });

  it('Antigravity requests a single follow-up in the same session when tools finish without an answer', async () => {
    await withTempDir(async (cwd) => {
      const fixture = join(cwd, 'agy-empty-answer.mjs');
      writeFileSync(fixture, `
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
let scenario;
for await (const line of lines) {
  const { message: { content } } = JSON.parse(line);
  if (!scenario) {
    scenario = content.split('\\n')[0];
    send({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file' } });
    if (scenario === 'streamed') send({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'streamed answer' } });
    send({ event: 'result', result: { status: 'SUCCESS', response: ' ' } });
  } else {
    assert.notEqual(scenario, 'streamed');
    assert.match(content, /不要再次调用工具/);
    const response = scenario === 'empty' ? '' : 'recovered answer';
    send({ event: 'result', result: { status: 'SUCCESS', response, usage: { output_tokens: 21 } } });
    if (scenario === 'late failure') process.exitCode = 2;
  }
}
`);
      const adapter = createAntigravityAdapter({ cmd: process.execPath, prefixArgs: [fixture], nativeExecutable: true });
      const run = (prompt) => runOne({ id: adapter.id, adapter }, { cwd, mode: 'ask', prompt, timeoutMs: 5000 });

      const recovered = await run('recover');
      assert.equal(recovered.status, 'succeeded');
      assert.equal(recovered.text, 'recovered answer');
      assert.equal(recovered.usage.outputTokens, 21);
      assert.deepEqual(recovered.tools.map((tool) => tool.name), ['read_file']);

      const streamed = await run('streamed');
      assert.equal(streamed.status, 'succeeded');
      assert.equal(streamed.text, 'streamed answer');

      const empty = await run('empty');
      assert.equal(empty.status, 'failed');
      assert.match(empty.error, /未返回回答正文/);

      const failed = await run('late failure');
      assert.equal(failed.status, 'failed');
      assert.match(failed.error, /退出码 2/);
    });
  });

  it('Gemini Pro keeps Plan mode, streams command details, and forwards real ACP permission outcomes', async () => {
    await withTempDir(async (cwd) => {
      const fixture = join(cwd, 'agy-acp.mjs');
      writeFileSync(fixture, `
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
assert.ok(process.argv.includes('acp'));
const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\\n');
const update = (payload) => send({ method: 'session/update', params: { update: payload } });
let promptId;
let mode;
let model;
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.method === 'initialize') send({ id: req.id, result: { protocolVersion: 1 } });
  else if (req.method === 'session/new') send({ id: req.id, result: { sessionId: 'test-session' } });
  else if (req.method === 'session/set_mode') { mode = req.params.modeId; send({ id: req.id, result: {} }); }
  else if (req.method === 'session/set_model') { model = req.params.modelId; send({ id: req.id, result: {} }); }
  else if (req.method === 'session/prompt') {
    assert.equal(mode, 'plan');
    assert.equal(model, 'custom-model');
    promptId = req.id;
    const toolCall = { toolCallId: 'call-1', kind: 'execute', title: 'List directory', rawInput: { CommandLine: 'Get-ChildItem src' } };
    update({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
    send({ id: 'perm-1', method: 'session/request_permission', params: {
      toolCall, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
    } });
  } else if (req.id === 'perm-1') {
    const allowed = req.result.outcome.optionId === 'allow';
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: allowed ? 'completed' : 'failed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'item.txt' : 'Access denied' } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
}
`);
      const adapter = createAntigravityAdapter({ cmd: process.execPath, prefixArgs: [fixture], nativeExecutable: true });
      for (const allowed of [true, false]) {
        let prompt;
        const result = await runOne({ id: adapter.id, adapter, model: 'custom-model' }, {
          cwd, mode: 'ask', prompt: 'Inspect src', timeoutMs: 5000,
          interact: async (request) => { prompt = request; return { optionId: allowed ? 'allow' : 'deny' }; },
        });
        assert.equal(result.status, 'succeeded');
        assert.equal(prompt.detail, 'Get-ChildItem src');
        assert.equal(result.text, allowed ? 'item.txt' : 'Access denied');
        assert.deepEqual(result.tools, [{
          id: 'call-1', name: 'run_command', detail: 'Get-ChildItem src', status: allowed ? 'completed' : 'denied',
          ...(!allowed && { error: '用户拒绝了此操作' }),
        }]);
      }
    });
  });

  it('Antigravity (agy) and custom interactive command bridge mid-turn interactions cleanly', async () => {
    await withTempDir(async (cwd) => {
      const agyFixture = join(cwd, 'agy-mock.mjs');
      writeFileSync(agyFixture, `
import { createInterface } from 'node:readline';
if (process.argv.includes('acp')) process.exit(2);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.event === 'user') {
    send({ event: 'approval_request', request_id: 'a1', title: 'Read config?', tool_name: 'read_file' });
  } else if (msg.event === 'approval_response') {
    send({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'approved=' + msg.approved } });
    send({ event: 'result', result: { status: 'SUCCESS', response: 'approved=' + msg.approved } });
  }
});
`);
      const agy = createAntigravityAdapter({ cmd: process.execPath, prefixArgs: [agyFixture], nativeExecutable: true });
      const agyEvents = await collectEvents(agy.run({
        prompt: 'check',
        cwd,
        mode: 'ask',
        interact: async () => ({ optionId: 'approve' }),
      }));
      assert.equal(agyEvents.find((e) => e.type === 'done').text, 'approved=true');

      // Custom interactive command using __UNIFY_INTERACT__: protocol
      const customFixture = join(cwd, 'custom-interact.mjs');
      writeFileSync(customFixture, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let step = 0;
rl.on('line', (line) => {
  if (step === 0) {
    step = 1;
    process.stdout.write('Hello before\\n');
    process.stdout.write('__UNIFY_INTERACT__:' + JSON.stringify({ kind: 'input', title: 'Need token', placeholder: 'token' }) + '\\n');
  } else {
    const reply = JSON.parse(line);
    process.stdout.write('Got:' + reply.text + '\\n');
    rl.close();
    process.stdin.destroy();
  }
});
`);
      const custom = customAdapter('my-tool', {
        type: 'command',
        command: 'node',
        args: ['custom-interact.mjs'],
        interactive: true,
      });
      const customEvents = await collectEvents(custom.run({
        prompt: 'start',
        cwd,
        mode: 'ask',
        interact: async (req) => {
          assert.equal(req.title, 'Need token');
          return { text: 'secret-42' };
        },
      }));
      const customDone = customEvents.find((e) => e.type === 'done');
      assert.equal(customDone.text, 'Hello before\nGot:secret-42');
      assert.ok(!customDone.text.includes('__UNIFY_INTERACT__'));
    });
  });
});
