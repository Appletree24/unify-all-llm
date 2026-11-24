import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, timeoutMillis } from '../core/config.js';
import { buildRegistry } from '../providers/index.js';
import { deleteCollection, findCollection, readCatalog, saveCollection } from './catalog.js';
import { capture, deleteEntry, draftsDir, getCase, getDraft, listBench, repoSchema, saveDraft } from './cases.js';
import { exampleCase, examples } from './examples.js';
import { draftCase, publish, runBench, validateCase } from './workflow.js';

export const benchHelp = `unify bench — 从日常失败构造评测题

  add [turn] [--call id] [--note "预期行为"]  保存候选。省略 turn 使用最近记录
  list                                      列出候选、草稿和已发布题目
  list [--search 关键词] [--json]             按标题、备注、名称或 ID 搜索
  show <案例id>                              查看指定版本的题面与评审材料
  collection create <名称> [案例id ...]       创建命名案例集
  collection update <集合id> [--name 名称] [--cases id,id]   改名或替换成员
  collection delete <集合id>                  删除集合，保留案例
  remove <case|draft|candidate> <id>          删除相应条目
  example [示例名]                           列出示例，或从指定示例创建草稿
  draft <候选id> --with <出题目标>            生成可编辑的草稿，可附 --note
      [--commit <完整SHA> --files a.ts,b.ts]  从当前仓库的指定版本引用题目文件
  check <草稿id> [--judge <评审目标>]        验证代表性错解与参考解
  publish <草稿id> [--judge <评审目标>]      审阅后校验并收入项目题集
      check/publish 也支持 --file <JSON文件>，publish --replace <案例id> 修订已收录案例
  run [题目id ...] --models a,b              运行指定题目，省略 id 运行整个题集
      [--collection <集合id>] [--judge <评审目标>] [--json]

草稿保存在 .unify/bench/drafts，已发布题目保存在 unify-bench/。`;
export async function benchCommand(cwd: string, args: string[], signal: AbortSignal) {
  const [cmd, ...rest] = args;
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { console.log(benchHelp); return 0; }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    call: { type: 'string' }, note: { type: 'string' }, with: { type: 'string' }, judge: { type: 'string' },
    commit: { type: 'string' }, files: { type: 'string' }, file: { type: 'string' },
    search: { type: 'string' }, name: { type: 'string' }, cases: { type: 'string' },
    replace: { type: 'string' }, collection: { type: 'string' },
    models: { type: 'string' }, json: { type: 'boolean' },
  } });
  const [id] = positionals;
  if (cmd === 'example') {
    if (id) console.log('草稿 ID ' + saveDraft(cwd, exampleCase(id)));
    else for (const example of examples) console.log(example.key + '  ' + example.label + ' · ' + example.task.title);
    return 0;
  }
  if (cmd === 'add') {
    const item = capture(cwd, id, values.call, values.note);
    console.log('已留作评测候选 ' + item.id);
    return 0;
  }
  if (cmd === 'list') {
    const index = listBench(cwd);
    const term = values.search?.trim().toLowerCase() ?? '';
    const matches = (...strings: string[]) => strings.some(s => s.toLowerCase().includes(term));
    const found = {
      collections: index.collections.filter(c => matches(c.name, c.id)),
      cases: index.cases.filter(c => matches(c.title, c.id)),
      drafts: index.drafts.filter(c => matches(c.title, c.id)),
      candidates: index.candidates.filter(c => matches(c.title, c.note, c.id)),
    };
    if (values.json) console.log(JSON.stringify(found));
    else for (const [label, items] of [['案例集', found.collections], ['候选', found.candidates], ['草稿', found.drafts], ['已发布', found.cases]] as const) {
      console.log(label + ' (' + items.length + ')');
      for (const item of items) console.log('  ' + item.id + '  ' + ('name' in item ? item.name : item.title));
    }
    return 0;
  }
  if (cmd === 'show' && id) { console.log(JSON.stringify(getCase(cwd, id), null, 2)); return 0; }
  if (cmd === 'remove' && positionals.length === 2 && (id === 'case' || id === 'draft' || id === 'candidate')) {
    deleteEntry(cwd, id, positionals[1]); console.log('条目已删除'); return 0;
  }
  if (cmd === 'collection') {
    const [action, key, ...members] = positionals;
    if (!key) throw new Error(benchHelp);
    if (action === 'create') console.log(saveCollection(cwd, key, members).id);
    else {
      const current = findCollection(readCatalog(cwd).collections, key);
      if (action === 'delete') { deleteCollection(cwd, current); console.log('案例集已删除'); }
      else if (action === 'update') {
        const next = values.cases === undefined ? current.caseIds : values.cases.split(',').map(id => id.trim()).filter(Boolean);
        console.log(saveCollection(cwd, values.name ?? current.name, next, current).id);
      } else throw new Error(benchHelp);
    }
    return 0;
  }
  const cfg = loadConfig(cwd), registry = buildRegistry(cfg);
  const model = (name?: string) => {
    const target = name && Object.hasOwn(registry, name) && registry[name];
    if (!target) throw new Error('请选择有效的目标 ID：' + (name || '未指定'));
    return { target, timeoutMs: timeoutMillis(cfg.timeoutSec ?? 600), signal, project: cwd };
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
    else console.log('已发布 ' + await publish(cwd, raw, judge, signal, { previousId: values.replace, collectionId: values.collection }));
    return 0;
  }
  if (cmd === 'run') {
    const names = values.models?.split(',').map(s => s.trim());
    if (!names?.length || new Set(names).size !== names.length) throw new Error('请用 --models 指定各个参评目标');
    const rows = await runBench(cwd, positionals, names.map(model), judge, signal, values.collection);
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) {
      console.log([r.status, r.target, r.title, r.detail, r.durationMs + 'ms'].join('  '));
      for (const check of r.checks ?? []) console.log('  ' + (check.pass ? '✓ ' : '✗ ') + check.criterion + '  ' + check.reason);
    }
    return rows.every(r => r.status === 'pass') ? 0 : 1;
  }
  throw new Error(benchHelp);
}
