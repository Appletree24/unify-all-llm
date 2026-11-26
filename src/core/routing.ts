import type { AnswerEffort, Config, RoutingMode } from './config.js';
import type { RunRecord } from './store.js';
import { runningStatus, type ModelTarget, type TargetSnapshot } from './types.js';
import { agyModelFamily, isAgyProvider } from '../providers/agy-models.js';
import { effortLabel } from '../providers/effort.js';

export type SupplementAction = 'opinion' | 'synthesis';
export const routingLabels = { standard: '普通问答', auto: '自动', single: '单模型', multi: '多模型' } as const;
export const answerEffortLabels = {
  target: '按各目标设置', auto: '自动（按本轮要求）', default: '原生默认',
  minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra',
} satisfies Record<Exclude<AnswerEffort, 'none'>, string>;
export function answerMode(config: Pick<Config, 'routing' | 'answerModel' | 'answerEffort' | 'advisor'>): RoutingMode {
  return config.routing ?? (config.answerModel !== undefined || (config.answerEffort && config.answerEffort !== 'target') || (config.advisor && config.advisor !== 'off') ? 'auto' : 'standard');
}
export const supplementLabels = { opinion: '追加一个独立意见', synthesis: '汇总已有回答' } as const;

const readerPolicies = new Set(['read-tools', 'sandbox-read-only', 'provider-plan']);
export function canReadProject(target: ModelTarget | TargetSnapshot): boolean {
  return readerPolicies.has(('adapter' in target ? target.adapter : target).capabilities.askPolicy);
}

export function sameModel(target: ModelTarget, other: ModelTarget | TargetSnapshot): boolean {
  const provider = 'adapter' in other ? other.adapter.id : other.provider;
  const config = 'adapter' in other ? other.adapter.configuration : other.configuration;
  const own = target.adapter.configuration;
  if (own?.type === 'openai' && config?.type === 'openai') {
    return own.baseUrl.replace(/\/+$/, '') === config.baseUrl.replace(/\/+$/, '')
      && (target.model ?? own.model) === (other.model ?? config.model);
  }
  if (own?.type === 'command' && config?.type === 'command' && own.command !== config.command) return false;
  if (target.adapter.id === provider && isAgyProvider(provider, target.adapter.capabilities.askPolicy) && target.model && other.model) {
    return agyModelFamily(target.model) === agyModelFamily(other.model);
  }
  return target.adapter.id === provider && target.model === other.model;
}

export function supplementActions(run: RunRecord): SupplementAction[] {
  if (run.kind !== 'comparison' || run.collaboration || runningStatus(run.status) || run.synthesis?.result.ok) return [];
  const count = run.results.filter(r => r.ok && r.text.trim()).length;
  return count === 1 ? ['opinion'] : count >= 2 ? ['synthesis'] : [];
}

export function routingNotice(routing: NonNullable<RunRecord['routing']>): string {
  const label = { direct: '单模型', compare: '多模型', opinion: '独立意见', synthesis: '汇总' }[routing.kind];
  const answers = routing.answers?.map(a => `${a.targetId}${a.model && a.model !== a.targetId ? ' / ' + a.model : ''} · ${effortLabel(a.level ?? '原生默认')}（${a.reason}）`);
  return [label, routing.reason, ...(answers ?? [])].join(' · ');
}

// A path is a reason to pick a reader. Only explicit @mentions are expanded into shared input.
const fileReference = /(?:^|[^a-z0-9_./-])(?:@[\w./-]+|(?:[/\\])?(?:[\p{L}\p{N}_.-]+[/\\])+[\p{L}\p{N}_.-]+\.[a-z][a-z0-9]{0,9}|[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|json|ya?ml|toml|md|sql|sh)|Dockerfile|Makefile)(?=$|[^a-z0-9_./-]|\.(?=\s|$))/iu;

