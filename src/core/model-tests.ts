import { timeoutMillis } from './config.js';
import { runOne } from './orchestrator.js';
import type { ModelTarget } from './types.js';

export interface ModelTestState {
  status: 'testing' | 'passed' | 'failed';
  message: string;
}

interface Check {
  state: ModelTestState;
  pending?: Promise<void>;
}

/** Manual checks use the same resolved target and ask adapter as a conversation. */
export class ModelTests {
  private checks = new Map<ModelTarget, Check>();
  private controller = new AbortController();

  constructor(private cwd: string, private changed: () => void) {}

  state(target: ModelTarget): ModelTestState | undefined {
    return this.checks.get(target)?.state;
  }

  run(target: ModelTarget, timeoutSec = 60): Promise<void> {
    const pending = this.checks.get(target)?.pending;
    if (pending) return pending;
    const signal = this.controller.signal;
    const check: Check = { state: { status: 'testing', message: '测试中…' } };
    this.checks.set(target, check);
    check.pending = runOne(target, {
      cwd: this.cwd, mode: 'ask', prompt: '请只回复 OK，无需使用工具。', timeoutMs: timeoutMillis(timeoutSec), signal,
    }).then(result => {
      check.state = result.ok && result.text.trim()
        ? { status: 'passed', message: `测试通过 · ${(result.durationMs / 1000).toFixed(1)} 秒` }
        : { status: 'failed', message: result.error || '模型未返回回答正文' };
    }).finally(() => {
      check.pending = undefined;
      if (!signal.aborted) this.changed();
    });
    this.changed();
    return check.pending;
  }

  async reset(): Promise<void> {
    const pending = [...this.checks.values()].flatMap(check => check.pending ? [check.pending] : []);
    this.controller.abort();
    this.controller = new AbortController();
    this.checks.clear();
    await Promise.all(pending);
  }
}
