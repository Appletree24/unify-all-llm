import { z } from 'zod';
import type { RunRecord } from './store.js';

const role = z.strictObject({
  target: z.string().regex(/^[a-z][\w-]*$/i),
  label: z.string().trim().min(1).max(40).optional(),
});
const point = z.strictObject({ x: z.number(), y: z.number() });
const layoutSchema = z.strictObject({
  offsets: z.record(z.string().regex(/^(start|plan-[0-2]|merge|check|confirm|execution|audit|report|end)$/), point),
  pan: point,
});
export type GraphLayout = z.infer<typeof layoutSchema>;
export const collaborationSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  plans: z.array(role).min(1).max(3),
  merge: role.optional(),
  check: role.optional(),
  execution: role,
  audit: role.optional(),
  report: role.optional(),
  layout: layoutSchema.optional(),
}).refine(g => new Set(g.plans.map(p => p.target)).size === g.plans.length, '并行分支需要不同目标')
  .refine(g => (g.plans.length > 1) === !!g.merge, '多个方案需要一个比较节点');
export type Collaboration = z.infer<typeof collaborationSchema>;
export type GraphRole = z.infer<typeof role>;
export type GraphStep = 'plan' | 'merge' | 'check' | 'confirm' | 'execution' | 'audit' | 'report';
export const roleNames: Record<GraphStep, string> = {
  plan: '制定方案', merge: '方案比较', check: '方案复核', confirm: '本人确认', execution: '实施', audit: '实施复核', report: '结果汇报',
};

export function isReviewOrReport(scope: string): scope is 'plan-review' | 'result-review' | 'report' {
  return scope === 'plan-review' || scope === 'result-review' || scope === 'report';
}

export function graphStages(graph: Collaboration): GraphStep[] {
  const stages: GraphStep[] = ['plan'];
  if (graph.merge) stages.push('merge');
  if (graph.check) stages.push('check');
  stages.push('confirm', 'execution');
  if (graph.audit) stages.push('audit');
  if (graph.report) stages.push('report');
  return stages;
}

export function graphIssue(graph: Collaboration, targets: readonly { id: string; installed?: boolean; exec: boolean }[]): string | undefined {
  for (const stage of graphStages(graph)) {
    if (stage === 'confirm') continue;
    for (const role of stage === 'plan' ? graph.plans : [graph[stage]!]) {
      const target = targets.find(t => t.id === role.target);
      if (!target || target.installed === false) return `${role.label ?? roleNames[stage]} 的目标 ${role.target} 未接入，请更换模型或接入该目标`;
      if (stage === 'execution' && !target.exec) return `${role.target} 不支持实施，请更换执行模型`;
    }
  }
}

/** The confirmation gate consumes exactly the last planned node. */
export function graphPlanResult(record: RunRecord) {
  const graph = record.collaboration;
  if (!graph || record.kind !== 'comparison' || record.collaborationClosed || record.status !== 'completed') return;
  const result = graph.check ? record.calls.find(c => c.scope === 'plan-review')?.result
    : graph.merge ? record.synthesis?.result : record.results[0];
  return result?.ok && result.text.trim() ? result : undefined;
}
