import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, timeoutMillis } from '../core/config.js';
import { buildRegistry } from '../providers/index.js';
import { capture, draftsDir, getDraft, listBench, repoSchema } from './cases.js';
import { draftCase, publish, runBench, validateCase } from './workflow.js';

export const benchHelp = `unify bench — 从日常失败构造评测题

  add [turn] [--call id] [--note "预期行为"]  保存候选。省略 turn 使用最近记录
  list                                      列出候选、草稿和已发布题目
  draft <候选id> --with <出题目标>            生成可编辑的草稿，可附 --note
      [--commit <完整SHA> --files a.ts,b.ts]  从当前仓库的指定版本引用题目文件
  check <草稿id> [--judge <评审目标>]        验证代表性错解与参考解
  publish <草稿id> [--judge <评审目标>]      审阅后校验并收入项目题集
      check/publish 也支持 --file <JSON文件>
  run [题目id ...] --models a,b              运行指定题目，省略 id 运行整个题集
      [--judge <评审目标>] [--json]           开放题需要评审目标

草稿保存在 .unify/bench/drafts，已发布题目保存在 unify-bench/。`;
export async function benchCommand(cwd: string, args: string[], signal: AbortSignal) {
  const [cmd, ...rest] = args;
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { console.log(benchHelp); return 0; }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    call: { type: 'string' }, note: { type: 'string' }, with: { type: 'string' }, judge: { type: 'string' },
    commit: { type: 'string' }, files: { type: 'string' }, file: { type: 'string' },
    models: { type: 'string' }, json: { type: 'boolean' },
  } });
  const [id] = positionals;
  if (cmd === 'add') {
    const item = capture(cwd, id, values.call, values.note);
    console.log('已留作评测候选 ' + item.id);
    return 0;
  }
  if (cmd === 'list') {
    const index = listBench(cwd);
    if (values.json) console.log(JSON.stringify(index));
    else for (const [label, items] of [['候选', index.candidates], ['草稿', index.drafts], ['已发布', index.cases]] as const) {
      console.log(label + ' (' + items.length + ')');
      for (const item of items) console.log('  ' + item.id + '  ' + item.title);
    }
    return 0;
  }
  const cfg = loadConfig(cwd), registry = buildRegistry(cfg);
  const model = (name?: string) => {
    const target = name && Object.hasOwn(registry, name) && registry[name];
    if (!target) throw new Error('请选择有效的目标 ID：' + (name || '未指定'));
    return { target, timeoutMs: timeoutMillis(cfg.timeoutSec ?? 600), signal };
  };
  const judge = values.judge ? model(values.judge) : undefined;
  if (cmd === 'draft' && id) {
    const repo = values.commit || values.files ? repoSchema.parse({ commit: values.commit, paths: values.files?.split(',') }) : undefined;
    const draft = await draftCase(cwd, id, model(values.with), values.note, repo);
    console.log(join(draftsDir(cwd), draft.id + '.json'));
    return 0;
  }
  if (cmd === 'check' || cmd === 'publish') {
    if (!values.file && !id) throw new Error('请指定草稿 ID 或 --file');
    const raw = values.file ? JSON.parse(readFileSync(values.file, 'utf8')) : getDraft(cwd, id);
    if (cmd === 'check') { await validateCase(cwd, raw, judge, signal); console.log('错解失败，参考解通过'); }
    else console.log('已发布 ' + await publish(cwd, raw, judge, signal));
    return 0;
  }
  if (cmd === 'run') {
    const names = values.models?.split(',').map(s => s.trim());
    if (!names?.length || new Set(names).size !== names.length) throw new Error('请用 --models 指定各个参评目标');
    const rows = await runBench(cwd, positionals, names.map(model), judge, signal);
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log([r.status, r.target, r.title, r.detail, r.durationMs + 'ms'].join('  '));
    return rows.every(r => r.status === 'pass') ? 0 : 1;
  }
  throw new Error(benchHelp);
}
