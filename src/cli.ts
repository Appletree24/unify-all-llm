#!/usr/bin/env node
import { benchCommand } from './bench/command.js';
import { readCacheReport } from './core/cache-monitor.js';
import { isReviewOrReport, roleNames } from './core/collaboration.js';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig, parseConfig, timeoutMillis } from './core/config.js';
import { latestComparison, listRunIds, loadRun, type CallRecord, type RunRecord } from './core/store.js';
import { synthesisFormatter } from './core/synth.js';
import { detectTargets } from './core/targets.js';
import type { InteractionResponse, PendingInteraction } from './core/types.js';
import { chooseExecutor, selectPlan, startComparison, startExecution, type WorkflowEvent } from './core/workflow.js';
import { formatMemoryReferences } from './memory/report.js';
import { defaultContext, effectiveContext, scanMemory } from './memory/scan.js';
import { applyDistillSave, prepareDistill, previewDistillSave, type DistillSourceScope } from './memory/distill.js';
import { applyMemorySync, previewMemorySync } from './memory/sync.js';
import { startMemoryServer } from './memory/server.js';
import { buildRegistry } from './providers/index.js';
import { formatQuota, QUOTA_REFRESH_MS, readTargetQuotas } from './quota/index.js';
import { runTui } from './tui/app.js';
import { displaySynthesisEvents } from './ui/synthesis.js';
import { bold, dim, FanOutView, header, red, secs, streamEvent } from './ui/term.js';

