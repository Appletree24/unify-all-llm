#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fanOut, runOne } from './core/orchestrator.js';
import { listRunIds, loadConfig, loadRun, newRunId, saveRun, type RunRecord } from './core/store.js';
import { anonymize, buildExecPrompt, buildFollowUpPrompt, buildSynthesisPrompt } from './core/synth.js';
import type { ProviderAdapter, ProviderEvent } from './core/types.js';
import { decide } from './core/decider.js';
import { RESERVED, buildRegistry } from './providers/index.js';
import { runTui } from './tui/app.js';
import { FanOutView, bold, dim, green, header, red, secs, streamEvent, yellow } from './ui/term.js';

const HELP = `unify — 把一个问题同时发给你订阅的所有 LLM，再汇总出最优解

用法:
  unify                     打开交互界面（多栏并排查看各模型回答与汇总）
  unify ask "<问题>"        并发提问并汇总（也可以通过管道从 stdin 传入问题）
  unify exec [记录id]       让一个模型按最终方案在当前目录动手实施
  unify show [记录id]       查看某次记录（默认最近一次）
  unify list                列出当前目录下的记录
  unify doctor              检查各 CLI 是否可用

ask 选项:
  -m, --models a,b          本次发给哪些模型（默认：所有已安装的）
  -s, --synth <id>          用哪个模型汇总（默认 claude）
      --no-synth            只看各自回答，不汇总
  -c, --continue            把最近一次的问题和结论作为上下文追问
      --reasoning           汇总时显示思考过程
      --json                输出 JSONL 事件流（供 IDE 插件等程序消费）
      --timeout <秒>        单个模型的超时（默认 600）

exec 选项:
  -w, --with <id>           由哪个模型实施（默认 claude）
      --from <id>           用某个模型的原始回答而不是汇总结论作为方案
  -y, --yes                 跳过确认

配置: ./unify.config.json 或 ~/.unify/config.json
  { "providers": ["claude","codex"], "synthesizer": "claude", "executor": "codex",
    "models": { "claude": "opus" }, "timeoutSec": 600,
    "custom": { "jev": { "type": "openai", "baseUrl": "http://localhost:8000/v1", "model": "system-one" } },
    "decider": "jev" }
  custom 接入任意模型: type 为 openai（兼容 OpenAI 协议的服务）或 command（stdin 进、stdout 出的命令）。
  decider 指定的模型会在提问前决定发给哪些模型、是否需要汇总。
`;

const cwd = process.cwd();
let registry: Record<string, ProviderAdapter> = {};
const abort = new AbortController();
process.on('SIGINT', () => {
  abort.abort();
  process.stdout.write('\n已取消\n');
  setTimeout(() => process.exit(130), 300);
});

