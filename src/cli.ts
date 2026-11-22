#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, parseConfig, timeoutMillis } from './core/config.js';
import { latestComparison, listRunIds, loadRun, type RunRecord } from './core/store.js';
import { synthesisFormatter } from './core/synth.js';
import { chooseExecutor, selectPlan, startComparison, startExecution, type WorkflowEvent } from './core/workflow.js';
import { buildRegistry } from './providers/index.js';
import { detectTargets } from './core/targets.js';
import { effectiveContext, defaultContext, scanMemory } from './memory/scan.js';
import { startMemoryServer } from './memory/server.js';
import { runTui } from './tui/app.js';
import { formatQuota, QUOTA_REFRESH_MS, readTargetQuotas } from './quota/index.js';
import { FanOutView, bold, dim, header, red, secs, streamEvent } from './ui/term.js';
import { displaySynthesisEvents } from './ui/synthesis.js';

const HELP = `unify — 同时提问多个模型，再汇总与实施

用法:
  unify                         多栏交互界面
  unify ask "<问题>"             提问（也支持 stdin）
  unify retry [记录id] --target a 只重试指定目标，创建新记录
  unify exec [记录id]            按方案实施（需确认）
  unify show [记录id]            查看结果及部分输出
  unify list                    查看记录
  unify doctor                  检查目标及能力
  unify quota [--watch] [--json] 查看各目标剩余额度，--watch 每分钟刷新
  unify memory                  查看和管理各工具的记忆（网页；--tui 为终端界面）

ask 选项:
  -m, --models a,b               选择独立目标 id，不允许重复
  -s, --synth id                 汇总目标
      --no-synth                跳过汇总
  -c, --continue                继续最近一次问答，保留公共对话历史
      --from id                 配合 -c 使用：沿用上一轮中指定目标（或 synthesis）的回答
      --reasoning               显示汇总思考过程
      --json                    输出带 turnId/callId 的 JSONL 事件
      --timeout 秒              单次模型调用超时（默认 600）
      --concurrency 数量        同时运行的回答目标数（默认 3）

retry 选项:
      --target a,b              默认重试所有失败或中断目标
      --json                    输出 JSONL；继承原轮实际输入和模型

memory 选项:
      --tui                     在终端里交互式查看和修改
      --list                    在终端打印分层结构，不启动网页
      --json                    输出扫描结果 JSON
      --effective id            打印某个工具启动时拼接后的记忆（claude/codex/gemini/pi）
      --port 端口               网页监听端口（默认随机，仅本机可访问）

exec 选项:
  -w, --with id                 支持实施的执行目标
      --from id                 使用指定目标的成功回答
  -y, --yes                     确认实施
      --timeout 秒              实施超时（默认 3600）

配置: ./unify.config.json 覆盖 ~/.unify/config.json。
  targets: { "fast": { "provider": "codex", "model": "<模型名>" } }
  providers: ["fast", "gemini"]；concurrency: 3。
  custom 端点和命令仅从用户配置加载，详见 README。
  disableClaude: true 完全禁用 Claude Code，包括版本检测。
  TUI: /settings /models /quota /synth /cancel [目标] /retry [目标] /exec /new /copy /exit /quit。
`;

const cwd = process.cwd();
const abort = new AbortController();
let signalExit = 0;
process.on('SIGINT', () => { signalExit = 130; abort.abort(); });
process.on('SIGTERM', () => { signalExit = 143; abort.abort(); });

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  const stop = () => process.stdin.destroy();
  abort.signal.addEventListener('abort', stop, { once: true });
  try { for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); }
  finally { abort.signal.removeEventListener('abort', stop); }
  return Buffer.concat(chunks).toString('utf8');
}

function renderer(json: boolean, reasoning = false) {
  let view: FanOutView | undefined;
  let hasText = false;
  return {
    event(event: WorkflowEvent) {
      if (json) { process.stdout.write(JSON.stringify({ schemaVersion: 2, ...event }) + '\n'); return; }
      if (event.type === 'stage' && event.stage === 'answering') {
        view = new FanOutView(Object.fromEntries(event.targets.map((t) => [t.id, t.label])));
        view.start();
      } else if (event.type === 'call' && (event.scope === 'synthesis' || event.scope === 'exec')) {
        view?.stop();
        hasText = false;
        header(`${event.scope === 'synthesis' ? '汇总' : '实施'} · ${event.target.label}`);
      } else if (event.type === 'provider') {
        if (event.scope === 'answer') view?.onEvent(event.targetId, event.event);
        else if (event.scope !== 'decision') {
          if (event.event.type === 'delta') hasText = true;
          if (event.event.type === 'done' && !hasText) process.stdout.write(event.event.text);
          streamEvent(event.event, reasoning);
        }
      } else if (event.type === 'notice') process.stdout.write(dim(event.message) + '\n');
      else if (event.type === 'end') process.stdout.write(dim(`已保存: ${event.turnId} · ${event.status}`) + '\n');
    },
    stop() { view?.stop(); },
  };
}

