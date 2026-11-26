import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { recommend, recommendationLabel } from './bench/recommend.js';
import { loadConfig, timeoutMillis } from './core/config.js';
import { createHandoff, readHandoff } from './core/handoff.js';
import { latestComparison, loadRun } from './core/store.js';
import { detectTargets } from './core/targets.js';
import { applyTrial, loadTrial, runTrial, trialDiff, trialSummary } from './core/trial.js';
import { chooseExecutor } from './core/workflow.js';
import { buildRegistry } from './providers/index.js';

const help = {
  trial: 'unify trial [记录ID] --from a,b --check "验证命令" [--with 执行目标] [--yes]\nunify trial show <试跑ID>\nunify trial diff <试跑ID> <1|2>\nunify trial apply <试跑ID> <1|2> [--yes]',
  handoff: 'unify handoff [--session 会话ID] [--with 整理目标]\nunify handoff show <交接ID>\nunify ask --handoff <已审阅的交接ID> "接下来的任务" [--models 目标]',
  recommend: 'unify recommend [--collection 案例集ID] [--json]',
};

async function confirm(note: string, yes: boolean, signal: AbortSignal) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('非交互环境需要 --yes 确认');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await rl.question(note + ' [y/N] ', { signal })).trim()); }
  finally { rl.close(); }
}

export async function projectCommand(cmd: keyof typeof help, cwd: string, args: string[], signal: AbortSignal) {
  if (args.some(a => ['--help', '-h'].includes(a)) || args[0] === 'help') { console.log(help[cmd]); return 0; }
  if (cmd === 'recommend') {
    const { values } = parseArgs({ args, options: { collection: { type: 'string' }, json: { type: 'boolean' } } });
    const report = await recommend(cwd, Object.values(buildRegistry(loadConfig(cwd))), signal, values.collection);
    if (values.json) console.log(JSON.stringify(report));
    else {
      console.log(report.recommended ? '推荐 ' + report.recommended : '当前没有可用且通过评测的目标，可用 unify bench run 积累样本');
      for (const r of report.rows) console.log(recommendationLabel(r) + '\n  ' + r.quotaText);
    }
    return 0;
  }
  if (cmd === 'handoff') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true,
      options: { session: { type: 'string' }, with: { type: 'string' } } });
    if (positionals.length === 2 && positionals[0] === 'show') { console.log(readHandoff(cwd, positionals[1]).answer); return 0; }
    if (positionals.length) throw new Error(help.handoff);
    const cfg = loadConfig(cwd), targets = Object.values(buildRegistry(cfg));
    const session = values.session ?? latestComparison(cwd).sessionId;
    const available = await detectTargets(targets, signal);
    const requested = values.with ?? cfg.synthesizer;
    const writer = requested ? targets.find(t => t.id === requested && available.get(t.id)) :
      targets.find(t => available.get(t.id) && (cfg.providers?.includes(t.id) ?? t.adapter.autoSelect !== false));
    if (!writer) throw new Error('整理目标不可用，请用 --with 指定');
    const draft = await createHandoff(cwd, session, writer, timeoutMillis(cfg.timeoutSec ?? 600), signal);
    console.log('编辑并审阅 ' + draft.path + '\n继续：unify ask --handoff ' + draft.id + ' "接下来的任务"');
    return 0;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    from: { type: 'string' }, check: { type: 'string' }, with: { type: 'string' }, yes: { type: 'boolean', short: 'y' },
  } });
  const [action, id, n] = positionals;
  if (action === 'show' && positionals.length === 2) { console.log(trialSummary(loadTrial(cwd, id))); return 0; }
  if (action === 'diff' && positionals.length === 3) { process.stdout.write(trialDiff(cwd, id, Number(n))); return 0; }
  if (action === 'apply' && positionals.length === 3) {
    if (await confirm('将方案 ' + n + ' 应用到当前工作区？', !!values.yes, signal)) {
      applyTrial(cwd, id, Number(n)); console.log('已采纳方案 ' + n);
    }
    return 0;
  }
  const from = values.from?.split(',').map(s => s.trim());
  if (positionals.length > 1 || !from || !values.check) throw new Error(help.trial);
  const source = action ? loadRun(cwd, action) : latestComparison(cwd);
  const cfg = loadConfig(cwd), targets = Object.values(buildRegistry(cfg));
  const executor = chooseExecutor(targets, values.with ?? cfg.executor, await detectTargets(targets, signal));
  if (!await confirm('用 ' + executor.label + ' 分别实施 ' + from.join('、') + ' 并运行 ' + values.check + '？', !!values.yes, signal)) return 0;
  const trial = await runTrial(cwd, source, from, executor, values.check, timeoutMillis(cfg.execTimeoutSec ?? 3600), signal,
    id => console.log('正在试跑 ' + id));
  console.log(trialSummary(trial));
  return trial.variants.every(v => v.state === 'passed') ? 0 : 1;
}
