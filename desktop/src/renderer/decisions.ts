import { Lexer, type Tokens } from 'marked';
import { synthesisFormatter } from '../../../src/core/synth.js';
import type { InteractionQuestion, RunRecord, RunResultRecord } from '../shared/api.js';
import { decisionHeading } from '../shared/decision-format.js';

export interface QuestionGroup {
  id: string;
  label: string;
  detail?: string;
  questions: InteractionQuestion[];
}

function plainLabel(text: string) {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}

// Only interpret a question heading followed by a list inside the decision section.
// Markdown's block lexer keeps examples inside fences or quotations out of the form.
function readQuestions(text: string): InteractionQuestion[] {
  if (!text.includes(decisionHeading)) return [];
  const blocks = Lexer.lex(text).filter(block => block.type !== 'space');
  const questions: InteractionQuestion[] = [];
  let inSection = false;
  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'heading') continue;
    if (block.depth <= 2) {
      inSection = block.depth === 2 && plainLabel(block.text) === decisionHeading;
      continue;
    }
    const list = blocks[index + 1];
    if (!inSection || block.depth !== 3 || list?.type !== 'list') continue;
    const options = (list as Tokens.List).items.map(item => {
      const [label, ...details] = plainLabel(item.text).split(/[｜|]/);
      return { label: label.trim(), description: details.join('｜').trim() };
    });
    if (options.length < 2 || options.some(o => !o.label)) continue;
    const heading = plainLabel(block.text);
    const multi = /[（(](?:可多选|多选)[）)]$/;
    questions.push({ id: String(index), question: heading.replace(multi, '').trim(), options, multiSelect: multi.test(heading), allowOther: true });
  }
  return questions;
}

export function decisionGroups(record: RunRecord, fromTarget?: string): QuestionGroup[] {
  const group = (result: RunResultRecord, label: string, text = result.text): QuestionGroup[] => {
    const questions = readQuestions(text);
    return questions.length ? [{ id: result.runId, label, questions }] : [];
  };
  if (!fromTarget) {
    const review = record.calls.find(c => c.scope === 'plan-review' && c.result.ok && c.result.text.trim());
    if (review) return group(review.result, '方案复核');
    const synthesis = record.synthesis?.result;
    if (synthesis?.ok && synthesis.text.trim()) return group(synthesis, '汇总', synthesisFormatter(record)(synthesis.text));
  }
  return record.results.filter(r => r.ok && (!fromTarget || r.targetId === fromTarget)).flatMap(r =>
    group(r, record.targets.find(t => t.id === r.targetId)?.label ?? r.targetId));
}