async function cmdAsk(argv: string[], retry = false): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      models: { type: 'string', short: 'm' }, synth: { type: 'string', short: 's' }, 'no-synth': { type: 'boolean' },
      continue: { type: 'boolean', short: 'c' }, from: { type: 'string' }, reasoning: { type: 'boolean' }, json: { type: 'boolean' },
      timeout: { type: 'string' }, concurrency: { type: 'string' }, target: { type: 'string' },
    },
  });
  if (values.from && !values.continue) throw new Error('--from 需要与 -c/--continue 一起使用');
  const config = parseConfig({
    ...loadConfig(cwd),
    ...(values.synth ? { synthesizer: values.synth } : {}),
    ...(values.timeout !== undefined ? { timeoutSec: Number(values.timeout) } : {}),
    ...(values.concurrency !== undefined ? { concurrency: Number(values.concurrency) } : {}),
  });
  const targets = Object.values(buildRegistry(config));
  const original = retry ? (positionals[0] ? loadRun(cwd, positionals[0]) : latestComparison(cwd)) : undefined;
  const question = original?.question ?? (positionals.join(' ') || await readStdin()).trim();
  if (abort.signal.aborted) return signalExit;
  const view = renderer(values.json === true, values.reasoning === true);
  try {
    const handle = startComparison({
      cwd, config, targets, question, selected: values.models?.split(',').map((s) => s.trim()),
      manualSelection: !!values.models, synthesize: !values['no-synth'],
      previous: values.continue ? latestComparison(cwd) : undefined,
      continueFrom: values.continue ? values.from : undefined,
      retry: original ? { record: original, targetIds: values.target?.split(',').map((s) => s.trim()) ?? original.targets.filter((t) => !original.results.find((r) => r.targetId === t.id)?.ok).map((t) => t.id) } : undefined,
      signal: abort.signal, onEvent: values.json ? view.event : displaySynthesisEvents(view.event),
    });
    const run = await handle.done;
    return run.results.some((r) => r.ok) ? 0 : 1;
  } finally { view.stop(); }
}

async function cmdExec(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { with: { type: 'string', short: 'w' }, from: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, timeout: { type: 'string' } },
  });
  const config = parseConfig({ ...loadConfig(cwd), ...(values.timeout !== undefined ? { execTimeoutSec: Number(values.timeout) } : {}) });
  timeoutMillis(config.execTimeoutSec ?? 3600);
  const run = positionals[0] ? loadRun(cwd, positionals[0]) : latestComparison(cwd);
  const plan = selectPlan(run, values.from);
  const targets = Object.values(buildRegistry(config));
  const executor = chooseExecutor(targets, values.with ?? config.executor, await detectTargets(targets, abort.signal));
  process.stdout.write(`${bold('即将实施')}\n  记录: ${run.id}\n  需求: ${run.question.slice(0, 120).replace(/\s+/g, ' ')}\n  方案: ${plan.source.targetId} (${plan.source.scope})\n  执行: ${executor.label}\n  目录: ${cwd}\n`);
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error('非交互环境需要 --yes 确认');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('该模型将获得修改文件的权限，继续？[y/N] ', { signal: abort.signal });
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) return 0;
    } finally { rl.close(); }
  }
  if (abort.signal.aborted) return signalExit;
  const view = renderer(false);
  try {
    const result = await startExecution({ cwd, config, targets, executor, source: run, from: values.from, signal: abort.signal, onEvent: (e) => view.event(e) }).done;
    return result.results[0]?.ok ? 0 : 1;
  } finally { view.stop(); }
}

async function cmdQuota(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { watch: { type: 'boolean' }, json: { type: 'boolean' } } });
  const targets = Object.values(buildRegistry(loadConfig(cwd)));
  const liveScreen = values.watch && !values.json && process.stdout.isTTY;
  if (liveScreen) process.stdout.write('\x1b[?1049h');
  try {
    do {
      const rows = await readTargetQuotas(targets, cwd, abort.signal);
      if (values.json) {
        process.stdout.write(JSON.stringify(rows) + '\n');
      } else {
        if (liveScreen) process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(`套餐剩余额度 · ${new Date().toLocaleString('zh-CN')}${values.watch ? ' · 每分钟刷新，Ctrl+C 退出' : ''}\n`);
        for (const row of rows) {
          const title = [row.targetId, row.provider !== row.targetId ? row.provider : undefined, row.model].filter(Boolean).join(' / ');
          process.stdout.write(`\n${bold(title)}\n  ${formatQuota(row.reading).join('\n  ')}\n`);
        }
      }
      if (values.watch) await delay(QUOTA_REFRESH_MS, undefined, { signal: abort.signal });
    } while (values.watch && !abort.signal.aborted);
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    if (liveScreen) process.stdout.write('\x1b[?1049l');
  }
  return signalExit;
}