function getAdapter(id: string): ProviderAdapter {
  const a = registry[id];
  if (!a) throw new Error(`未知的模型 "${id}"，可选: ${Object.keys(registry).join(', ')}`);
  return a;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Everything registered answers by default, except the model reserved for deciding. */
function defaultProviderIds(): string[] {
  const decider = loadConfig(cwd).decider;
  return Object.keys(registry).filter((id) => id !== decider);
}

/** Resolve the requested providers, dropping those whose CLI is missing. */
async function resolveAdapters(ids: string[] | undefined, log: (s: string) => void): Promise<ProviderAdapter[]> {
  const wanted = (ids ?? defaultProviderIds()).map(getAdapter);
  const found = await Promise.all(wanted.map((a) => a.detect()));
  const out: ProviderAdapter[] = [];
  wanted.forEach((a, i) => {
    if (found[i].installed) out.push(a);
    else if (ids) log(yellow(`跳过 ${a.label}: 未找到 ${a.id} 命令`));
  });
  return out;
}

async function cmdAsk(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      models: { type: 'string', short: 'm' },
      synth: { type: 'string', short: 's' },
      'no-synth': { type: 'boolean' },
      continue: { type: 'boolean', short: 'c' },
      reasoning: { type: 'boolean' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
    },
  });
  const cfg = loadConfig(cwd);
  const json = values.json === true;
  const jsonOut = (o: object) => process.stdout.write(JSON.stringify(o) + '\n');
  const log = (s: string) => (json ? process.stderr.write(s + '\n') : process.stdout.write(s + '\n'));

  const question = (positionals.join(' ') || (await readStdin())).trim();
  if (!question) throw new Error('请提供问题: unify ask "<问题>"');

  const timeoutSec = Number(values.timeout ?? cfg.timeoutSec ?? 600);
  if (!(timeoutSec > 0)) throw new Error('--timeout 必须是正数');
  const timeoutMs = timeoutSec * 1000;

  let adapters = await resolveAdapters(values.models?.split(',').map((s) => s.trim()) ?? cfg.providers, log);
  if (adapters.length === 0) throw new Error('没有可用的模型，运行 unify doctor 查看');

  // Optional System One step: let the decider pick who answers. An explicit --models wins.
  let synthesize = !values['no-synth'];
  const decider = cfg.decider ? getAdapter(cfg.decider) : undefined;
  if (decider && !values.models && adapters.length > 1 && (await decider.detect()).installed) {
    const d = await decide(decider, {
      question,
      available: adapters.map((a) => ({ id: a.id, label: a.label })),
      cwd,
      model: cfg.models?.[decider.id],
      signal: abort.signal,
    });
    if (d) {
      adapters = adapters.filter((a) => d.providers.includes(a.id));
      synthesize = synthesize && d.synthesize;
      if (json) jsonOut({ type: 'decision', decider: decider.id, ...d });
      else log(dim(`决策 · ${decider.label}: ${d.reason ?? ''}`));
    } else log(yellow(`决策模型 ${decider.label} 没有给出可用结果，按默认发给全部模型`));
  }

  let prompt = question;
  if (values.continue) {
    const prev = loadRun(cwd);
    const prevAnswer = prev.synthesis?.result.ok ? prev.synthesis.result.text : prev.results.find((r) => r.ok)?.text;
    if (!prevAnswer) throw new Error('最近一次记录没有可用的回答，无法追问');
    prompt = buildFollowUpPrompt(prev.question, prevAnswer, question);
  }

  const labels = Object.fromEntries(adapters.map((a) => [a.id, a.label]));
  const run: RunRecord = { id: newRunId(), createdAt: new Date().toISOString(), question, results: [] };
  if (json) jsonOut({ type: 'start', runId: run.id, providers: adapters.map((a) => a.id) });
  else log(dim(`→ ${adapters.map((a) => a.label).join('、')}`));

  // 1. Fan out
  const view = new FanOutView(labels);
  if (!json) view.start();
  run.results = await fanOut(adapters, {
    prompt,
    cwd,
    mode: 'ask',
    models: cfg.models,
    timeoutMs,
    signal: abort.signal,
    onEvent: (id, ev) => (json ? jsonOut({ scope: 'answer', provider: id, ...ev }) : view.onEvent(id, ev)),
  });
  view.stop();
  if (abort.signal.aborted) return 130;

  // 2. Synthesize
  const answers = anonymize(run.results);
  const failed = run.results.filter((r) => !r.ok).map((r) => labels[r.provider]);
  if (!synthesize) {
    // skipped by --no-synth or by the decider
  } else if (answers.length < 2) {
    log(yellow(`\n只有 ${answers.length} 个模型成功回答，跳过汇总`));
  } else {
    const synthId = values.synth ?? cfg.synthesizer ?? 'claude';
    let synth = getAdapter(synthId);
    if (!(await synth.detect()).installed) {
      const fallback = adapters.find((a) => answers.some((x) => x.provider === a.id))!;
      log(yellow(`汇总模型 ${synth.label} 不可用，改用 ${fallback.label}`));
      synth = fallback;
    }
    const labelMap = Object.fromEntries(answers.map((a) => [a.label, a.provider]));
    if (!json) {
      header(`汇总 · ${synth.label}`, failed.length ? `缺少: ${failed.join('、')}` : '');
    }
    const result = await runOne(synth, {
      prompt: buildSynthesisPrompt(question, answers),
      cwd,
      mode: 'ask',
      model: cfg.models?.[synth.id],
      timeoutMs,
      signal: abort.signal,
      onEvent: (id, ev) =>
        json ? jsonOut({ scope: 'synthesis', provider: id, ...ev }) : streamEvent(ev, values.reasoning === true),
    });
    if (abort.signal.aborted) return 130;
    run.synthesis = { provider: synth.id, labels: labelMap, result };
    if (!json) {
      log(dim(`\n${answers.map((a) => `${a.label} = ${labels[a.provider]}`).join('，')} · ${secs(result.durationMs)}`));
    }
  }

  const dir = saveRun(cwd, run);
  if (json) jsonOut({ type: 'end', runId: run.id, dir, labels: run.synthesis?.labels });
  else {
    log(dim(`已保存: ${dir}`));
    if (run.synthesis?.result.ok) log(dim('按此方案动手: unify exec    继续追问: unify ask -c "<问题>"'));
  }
  return run.results.some((r) => r.ok) ? 0 : 1;
}