const HELP = `unify — 同时提问多个模型，再汇总与实施

用法:
  unify                         多栏交互界面
  unify ask "<问题>"             提问（也支持 stdin）
  unify retry [记录id] --target a 只重试指定目标，创建新记录
  unify exec [记录id]            按方案实施（需确认）
  unify show [记录id]            查看结果及部分输出
  unify list                    查看记录
  unify doctor                  检查目标及能力
  unify bench help              留题、出题、校验及运行项目评测集
  unify quota [--watch] [--json] 查看各目标剩余额度，--watch 每分钟刷新
  unify cache [--json]           查看所有项目最近的缓存预警和供应商读数
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
      sync --from 源 --to 目标   预览单向同步到托管区块（加 --apply 落盘）
      distill --turn id --call c 从记录沉淀记忆预览（加 --apply 落盘）

exec 选项:
  -w, --with id                 支持实施的执行目标
      --from id                 使用指定目标的成功回答
  -y, --yes                     确认实施
      --timeout 秒              实施超时（默认 3600）

配置: ./unify.config.json 覆盖 ~/.unify/config.json。
  targets: { "fast": { "provider": "codex", "model": "<模型名>" } }
  providers: ["fast", "gemini-pro"]；concurrency: 3。
  custom 端点和命令仅从用户配置加载，详见 README。
  在 ~/.unify/config.json 中设置 disableClaude: true 可全局禁用 Claude Code，包括版本检测。
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
    let view: FanOutView | undefined
    let hasText = false;
    const titles: Partial<Record<CallRecord['scope'], string>> = {
        synthesis: '汇总', exec: '实施', 'plan-review': '方案复核', 'result-review': '实施复核', report: roleNames.report,
    };
    return {
        event(event: WorkflowEvent) {
            if (json) { process.stdout.write(JSON.stringify({ schemaVersion: 2, ...event }) + '\n'); return; }
            if (event.type === 'stage' && event.stage === 'answering') {
                view = new FanOutView(Object.fromEntries(event.targets.map((t) => [t.id, t.label])));
                view.start();
            } else if (event.type === 'call' && titles[event.scope]) {
                view?.stop();
                hasText = false;
                header(`${titles[event.scope]} · ${event.target.label}`);
            } else if (event.type === 'provider') {
                if (event.scope === 'answer') view?.onEvent(event.targetId, event.event);
                else if (titles[event.scope]) {
                    if (event.event.type === 'delta') hasText = true;
                    if (event.event.type === 'done' && !hasText) process.stdout.write(event.event.text);
                    streamEvent(event.event, reasoning);
                }
            } else if (event.type === 'notice') process.stdout.write(dim(event.message) + '\n');
            else if (event.type === 'end') process.stdout.write(dim(`已保存: ${event.turnId} · ${event.status}`) + '\n');
        },
        pause() { view?.stop(); },
        resume() { view?.start(); },
        stop() { view?.stop(); },
    };
}

/**
 * Serialized TTY prompt handler so concurrent models never interleave terminal questions.
 */
function createCliInteractor(view: ReturnType<typeof renderer>, signal: AbortSignal) {
    let queue: Promise<void> = Promise.resolve();
    return (info: { targetLabel: string; request: PendingInteraction }): Promise<InteractionResponse> => {
        const run = async (): Promise<InteractionResponse> => {
            if (signal.aborted) return { cancelled: true };
            view.pause();
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                const { request } = info;
                process.stdout.write(`\n${bold(`[需要交互 · ${info.targetLabel}] ${request.title}`)}${request.tool ? dim(` (${request.tool})`) : ''}\n`);
                if (request.detail) process.stdout.write(`${dim(request.detail)}\n`);

                if (request.kind === 'approval') {
                    const options = request.options?.length
                        ? request.options
                        : [{ id: 'accept', label: '允许' }, { id: 'decline', label: '拒绝' }];
                    options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o.label}${o.description ? dim(` — ${o.description}`) : ''}\n`));
                    const ans = (await rl.question(`请选择 [1-${options.length}]（回车默认拒绝，q 中止）: `, { signal })).trim();
                    if (!ans) return { optionId: options.find((o) => o.tone === 'danger')?.id ?? options[options.length - 1].id };
                    if (ans.toLowerCase() === 'q') return { cancelled: true };
                    const idx = Number(ans) - 1;
                    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return { optionId: options[idx].id };
                    const byId = options.find((o) => o.id.toLowerCase() === ans.toLowerCase());
                    return { optionId: byId?.id ?? options[options.length - 1].id };
                }

                if (request.kind === 'question' && request.questions?.length) {
                    const answers: Record<string, string[]> = {};
                    for (const q of request.questions) {
                        process.stdout.write(`\n${q.header ? `${bold(q.header)}: ` : ''}${q.question}\n`);
                        if (q.options?.length) {
                            q.options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o.label}${o.description ? dim(` — ${o.description}`) : ''}\n`));
                            const raw = (await rl.question(`输入编号${q.allowOther ? '或自定义回答' : ''}（留空跳过）: `, { signal })).trim();
                            if (!raw) { answers[q.id] = []; continue; }
                            const idx = Number(raw) - 1;
                            if (Number.isInteger(idx) && idx >= 0 && idx < q.options.length) answers[q.id] = [q.options[idx].label];
                            else answers[q.id] = [raw];
                        } else {
                            const raw = (await rl.question('请输入回答: ', { signal })).trim();
                            answers[q.id] = raw ? [raw] : [];
                        }
                    }
                    return { answers };
                }

                const text = await rl.question(`${request.placeholder || '请输入内容'}（留空取消）: `, { signal });
                return text.trim() ? { text } : { cancelled: true };
            } catch {
                return { cancelled: true };
            } finally {
                rl.close();
                if (!signal.aborted) view.resume();
            }
        };
        const result = queue.then(run, run);
        queue = result.then(() => undefined, () => undefined);
        return result;
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
    const canInteract = process.stdin.isTTY && process.stdout.isTTY && !values.json;
    const onInteract = canInteract ? createCliInteractor(view, abort.signal) : undefined;
    try {
        const handle = startComparison({
            cwd, config, targets, question, selected: values.models?.split(',').map((s) => s.trim()),
            manualSelection: !!values.models, synthesize: !values['no-synth'],
            previous: values.continue ? latestComparison(cwd) : undefined,
            continueFrom: values.continue ? values.from : undefined,
            retry: original ? { record: original, targetIds: values.target?.split(',').map((s) => s.trim()) ?? original.targets.filter((t) => !original.results.find((r) => r.targetId === t.id)?.ok).map((t) => t.id) } : undefined,
            interactive: canInteract, onInteract,
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
    const executor = chooseExecutor(targets, values.with ?? run.collaboration?.execution.target ?? config.executor, await detectTargets(targets, abort.signal));
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
    const canInteract = process.stdin.isTTY && process.stdout.isTTY;
    const onInteract = canInteract ? createCliInteractor(view, abort.signal) : undefined;
    try {
        const result = await startExecution({ cwd, config, targets, executor, source: run, from: values.from, interactive: canInteract, onInteract, signal: abort.signal, onEvent: (e) => view.event(e) }).done;
        return (run.collaboration?.report ? result.status === 'completed' : result.results[0]?.ok) ? 0 : 1;
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
    const ctx = defaultContext(cwd);
    if (args[0] === 'sync') {
        const { values } = parseArgs({
            args: args.slice(1),
            options: { from: { type: 'string' }, to: { type: 'string' }, apply: { type: 'boolean' }, force: { type: 'boolean' } },
        });
        if (!values.from || !values.to) throw new Error('用法: unify memory sync --from <源文件> --to <目标1,目标2> [--apply]');
        const targets = values.to.split(',').map((s) => s.trim()).filter(Boolean);
        const preview = previewMemorySync(ctx, values.from, targets, !!values.force);
        for (const t of preview.targets) {
            process.stdout.write(`${bold(t.display)} · ${t.status}${t.changedLines !== undefined ? ` (${t.changedLines} 行变动)` : ''}${t.reason ? ` · ${t.reason}` : ''}\n`);
        }
        if (!values.apply) {
            process.stdout.write(dim('以上为预览，未修改磁盘；添加 --apply 执行写入。\n'));
            return 0;
        }
        const baseHashes = Object.fromEntries(preview.targets.filter((t) => t.baseHash !== undefined).map((t) => [t.targetPath, t.baseHash!]));
        const applied = applyMemorySync(ctx, { sourcePath: values.from, targetPaths: targets, baseHashes, force: !!values.force });
        for (const r of applied.results) process.stdout.write(`  ${r.targetPath} -> ${r.status}${r.message ? ` (${r.message})` : ''}\n`);
        return applied.results.some((r) => r.status === 'error') ? 1 : 0;
    }
    if (args[0] === 'distill') {
        const { values } = parseArgs({
            args: args.slice(1),
            options: {
                turn: { type: 'string' }, call: { type: 'string' }, scope: { type: 'string' },
                to: { type: 'string' }, text: { type: 'string' }, heading: { type: 'string' }, apply: { type: 'boolean' },
            },
        });
        if (!values.turn || !values.call) throw new Error('用法: unify memory distill --turn <turnId> --call <runId> [--scope answer|synthesis|exec] [--to <文件>] [--text <内容>] [--apply]');
        const scope = (values.scope ?? 'answer') as DistillSourceScope;
        if (!['answer', 'synthesis', 'exec'].includes(scope)) throw new Error('--scope 必须是 answer、synthesis 或 exec');
        const source = { turnId: values.turn, runId: values.call, scope, ...(values.text ? { selectedText: values.text } : {}) };
        const prep = prepareDistill(ctx, source);
        const targetPath = values.to ?? prep.defaultTargetPath;
        if (!targetPath) throw new Error('未找到可写入的默认记忆文件，请使用 --to 指定');
        const text = values.text ?? prep.defaultText;
        const preview = previewDistillSave(ctx, { source, targetPath, text, heading: values.heading });
        process.stdout.write(`${bold('来源')}: ${prep.sourceLabel} (${values.turn} / ${values.call})\n${bold('目标')}: ${preview.display} (${preview.targetPath})\n`);
        if (preview.duplicates.exact) process.stdout.write(red(`重复提示: 第 ${preview.duplicates.exact.start} 行已有相同条目\n`));
        if (!values.apply) {
            process.stdout.write(`\n--- 预览写入内容 ---\n${text}\n${dim('以上为预览，未修改磁盘；添加 --apply 执行写入。\n')}`);
            return 0;
        }
        const saved = applyDistillSave(ctx, { source, targetPath, text, heading: values.heading, baseHash: preview.baseHash });
        process.stdout.write(`已写入 ${saved.display}（审计 ID: ${saved.auditId}）\n`);
        return 0;
    }
    const { values } = parseArgs({ args, options: { tui: { type: 'boolean' }, list: { type: 'boolean' }, json: { type: 'boolean' }, effective: { type: 'string' }, port: { type: 'string' } } });
    if (values.tui) return runTui(cwd, abort.signal, 'memory');
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
    const stageCalls = run.calls.filter(c => isReviewOrReport(c.scope));
    for (const r of [...run.results, ...(run.synthesis ? [run.synthesis.result] : []), ...stageCalls.map(c => c.result)]) {
        header(`${r.targetId} (${r.provider}${r.model ? ` / ${r.model}` : ''})`, `${r.status} · ${secs(r.durationMs)}`);
        const text = r === run.synthesis?.result ? synthesisFormatter(run)(r.text) : r.text;
        process.stdout.write(text + formatMemoryReferences(r.memoryReferences) + '\n');
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
        case 'bench': return benchCommand(cwd, rest, abort.signal);
        case 'memory': return cmdMemory(rest);
        case 'quota': return cmdQuota(rest);
        case 'cache': {
            const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
            const report = await readCacheReport();
            if (values.json) console.log(JSON.stringify(report, null, 2));
            else {
                console.log(`缓存监控 · 最近 ${report.calls.length} 次调用 · ${report.warned} 次预警 · ${report.reported} 次返回缓存读数`);
                for (const c of report.calls) {
                    const cached = c.cachedTokens === undefined ? (c.phase === 'submitted' ? '尚无终态' : '未上报') : c.cachedTokens + ' tokens';
                    console.log([new Date(c.updatedAt ?? c.at).toLocaleString(), c.project, c.model ?? c.target, c.scope, c.comparison, '缓存读取 ' + cached].join(' · '));
                    for (const warning of c.warnings) console.log('  ⚠ ' + warning);
                }
            }
            return 0;
        }
        case 'doctor': {
            const cfg = loadConfig(cwd);
            const targets = Object.values(buildRegistry(cfg));
            const found = await detectTargets(targets, abort.signal);
            for (const t of targets) process.stdout.write(`${found.get(t.id) ? '✓' : '·'} ${t.id} · ${t.adapter.id}${t.model ? ` / ${t.model}` : ''} · ask=${t.adapter.capabilities.askPolicy} · exec=${t.adapter.capabilities.exec}${cfg.disableClaude && t.adapter.id === 'claude' ? ' · 已禁用（disableClaude）' : ''}\n`);
            process.stdout.write('检测不验证登录或端点连通性。\n');
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
