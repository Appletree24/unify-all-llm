import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../core/atomic-write.js';
import { newRunId } from '../core/store.js';
import { detectTargets } from '../core/targets.js';
import type { ModelTarget } from '../core/types.js';
import { formatQuota, readTargetQuotas, type TargetQuota } from '../quota/index.js';
import { findCollection, publishedIds, readCatalog } from './catalog.js';
import { read } from './storage.js';
import type { BenchResult } from './workflow.js';

const sampleSchema = z.object({ caseId: z.string(), setup: z.string(), status: z.enum(['pass', 'fail', 'error']), durationMs: z.number().nonnegative() });
const batchSchema = z.array(sampleSchema);
const directory = (cwd: string) => join(cwd, '.unify', 'bench', 'results');
const setupKey = (t: ModelTarget) => createHash('sha256').update(JSON.stringify([t.id, t.adapter.id, t.model,
  t.reasoningEffort, t.adapter.configuration])).digest('hex');

export function recordBenchResults(cwd: string, rows: BenchResult[], targets: ModelTarget[]) {
  const setups = new Map(targets.map(t => [t.id, setupKey(t)]));
  const data = rows.map(r => ({ caseId: r.caseId, setup: setups.get(r.target), status: r.status, durationMs: r.durationMs }));
  const dir = directory(cwd);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, newRunId() + '.json'), JSON.stringify(data));
}

function quotaCapacity(row?: TargetQuota): { quota: string; remainingPercent: number | null } {
  const unknown = { quota: 'unknown', remainingPercent: null };
  if (row?.reading.status !== 'ok' || !row.reading.limits.length) return unknown;
  const all = row.reading.limits;
  const matching = all.filter(l => row.model && (l.label === row.model || l.label.startsWith(row.model + ' · ')));
  const global = all.filter(l => !l.label.includes(' · ') || l.label.toLowerCase().startsWith(row.provider?.toLowerCase() + ' · '));
  const limits = [...new Set([...global, ...matching])];
  if (!limits.length) return all.every(l => l.remaining <= 0) ? { quota: 'exhausted', remainingPercent: 0 } : unknown;
  const fractions = limits.flatMap(l => l.unit === '%' ? [l.remaining] : l.total && l.total > 0 ? [100 * l.remaining / l.total] : []);
  const remainingPercent = fractions.length ? Math.min(...fractions) : null;
  const depleted = remainingPercent !== null ? remainingPercent <= 0 : limits.every(l => l.remaining <= 0);
  return { quota: depleted ? 'exhausted' : 'available', remainingPercent };
}

export function rankTargets(cwd: string, targets: ModelTarget[], available: ReadonlyMap<string, boolean>, quotas: TargetQuota[], collection?: string) {
  const catalog = readCatalog(cwd);
  const cases = new Set(collection ? findCollection(catalog.collections, collection).caseIds : publishedIds(cwd, catalog));
  const dir = directory(cwd);
  const latest = new Map<string, Map<string, z.infer<typeof sampleSchema>>>();
  for (const file of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : []) {
    for (const sample of batchSchema.parse(read(join(dir, file)))) {
      if (!cases.has(sample.caseId)) continue;
      const byCase = latest.get(sample.setup) ?? new Map();
      byCase.set(sample.caseId, sample);
      latest.set(sample.setup, byCase);
    }
  }
  const rows = targets.map(t => {
    const samples = [...(latest.get(setupKey(t))?.values() ?? [])];
    const times = samples.map(r => r.durationMs).sort((a,b) => a-b);
    const q = quotas.find(q => q.targetId === t.id);
    const { quota, remainingPercent } = quotaCapacity(q);
    const passed = samples.filter(s => s.status === 'pass').length;
    const errors = samples.filter(s => s.status === 'error').length;
    const mid = Math.floor(times.length / 2);
    return { target: t.id, eligible: !!available.get(t.id) && quota !== 'exhausted', installed: !!available.get(t.id), quota, remainingPercent,
      quotaText: q ? formatQuota(q.reading).join(' · ') : '未知', passed, samples: samples.length, errors,
      medianMs: times.length ? (times[mid] + times[Math.floor((times.length - 1) / 2)]) / 2 : null };
  });
  const score = (r: typeof rows[number]) => (r.passed + 1) / (r.samples + 2);
  rows.sort((a,b) => Number(b.eligible) - Number(a.eligible) || Number(b.passed > 0) - Number(a.passed > 0)
    || score(b) - score(a) || Number(b.quota === 'available') - Number(a.quota === 'available')
    || (b.remainingPercent ?? -1) - (a.remainingPercent ?? -1)
    || (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity) || a.target.localeCompare(b.target));
  return { recommended: rows.find(r => r.eligible && r.passed > 0)?.target ?? null, caseCount: cases.size, rows };
}

export async function recommend(cwd: string, targets: ModelTarget[], signal: AbortSignal, collection?: string) {
  const [installed, quotas] = await Promise.all([detectTargets(targets, signal), readTargetQuotas(targets, cwd, signal)]);
  signal.throwIfAborted();
  return rankTargets(cwd, targets, installed, quotas, collection);
}

export function recommendationLabel(r: ReturnType<typeof rankTargets>['rows'][number]) {
  return [r.target, '通过 ' + r.passed + '/' + r.samples, r.errors ? '运行错误 ' + r.errors : '',
    r.medianMs === null ? '' : '中位 ' + (r.medianMs / 1000).toFixed(1) + 's',
    !r.installed ? '不可用' : r.quota === 'exhausted' ? '额度用尽' : ''].filter(Boolean).join(' · ');
}