function requestText(question: string): string {
  let fence = '';
  const preamble = question.trim().slice(0, 4000).split('\n').filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = '';
      return false;
    }
    fence = marker ?? '';
    return !fence && !/^\s*>/u.test(line);
  }).join('\n');
  // A transformation or material label followed by a delimiter introduces pasted content.
  const material = /(?:翻译|润色|改写|校对|压缩|总结|下文|原文|这段话|这段文字|以下(?:文本|材料|日志)|\b(?:translate|rewrite|summarize|proofread|excerpt|transcript)\b)[^。！？!?\n：:]{0,80}(?:[：:](?!\/\/)|\n\s*\n)/iu.exec(preamble);
  const request = material ? preamble.slice(0, material.index + material[0].length) : preamble;
  return request.replace(/https?:\/\/[^\s<>"`，。！？]+/giu, ' ')
    .replace(/「[^」]*」|“[^”]*”|‘[^’]*’|`[^`\n]*`|"[^"\n]*"|(?<![a-z0-9])'[^'\n]+'/gu, quoted => {
      const token = quoted.slice(1, -1);
      if (/^[\w@./:\\-]+$/u.test(token)) return token;
      return /[/\\]/u.test(token) && fileReference.test(token) ? ' @file ' : ' ';
    });
}

const negativePrefix = /(?:不要|不用|不需要|无需|别|不|\bdo not|\bdon['’]t|\bnever|\bwithout)\s*$/iu;
const howToPrefix = /(?:怎么|如何|怎样|\bhow (?:to|(?:do|can|should) (?:i|we))|\bshould (?:i|we))\s*$/iu;
const quantities: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 多: 2,
  one: 1, two: 2, three: 3, four: 4, multiple: 2, different: 2 };

function requestedCount(request: string): number | undefined {
  // Include the verb in the match so "不用两个模型" and "don't ask two models" retain their negation.
  const count = /(?:调用|使用|用|让|找|问|请|不要|不需要|无需|^|[，。！？、]\s*)\s*([一两二三四五六七八九多1-9])\s*(?:个|位)?模型|\b(?:use|ask|consult)\s+(?:only\s+)?(one|two|three|four|multiple|different|[1-9])\s+models?\b/giu;
  let requested: number | undefined;
  for (const match of request.matchAll(count)) {
    const value = match[1] ?? match[2].toLowerCase();
    const number = quantities[value] ?? Number(value);
    const before = request.slice(0, match.index);
    const after = request.slice(match.index + match[0].length).trimStart();
    // A quantity can also be the subject ("两个模型有什么区别"). Require an answering role for bare nouns.
    const bare = /^[，。！？、\s]*[一两二三四五六七八九多1-9]/u.test(match[0]);
    if (howToPrefix.test(before)) continue;
    if (bare && !/^(?:分别|各自|并行|独立|回答|作答|给意见|评审|审查)/u.test(after)) continue;
    if (negativePrefix.test(before) || /^(?:不要|不需要|无需)/u.test(match[0])) {
      requested = number > 1 ? 1 : 2;
    } else {
      requested = number;
    }
  }
  if (requested !== undefined) return requested;
  const single = /单模型(?:作答|回答|直答)|一个模型就(?:够|行)|\b(?:one model only|single model only)\b/iu.exec(request);
  if (single) return negativePrefix.test(request.slice(0, single.index)) ? 2 : 1;
  if (/(?:不要|不用|无需|别)(?:多模型|第二意见|独立意见)|\bno second opinion\b/iu.test(request)) return 1;
  const opinion = /(?:再找|给我|来|追加|补充)(?:一?[个份])?(?:独立意见|第二意见)|\b(?:get|give me|add) (?:a |an |two )?(?:independent (?:opinions?|answers?|reviews?)|second opinion)\b/iu.exec(request);
  if (opinion) return negativePrefix.test(request.slice(0, opinion.index)) ? 1 : 2;
  return undefined;
}

export function questionIntent(question: string) {
  const request = requestText(question);
  const repo = fileReference.test(request) || /(?:仓库|源码|代码库|工作区|代码行号|调用链|本地文件|当前项目|这个项目|实现在哪|(?:目前|当前|现有|现行|现在的)(?:的?(?:实现|逻辑)|[^，。！？\n]{0,24}(?:模式|接口|模块|路由|重试|缓存|配置|功能)(?:[^，。！？\n]{0,18}(?:实现|逻辑|策略)))|\brepo(?:sitory)?\b|\bcodebase\b|\bworking tree\b|\bsource code\b|\bline numbers?\b|\bcurrent implementation\b)/iu.test(request);
  const noSynthesis = /(?:不(?:用|要|需要)?|无需|别)(?:再)?(?:汇总|综合)|只(?:看|要|给)(?:各自的?)?原(?:始回)?答|\b(?:no synthesis|raw answers only|without synthesis|(?:do not|don['’]t) synthesize)\b/iu.test(request);
  const choice = /(?:怎么选|如何选|该选|选哪|选型|取舍|权衡|优劣|哪个方案|哪种方案|(?:推荐|建议|倾向|更适合)(?:用|选)?哪|哪(?:个|种|一个).{0,6}更(?:好|合适|适合)|(?:推荐|该选|建议用)[^，。！？\n]{1,40}还是|\bwhich (?:one|option|approach|strategy|would you|should|is (?:better|preferable))\b|\bwould you (?:choose|recommend|prefer)\b|\btrade[- ]offs?\b)/iu.test(request);
  const alternatives = /(?:还是|或是|或者|和|与|两种|两个方案|\b(?:vs\.?|versus|or|either|between)\b)/iu.test(request);
  const constraints = /(?:优先|约束|风险|回滚|预算|延迟|代价|成本|一致性|兼容性|窗口|\b(?:budget|cost|risk|rollback|constraint|latency|compatibility)\b)/iu.test(request);
  const lookup = /(?:目前|当前|现在|实际)(?:代码|项目|仓库)?(?:里|中)?(?:到底)?(?:实现|使用|用|采用|走|配)(?:了|的|着)?(?:是)?哪|\bwhich .{0,40}(?:currently (?:use|implement)|is (?:currently )?(?:used|implemented))\b/iu.test(request);
  const comparison = lookup ? 'direct' : choice && alternatives && constraints ? 'compare' : choice && (alternatives || constraints) ? 'uncertain' : 'direct';
  const resumeSpeaker = /(?:继续|接着|沿用|刚才|上一轮|上一个回答|\bcontinue\b|\bprevious answer\b|\byour last (?:answer|response)\b)/iu.test(request);
  const supplied = /(?:只|仅)(?:需)?(?:根据|看|用)(?:下面|下方|以下|贴出|给出|提供)的?(?:代码|材料|片段)|\b(?:use|based on) only (?:the )?(?:provided|pasted|following)\b/iu.test(request);
  return { request, repo: (repo || (lookup && /代码|项目|仓库/u.test(request))) && !supplied, noSynthesis, resumeSpeaker, count: requestedCount(request), comparison };
}

/** Bind names to the speaker instruction. Names in the subject of the question are ordinary text. */
export function requestedTargets(request: string, targets: ModelTarget[]) {
  const aliases = new Map<string, ModelTarget | null>();
  for (const target of targets) {
    for (const name of [target.label, ...(target.id === 'gemini-pro' ? ['Gemini'] : [])]) {
      const key = name.trim().toLowerCase();
      if (key) aliases.set(key, aliases.has(key) && aliases.get(key) !== target ? null : target);
    }
  }
  for (const target of targets) aliases.set(target.id.toLowerCase(), target);
  const include = new Set<string>();
  const exclude = new Set<string>();
  if (!aliases.size) return { include, exclude };
  const escaped = [...aliases.keys()].sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const name = `(?<![a-z0-9_./-])(?:${escaped.join('|')})(?![a-z0-9_/-])`;
  const separator = String.raw`\s*(?:[、,，&+]|和|跟|与|以及|\band\b)\s*`;
  const lists = new RegExp(`${name}(?:${separator}${name})*`, 'giu');
  for (const list of request.matchAll(lists)) {
    const before = request.slice(0, list.index);
    const after = request.slice(list.index + list[0].length);
    const verb = /(?:调用|使用|交给|用|由|让|找|问|请|\bask|\buse|\bconsult)\s*$/iu.exec(before);
    const answering = /^\s*(?:来|帮我)?(?:分别|各自|独立|并行|单独|回答|作答|分析|评估|审查|解释|看看|检查|翻译|总结|比较|评审|给意见|\b(?:should|to) (?:answer|review|explain|compare|check|translate|summarize)\b)/iu.test(after);
    const end = /^\s*(?:$|[，,。.!！：:]|\bonly\b)/u.test(after);
    if (!verb && !(answering && /(?:^|[，,。.!！]\s*|\bonly\s+)$/iu.test(before.trimStart()))) continue;
    if (verb && !answering && !end && !/(?:交给|让|(?:只|仅)(?:用|找|问|请))\s*$|\b(?:ask|consult)\s*$/iu.test(before)) continue;
    if (verb && howToPrefix.test(before.slice(0, verb.index))) continue;
    const negated = verb && negativePrefix.test(before.slice(0, verb.index));
    for (const match of list[0].matchAll(new RegExp(name, 'giu'))) {
      const target = aliases.get(match[0].toLowerCase());
      if (!target) throw new Error(`模型名称 ${match[0]} 对应多个目标，请使用目标 ID`);
      (negated ? exclude : include).add(target.id);
    }
  }
  return { include, exclude };
}

/** Prefer distinct providers, then distinct configured models from the same provider. */
export function independentTargets(preferred: ModelTarget[], pool: ModelTarget[], count: number) {
  const selected = [...preferred];
  while (selected.length < count) {
    const remaining = pool.filter(t => selected.every(other => !sameModel(t, other)));
    const next = remaining.find(t => selected.every(other => other.adapter.id !== t.adapter.id)) ?? remaining[0];
    if (!next) break;
    selected.push(next);
  }
  return selected;
}
