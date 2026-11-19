export interface QuotaContext {
  cwd: string;
  signal: AbortSignal;
}

export interface QuotaLimit {
  label: string;
  remaining: number;
  unit: string;
  total?: number;
  resetsAt?: string;
}

export type QuotaReading =
  | { status: 'ok'; limits: QuotaLimit[]; observedAt?: string }
  | { status: 'unavailable' | 'error'; message: string };

export type QuotaReader = (ctx: QuotaContext) => Promise<QuotaReading>;

export interface TargetQuota {
  targetId: string;
  label: string;
  provider: string;
  model?: string;
  checkedAt: string;
  reading: QuotaReading;
}
