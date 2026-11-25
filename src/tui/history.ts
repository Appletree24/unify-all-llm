import { isReviewOrReport, roleNames } from '../core/collaboration.js';
import { loadRunRecap, type RunRecord } from '../core/store.js';
import type { RunResult } from '../core/types.js';
import { formatMemoryReferences } from '../memory/report.js';
import { synthesisText } from './answer-source.js';
import type { Key } from './keys.js';
import { layout, wrap } from './markdown.js';
import { rgb, toCells, truncate, type Cell, type Screen } from './screen.js';

const GOLD = rgb(232, 196, 104);
const DIM = rgb(120, 125, 135);
const statusNames: Partial<Record<RunRecord['status'], string>> = {
  completed: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '中断',
};

export function historyEntries(runs: RunRecord[]) {
  const comparisonNumbers = new Map<string, number>();
  return runs.map(run => {
    if (run.kind === 'comparison') comparisonNumbers.set(run.id, comparisonNumbers.size + 1);
    const comparison = run.kind === 'execution' ? run.planSource?.turnId ?? run.parentTurnId : run.id;
    const n = comparison && comparisonNumbers.get(comparison);
    const kind = run.kind === 'execution' ? ` · ${roleNames.execution}` : run.retryOf ? ' · 重试' : '';
    const title = n ? `第 ${n} 轮${kind}` : roleNames.execution;
    const time = run.createdAt.slice(0, 16).replace('T', ' ');
    return { run, title, detail: `${time} · ${statusNames[run.status] ?? run.status}` };
  });
}

type HistoryEntry = ReturnType<typeof historyEntries>[number];
type SynthesisContext = { text: string; synthesis: ReturnType<typeof synthesisText> };

function renderTurn(cwd: string, run: RunRecord, width: number, showReasoning: boolean) {
  const lines: Cell[][] = [];
  const heading = (title: string) => {
    if (lines.length) lines.push([]);
    lines.push(...wrap(toCells(title, `1;${GOLD}`), width));
  };
  const label = (r: RunResult) => run.calls.find(c => c.id === r.runId)?.target.label
    ?? run.targets.find(t => t.id === r.targetId)?.label ?? r.targetId;
  const result = (title: string, r: RunResult, context?: SynthesisContext) => {
    heading(title);
    const start = lines.length;
    if (showReasoning && r.reasoning.trim()) lines.push(...layout(r.reasoning.trim(), width, GOLD, true, context?.synthesis.cells), []);
    const body = r.text + formatMemoryReferences(r.memoryReferences);
    if (body.trim()) lines.push(...layout(body, width, GOLD, false, context?.synthesis.cells));
    const end = lines.length;
    if (r.error) lines.push(...layout(`✗ ${r.error}`, width, GOLD));
    else if (!body.trim()) lines.push(toCells('（无正文）', DIM));
    return { start, end, context };
  };

  heading('问题');
  lines.push(...layout(run.question, width, GOLD));
  for (const r of run.results) {
    result(`${run.kind === 'execution' ? roleNames.execution : '回答'} · ${label(r)}`, r);
  }
  const synthesis = run.synthesis?.result;
  const cited = synthesis && result(`汇总 · ${label(synthesis)}`, synthesis, { text: synthesis.text, synthesis: synthesisText(run) });
  for (const call of run.calls) {
    if (!isReviewOrReport(call.scope)) continue;
    const stage = call.scope === 'plan-review' ? roleNames.check : call.scope === 'result-review' ? roleNames.audit : roleNames.report;
    result(`${stage} · ${call.target.label}`, call.result);
  }
  if (run.error) {
    heading('运行错误');
    lines.push(...layout(`✗ ${run.error}`, width, GOLD));
  }
  const recap = loadRunRecap(cwd, run.id);
  if (recap) {
    heading('回顾');
    lines.push(...layout(recap, width, GOLD));
  }
  return { lines, cited };
}

/** A read-only view over the recorded turns of the active session. */
export class HistoryView {
  private top = 0;
  private page = 1;
  private document?: ReturnType<typeof renderTurn> & { width: number };

  constructor(private readonly cwd: string, private readonly entries: HistoryEntry[], private index: number,
    private readonly showReasoning: boolean) {}

  get hasNewerEntry(): boolean { return this.index + 1 < this.entries.length; }

  synthesisAt(y: number): SynthesisContext | undefined {
    const row = y - 2 + this.top;
    const cited = this.document?.cited;
    if (cited && row >= cited.start && row < cited.end) return cited.context;
  }

  handleKey(key: Key): void {
    switch (key.name) {
      case 'left': case 'right': {
        const next = this.index + (key.name === 'left' ? -1 : 1);
        if (next >= 0 && next < this.entries.length) {
          this.index = next;
          this.top = 0;
          this.document = undefined;
        }
        break;
      }
      case 'up': this.top--; break;
      case 'down': this.top++; break;
      case 'wheelup': this.top -= 3; break;
      case 'wheeldown': this.top += 3; break;
      case 'pgup': this.top -= this.page; break;
      case 'pgdn': this.top += this.page; break;
      case 'home': this.top = 0; break;
      case 'end': this.top = this.document?.lines.length ?? 0; break;
    }
  }

  draw(s: Screen): void {
    const { run, title, detail } = this.entries[this.index];
    const width = s.cols - 2;
    if (this.document?.width !== width) this.document = { ...renderTurn(this.cwd, run, width, this.showReasoning), width };
    const { lines } = this.document;
    this.page = s.rows - 3;
    this.top = Math.max(0, Math.min(this.top, lines.length - this.page));
    s.put(1, 0, truncate(`${title} (${this.index + 1}/${this.entries.length + 1})`, width), `1;${GOLD}`);
    s.put(1, 1, truncate(detail, width), DIM);
    lines.slice(this.top, this.top + this.page).forEach((line, i) => s.putCells(1, i + 2, line, s.cols - 1));
    s.put(1, s.rows - 1, truncate('←→ 切换 · ↑↓ 滚动 · Esc 回最新', width), DIM);
  }
}
