import type { RunRecord } from '../core/store.js';
import { synthesisFormatter } from '../core/synth.js';
import type { WorkflowEvent } from '../core/workflow.js';

/** Translate only the human-readable stream. Provider events and saved inputs stay verbatim. */
export function displaySynthesisEvents(render: (event: WorkflowEvent) => void) {
  let format: ((text: string) => string) | undefined;
  let labels: string[] = [];
  const pending = { reasoning: '', delta: '' };
  return (event: WorkflowEvent, record: RunRecord) => {
    if (event.type === 'call' && event.scope === 'synthesis') {
      format = synthesisFormatter(record);
      labels = Object.keys(record.synthesis?.labels ?? {});
      pending.reasoning = pending.delta = '';
    }
    if (event.type !== 'provider' || event.scope !== 'synthesis' || !format) return render(event);

    const part = event.event;
    if (part.type === 'delta' || part.type === 'reasoning') {
      // A provider can split a reference anywhere, including between its digits.
      const text = pending[part.type] + part.text;
      const start = text.lastIndexOf('[');
      const tail = start < 0 ? '' : text.slice(start);
      const incomplete = tail && labels.some((label) => label !== tail && label.startsWith(tail));
      pending[part.type] = incomplete ? tail : '';
      const ready = incomplete ? text.slice(0, start) : text;
      if (ready) render({ ...event, event: { type: part.type, text: format(ready) } });
      return;
    }
    if (part.type === 'done' || part.type === 'error') {
      for (const type of ['reasoning', 'delta'] as const) {
        if (pending[type]) render({ ...event, event: { type, text: pending[type] } });
      }
      if (part.type === 'done') return render({ ...event, event: { ...part, text: format(part.text) } });
    }
    render(event);
  };
}
