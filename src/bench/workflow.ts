import { loadRun } from '../core/store.js';
import { caseSchema, getCandidate, getCase, publishedIds, reviewSchema, saveDraft, sourceAnswer, storeValidated, taskSchema, type BenchCase, type Repository } from './cases.js';
import { ask, grade, materials, publicPrompt, temporary, unfence, writeFiles, type BenchModel, type RubricCheck } from './grading.js';

function authored(text: string) {
  const data = JSON.parse(unfence(text));
  if (typeof data?.missing === 'string') throw new Error('候选待补材料：' + data.missing);
  return data;
}
export async function draftCase(cwd: string, id: string, author: BenchModel, note?: string, repository?: Repository) {
  const c = getCandidate(cwd, id), run = loadRun(cwd, c.source.turn);
  const repoFiles = repository ? await materials(cwd, taskSchema.parse({ title: '-', prompt: '-', files: [], repository })) : [];
  // The public editor never receives the selected answer or any subsequent correction.
  const visible = {
    history: run.input.history.map(h => ({ question: h.question, answer: h.answer })),
    question: run.input.userContent || run.question,
    ...(run.kind === 'execution' && run.planSource?.planText ? { givenPlan: run.planSource.planText } : {}),
    repositoryFiles: repoFiles,
  };
  const edit = '从原始请求构造同领域、同交付形式的独立评测题。保留决定答案的材料、受众、约束和不确定性。写作、客服、访谈等任务应保留原有文本工作场景；代码题保留必要的代码上下文。' +
    '可构造最小的等价文本 fixture；若题目依赖缺失材料且无法等价构造，返回 {"missing":"具体缺什么"}。' +
    '只输出 JSON {"title":"简短标题","prompt":"给考生的需求","files":[{"path":"相对路径","content":"文件原文"}]}。' +
    '已有 repositoryFiles 按原路径提供，不要复制进 files。不要添加解法或答案提示。\n' + JSON.stringify(visible);
  const task = taskSchema.parse({ ...authored(await temporary(dir => ask(author, edit, dir))), repository });
  const files = await materials(cwd, task);
  const design = '你在编写非公开验收材料。根据下列题面、观察到的错误和纠正，判断题面是否仍能测出同一类错误。' +
    '若缺材料、失去原难点或泄漏答案，返回 {"missing":"原因"}。否则只返回以下 JSON：' +
    '{"skill":"必须保留的难点","negative":"有代表性的错误答案","positive":"参考答案","grader":判分对象}。' +
    '优先复用原错答，若需改成新题的接口，保持同一种错误。两份对照要和考生使用同一输出格式。' +
    'grader 可选 {"kind":"exact","expected":"唯一文本答案"}；' +
    '{"kind":"javascript","tests":[{"input":任意JSON,"expected":任意JSON}]}，此时答案是独立标准 JavaScript 函数 solve(input)，含容易答错的边界和正常输入；' +
    '{"kind":"rubric","criteria":["可核对的行为标准"]} 用于总结、沟通、研究和其他允许多种正确表述的任务。' +
    '把用户的纠正转成能从材料与答卷判定的具体标准，每项只写一个要求。已确认事项、尚待确认的前提、受众或团队偏好按题意取舍，接受同义表达。' +
    '仓库补丁可使用 {"kind":"patch","image":"已知可用镜像@sha256:摘要","files":[{"path":"check.sh","content":"验收脚本"}],"command":["sh","/checks/check.sh"]}，' +
    '答案为 unified diff，negative 为空表示未修复的起点，仅在材料提供镜像摘要时使用，禁止编造。' +
    '不适合改写成纯函数的工程题要保留真实边界。\n' +
    JSON.stringify({ task, files, observedAnswer: sourceAnswer(run, c.source.call), correction: note?.trim() || c.note });
  const review = reviewSchema.parse(authored(await temporary(dir => ask(author, design, dir))));
  if (review.grader.kind === 'rubric') review.grader.perCriterion = true;
  const data = caseSchema.parse({ version: 1, task, review });
  return { id: saveDraft(cwd, data), data };
}

export async function validateCase(cwd: string, raw: unknown, judge?: BenchModel, signal?: AbortSignal) {
  const c = caseSchema.parse(raw);
  const files = await materials(cwd, c.task);
  const negative = await grade(c, c.review.negative, files, judge, signal);
  if (negative.status !== 'fail' || negative.invalid) throw new Error('错解未能复现可判定的失败：' + negative.detail);
  const positive = await grade(c, c.review.positive, files, judge, signal);
  if (positive.status !== 'pass') {
    const reasons = positive.checks?.filter(c => !c.pass).map(c => c.criterion + ' ' + c.reason) ?? [];
    throw new Error(['参考解未通过：' + positive.detail, ...reasons].join('\n'));
  }
  return c;
}
export async function publish(cwd: string, raw: unknown, judge?: BenchModel, signal?: AbortSignal) {
  return storeValidated(cwd, await validateCase(cwd, raw, judge, signal));
}
export interface BenchResult {
  caseId: string; title: string; target: string; model?: string; effort?: string; judge?: string;
  status: 'pass' | 'fail' | 'error'; detail: string; checks?: RubricCheck[]; answer?: string; durationMs: number;
}
export async function runBench(cwd: string, ids: string[], models: BenchModel[], judge?: BenchModel, signal?: AbortSignal) {
  if (!models.length) throw new Error('请选择参评模型');
  const selected = ids.length ? ids : publishedIds(cwd);
  if (!selected.length) throw new Error('题集为空，请先发布题目');
  const results: BenchResult[] = [];
  for (const id of selected) {
    const c = getCase(cwd, id);
    for (const model of models) {
      signal?.throwIfAborted();
      const start = Date.now();
      const row: BenchResult = { caseId: id, title: c.task.title, target: model.target.id, model: model.target.model,
        effort: model.target.reasoningEffort, ...(c.review.grader.kind === 'rubric' && { judge: judge?.target.id }),
        status: 'error', detail: '', durationMs: 0 };
      try {
        if (c.review.grader.kind === 'rubric' && !judge) throw new Error('开放题需要选择评审模型');
        const files = await materials(cwd, c.task);
        // A fresh directory per target. The grader starts separately from the original files.
        row.answer = await temporary(async dir => { writeFiles(dir, files); return ask(model, publicPrompt(c, files), dir); });
        const g = await grade(c, row.answer, files, judge, signal);
        row.status = g.status;
        row.detail = g.detail;
        if (g.checks) row.checks = g.checks;
      } catch (err) { row.detail = err instanceof Error ? err.message : String(err); }
      row.durationMs = Date.now() - start;
      results.push(row);
    }
  }
  signal?.throwIfAborted();
  return results;
}
