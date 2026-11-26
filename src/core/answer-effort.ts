import type { AnswerEffort, ReasoningEffort } from './config.js';
import type { ModelTarget } from './types.js';
import { effortChoices } from '../providers/effort.js';
import { effortInId, isAgyProvider, type AgyModel } from '../providers/agy-models.js';

export type EffortIntent = { level: ReasoningEffort; exact: boolean } | undefined;

export function requestedEffort(request: string): EffortIntent {
  const levels = 'none|minimal|low|medium|high|xhigh|max|ultra';
  const exact = new RegExp(
    String.raw`(?:使用|设为|设成|调到|切到|用|开|\buse\s+|\bset\s+(?:effort\s+)?to\s+|(?:思考强度|推理强度|thinking level|reasoning effort|\beffort)\s*[:：=]?)\s*(${levels})(?![a-z0-9_-])`, 'giu');
  let chosen: ReasoningEffort | undefined;
  for (const match of request.matchAll(exact)) {
    const before = request.slice(0, match.index);
    if (/(?:不要|不用|别|不|不需要|怎么|如何|怎样|\bdo not|\bdon['’]t|\bhow (?:to|(?:do|can|should) (?:i|we)))(?:把?(?:思考|推理)强度)?\s*$/iu.test(before)) continue;
    // “Use high availability” describes the subject, while “use high effort” sets a level.
    if (/^use\b/iu.test(match[0])) {
      const after = request.slice(match.index + match[0].length).trimStart();
      if (after && !/^(?:[,.:;!?，。！？]|(?:(?:reasoning|thinking)\s+)?(?:effort|level)\b)/iu.test(after)) continue;
    }
    chosen = match[1].toLowerCase() as ReasoningEffort;
  }
  if (chosen) return { level: chosen, exact: true };

  const positive = (pattern: RegExp) => [...request.matchAll(pattern)].some(match =>
    !/(?:不要|不用|无需|别|不需要|不|\bdo not|\bdon['’]t|\bno need to)\s*$/iu.test(request.slice(0, match.index)));
  const speedFirst = positive(/速度优先|优先(?:考虑|保证)?速度|\bprioriti[sz]e speed\b/giu);
  const depthFirst = positive(/(?:深度|质量)优先|优先(?:考虑|保证)?(?:推理深度|分析深度|质量)|\bprioriti[sz]e (?:depth|quality)\b/giu);
  if (speedFirst || depthFirst) return speedFirst === depthFirst ? undefined : { level: speedFirst ? 'low' : 'high', exact: false };
  const depth = positive(/深入(?:地)?(?:推演|检查|分析|思考|排查|审查|研究|核验)|仔细(?:检查|推演|核验)|认真核验|多花(?:一点|点)?时间|\bthink (?:hard|deeply)|\b(?:analy[sz]e|investigate|review|verify) (?:in depth|thoroughly)\b/giu);
  const speed = positive(/尽快|(?:先)?快速(?:给|判断|回答|看|检查)|先.{0,6}(?:粗判|初判)|\b(?:quick (?:take|assessment)|answer quickly)\b/giu);
  if (depth === speed) return undefined;
  return { level: depth ? 'high' : 'low', exact: false };
}

export function resolveAnswerEffort(target: ModelTarget, policy: AnswerEffort, intent: EffortIntent, catalog: AgyModel[], pinnedTarget = false) {
  const agy = isAgyProvider(target.adapter.id, target.adapter.capabilities.askPolicy);
  const current = catalog.find(entry => entry.id === target.model);
  const native = agy ? effortInId(target.model) : target.defaultEffort;
  const desired = policy === 'auto' ? intent : policy === 'default' || policy === 'target' ? undefined : { level: policy, exact: true };
  let model = target.model;
  let effort = policy === 'target' ? target.reasoningEffort : undefined;
  let reason = policy === 'target' ? '按目标设置' : '沿用原生设置';
  if (desired) {
    const { level, exact } = desired;
    const variant = current && catalog.find(entry => entry.family === current.family && entry.effort === level);
    const baseline = target.reasoningEffort ?? native;
    if (!exact && level === 'high' && baseline && ['high', 'xhigh', 'max', 'ultra'].includes(baseline)) {
      effort = target.reasoningEffort;
      reason = '原档位已满足深度要求';
    } else if (agy ? variant || native === level : effortChoices(target, !(pinnedTarget && target.adapter.id === 'codex')).includes(level)) {
      if (agy) model = variant?.id ?? model;
      else effort = level;
      reason = policy !== 'auto' ? '锁定强度' : exact ? '本轮指定强度' : level === 'low' ? '本轮优先速度' : '本轮要求深入检查';
    } else if (exact) {
      return undefined;
    } else {
      reason = '该档位不可用，沿用原生设置';
    }
  }
  const configured = target.adapter.configuration;
  return {
    target: { ...target, model, reasoningEffort: effort },
    choice: { targetId: target.id, model: model ?? (configured?.type === 'openai' ? configured.model : undefined),
      level: agy ? effortInId(model) : effort, reason },
  };
}
