import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Token } from 'marked';
import { answerPassages } from '../../../src/core/answer-passages.js';
import { synthesisFormatter } from '../../../src/core/synth.js';
import type { RunRecord } from '../shared/api.js';
import { renderMarkdown } from './markdown.js';
import { Markdown, MarkdownBody } from './ui.js';

interface Source {
  name: string;
  blocks: Token[];
  passage?: number;
}
type BlockCache = Map<string, { text: string; blocks: Token[] }>;

function citationsIn(text: string, record: RunRecord, cache: BlockCache) {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(text);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a, button, code, pre, textarea')) nodes.push(node);
  }

  const format = synthesisFormatter(record);
  const citations: Source[] = [];
  for (const node of nodes) {
    let end = 0;
    const fragment = document.createDocumentFragment();
    format(node.data, (ref, raw, offset) => {
      const answer = record.results.find(r => r.targetId === ref.targetId && r.ok && r.text.trim());
      if (!answer) return raw;
      let source = cache.get(answer.targetId);
      if (!source || source.text !== answer.text) {
        const blocks = answerPassages(answer.text).filter(p => p.number !== undefined).map(p => p.token);
        source = { text: answer.text, blocks };
        cache.set(answer.targetId, source);
      }
      const block = ref.passage === undefined ? undefined : source.blocks[ref.passage - 1];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source-ref';
      button.dataset.unifyCitation = String(citations.length);
      button.textContent = block ? `${ref.name} · 第${ref.passage}段` : ref.name;
      const destination = block ? `第${ref.passage}段` : '完整回答';
      button.setAttribute('aria-label', `查看 ${ref.name} 的${destination}`);
      button.title = block ? destination + ' · ' + block.raw.trim().replace(/\s+/g, ' ').slice(0, 150) : destination;
      citations.push({ name: ref.name, blocks: source.blocks, passage: block ? ref.passage : undefined });
      fragment.append(node.data.slice(end, offset), button);
      end = offset + raw.length;
      return raw;
    });
    if (end) {
      fragment.append(node.data.slice(end));
      node.replaceWith(fragment);
    }
  }
  return { html: template.innerHTML, citations };
}

function SourceDialog({ source, close }: { source: Source; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const title = useId();
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    highlight.current?.scrollIntoView({ block: 'start' });
    return () => el.close();
  }, []);

  return (
    <dialog ref={dialog} className="modal source-dialog" aria-labelledby={title}
      onCancel={e => { e.preventDefault(); close(); }}
      onClick={e => { if (e.target === dialog.current) close(); }}>
      <header>
        <h2 id={title}>{source.name} · 回答原文</h2>
        <button className="btn" autoFocus onClick={close} title="返回汇总 (Esc)">返回汇总</button>
      </header>
      <div className="source-body">
        {source.blocks.map((block, i) => (
          <div key={i} ref={i + 1 === source.passage ? highlight : undefined}
            className={i + 1 === source.passage ? 'source-passage cited' : 'source-passage'}>
            <Markdown text={block} />
          </div>
        ))}
      </div>
    </dialog>
  );
}

/** Keep the synthesis mounted underneath the modal, including in the expanded card. */
export function SynthesisMarkdown({ text, record }: { text: string; record: RunRecord }) {
  const cache = useRef<BlockCache>(new Map());
  const { html, citations } = useMemo(() => citationsIn(text, record, cache.current), [text, record]);
  const [source, setSource] = useState<Source>();
  return <>
    <MarkdownBody html={html} onCitation={index => setSource(citations[index])} />
    {source && <SourceDialog source={source} close={() => setSource(undefined)} />}
  </>;
}