async function cmdExec(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      with: { type: 'string', short: 'w' },
      from: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      timeout: { type: 'string' },
    },
  });
  const cfg = loadConfig(cwd);
  const run = loadRun(cwd, positionals[0]);

  let plan: string | undefined;
  let source: string;
  if (values.from) {
    plan = run.results.find((r) => r.provider === values.from && r.ok)?.text;
    source = `${getAdapter(values.from).label} 的回答`;
  } else {
    plan = run.synthesis?.result.ok ? run.synthesis.result.text : undefined;
    source = '汇总结论';
  }
  if (!plan) throw new Error(`记录 ${run.id} 中没有可用的${source}（可用 --from <模型> 指定某个回答）`);

  const executor = getAdapter(values.with ?? cfg.executor ?? 'claude');
  if (!(await executor.detect()).installed) throw new Error(`${executor.label} 不可用`);

  process.stdout.write(
    `${bold('即将实施')}\n  记录: ${run.id}\n  需求: ${run.question.slice(0, 120).replace(/\s+/g, ' ')}\n  方案: ${source}\n  执行: ${executor.label}\n  目录: ${cwd}\n${yellow('该模型将获得修改此目录下文件的权限。')}\n`,
  );
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error('非交互环境下需要加 --yes 确认');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('继续？[y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('已取消\n');
      return 0;
    }
  }

  header(`实施 · ${executor.label}`);
  const result = await runOne(executor, {
    prompt: buildExecPrompt(run.question, plan),
    cwd,
    mode: 'exec',
    model: cfg.models?.[executor.id],
    timeoutMs: Number(values.timeout ?? 3600) * 1000,
    signal: abort.signal,
    onEvent: (_id, ev: ProviderEvent) => streamEvent(ev, false),
  });
  process.stdout.write(
    result.ok ? green(`\n完成 · ${secs(result.durationMs)}，请用 git diff 检查改动\n`) : red(`\n未完成: ${result.error}\n`),
  );
  return result.ok ? 0 : 1;
}

function cmdShow(argv: string[]): number {
  const run = loadRun(cwd, argv[0]);
  process.stdout.write(`${bold(run.id)}  ${dim(run.createdAt)}\n\n${run.question}\n`);
  for (const r of run.results) {
    header(registry[r.provider]?.label ?? r.provider, secs(r.durationMs));
    process.stdout.write((r.ok ? r.text.trim() : red(`失败: ${r.error}`)) + '\n');
  }
  if (run.synthesis) {
    header(`汇总 · ${registry[run.synthesis.provider]?.label ?? run.synthesis.provider}`);
    const s = run.synthesis.result;
    process.stdout.write((s.ok ? s.text.trim() : red(`失败: ${s.error}`)) + '\n');
  }
  return 0;
}

function cmdList(): number {
  const ids = listRunIds(cwd);
  if (ids.length === 0) process.stdout.write('还没有记录\n');
  for (const id of ids) {
    const q = loadRun(cwd, id).question.replace(/\s+/g, ' ').slice(0, 70);
    process.stdout.write(`${id}  ${q}\n`);
  }
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const all = Object.values(registry);
  const found = await Promise.all(all.map((a) => a.detect()));
  const cfg = loadConfig(cwd);
  all.forEach((a, i) => {
    const d = found[i];
    process.stdout.write(
      d.installed ? `${green('✓')} ${a.label.padEnd(8)} ${dim(d.version ?? '')}\n` : `${red('✗')} ${a.label.padEnd(8)} 未找到 ${a.id} 命令\n`,
    );
  });
  for (const [id, what] of Object.entries(RESERVED)) {
    if (!registry[id]) process.stdout.write(dim(`· ${what}: 预留，未配置。在配置的 custom.${id} 中填写接入方式即可启用
`));
  }
  if (cfg.decider) process.stdout.write(`决策模型: ${cfg.decider}${registry[cfg.decider] ? '' : red('（未在 custom 中配置）')}
`);
  process.stdout.write(dim('只检查命令是否存在；登录状态需要各 CLI 自己确认。\n'));
  return found.some((d) => d.installed) ? 0 : 1;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  registry = buildRegistry(loadConfig(cwd));
  switch (cmd) {
    case 'ask':
      return cmdAsk(rest);
    case 'exec':
      return cmdExec(rest);
    case 'show':
      return cmdShow(rest);
    case 'list':
      return cmdList();
    case 'doctor':
      return cmdDoctor();
    case undefined:
    case 'tui':
      if (cmd === 'tui' || (process.stdout.isTTY && process.stdin.isTTY)) return runTui(cwd);
      process.stdout.write(HELP);
      return 0;
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      return 0;
    default:
      throw new Error(`未知命令 "${cmd}"，运行 unify help 查看用法`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(red(`错误: ${err instanceof Error ? err.message : err}`) + '\n');
    process.exitCode = 1;
  },
);