async function cmdMemory(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { tui: { type: 'boolean' }, list: { type: 'boolean' }, json: { type: 'boolean' }, effective: { type: 'string' }, port: { type: 'string' } } });
  if (values.tui) return runTui(cwd, abort.signal, 'memory');
  const ctx = defaultContext(cwd);
  if (values.effective) { process.stdout.write(effectiveContext(scanMemory(ctx), values.effective)); return 0; }
  if (values.json) { process.stdout.write(JSON.stringify(scanMemory(ctx), null, 2) + '\n'); return 0; }
  if (values.list) {
    for (const h of scanMemory(ctx).harnesses) {
      process.stdout.write(`\n${bold(h.name)} ${dim(h.detected ? `启动载入 ${h.effective.files} 个文件 · 约 ${h.effective.tokens} tokens` : '未使用')}\n`);
      h.layers.forEach((l, i) => {
        process.stdout.write(`  ${i + 1}. ${l.title} ${dim(`${l.load === 'startup' ? '启动时载入' : '按需载入'} · ${l.writer === 'agent' ? '模型写入' : l.writer === 'admin' ? '管理员下发' : '人工维护'}`)}\n`);
        for (const f of l.files) {
          const note = !f.exists ? '尚未创建' : f.shadowedBy ? `被 ${f.shadowedBy} 取代` : `${f.entries.length} 条 · ${f.lines} 行 · 约 ${f.tokens} tokens${f.importedBy ? ` · 由 ${f.importedBy} 导入` : ''}${f.sharedWith ? ` · 与 ${f.sharedWith.join('、')} 共用` : ''}`;
          process.stdout.write(`     ${f.exists ? '●' : '○'} ${f.display} ${dim(note)}\n`);
        }
      });
      for (const issue of h.issues) process.stdout.write(`  ${issue.level === 'info' ? dim('·') : red('!')} ${issue.message}\n`);
    }
    return 0;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 需要 0–65535 的整数');
  const server = await startMemoryServer(ctx, port);
  process.stdout.write(`记忆管理界面: ${server.url}\n${dim('仅本机可访问，链接中带有访问令牌，请勿分享。Ctrl+C 停止。')}\n`);
  await new Promise<void>((done) => { if (abort.signal.aborted) done(); else abort.signal.addEventListener('abort', () => done(), { once: true }); });
  await server.close();
  return 0;
}

function show(run: RunRecord): void {
  process.stdout.write(`${bold(run.id)} · ${run.status}\n\n${run.question}\n`);
  for (const r of [...run.results, ...(run.synthesis ? [run.synthesis.result] : [])]) {
    header(`${r.targetId} (${r.provider}${r.model ? ` / ${r.model}` : ''})`, `${r.status} · ${secs(r.durationMs)}`);
    const text = r === run.synthesis?.result ? synthesisFormatter(run)(r.text) : r.text;
    process.stdout.write(text + '\n');
    if (r.error) process.stdout.write(red(r.error) + '\n');
  }
  if (run.error) process.stdout.write(red(run.error) + '\n');
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (['help', '-h', '--help'].includes(cmd)) { process.stdout.write(HELP); return 0; }
  switch (cmd) {
    case 'ask': return cmdAsk(rest);
    case 'retry': return cmdAsk(rest, true);
    case 'exec': return cmdExec(rest);
    case 'show': show(loadRun(cwd, rest[0])); return 0;
    case 'list':
      for (const id of listRunIds(cwd)) {
        const run = loadRun(cwd, id);
        process.stdout.write(`${id} · ${run.kind} · ${run.status} · ${run.question.replace(/\s+/g, ' ').slice(0, 70)}\n`);
      }
      return 0;
    case 'memory': return cmdMemory(rest);
    case 'quota': return cmdQuota(rest);
    case 'doctor': {
      const cfg = loadConfig(cwd);
      const targets = Object.values(buildRegistry(cfg));
      const found = await detectTargets(targets, abort.signal);
      for (const t of targets) process.stdout.write(`${found.get(t.id) ? '✓' : '·'} ${t.id} · ${t.adapter.id}${t.model ? ` / ${t.model}` : ''} · ask=${t.adapter.capabilities.askPolicy} · exec=${t.adapter.capabilities.exec}${cfg.disableClaude && t.adapter.id === 'claude' ? ' · 已禁用（disableClaude）' : ''}\n`);
      process.stdout.write('检测不验证登录或端点连通性；Gemini 需支持 plan 模式。\n');
      return [...found.values()].some(Boolean) ? 0 : 1;
    }
    case undefined:
    case 'tui':
      if (cmd === 'tui' || (process.stdout.isTTY && process.stdin.isTTY)) return runTui(cwd, abort.signal);
      process.stdout.write(HELP); return 0;
    default: throw new Error(`未知命令 "${cmd}"，运行 unify help 查看用法`);
  }
}

main().then(
  (code) => { process.exitCode = signalExit || code; },
  (err) => { process.stderr.write(`错误: ${err instanceof Error ? err.message : err}\n`); process.exitCode = signalExit || 1; },
);
