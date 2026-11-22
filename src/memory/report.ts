import type { ProviderEvent } from '../core/types.js';

export interface MemoryReference {
  source: string;
  content: string;
  effect: string;
}

const marker = (id: string) => `\n<unify-memory-${id}>`;

export function requestMemoryReport(prompt: string, id: string): string {
  return prompt + '\n\n仅当你实际依据持久记忆（如个人偏好、项目指令或跨会话记录）作出具体判断时，在最终回答后另起一行附上以下标记及 JSON 数组。'
    + '每项填写来源文件及已知行号或条目名、所用内容的简述、影响了本次回答的哪项判断。来源不详时写“来源不详”。'
    + '只报告本次自己采用的记忆，勿把对话历史、其他回答、普通项目文件或仅见过的规则列入。无需另行搜索。未使用时省略整个标记。'
    + '数组元素的三个字符串字段分别为 source（来源）、content（记忆摘要）、effect（影响的判断）。标记为：' + marker(id);
}

export function formatMemoryReferences(refs?: MemoryReference[]): string {
  if (!refs?.length) return '';
  return '\n\n### 记忆依据（模型自报）\n\n' + refs.map(r => `- ${r.source} · ${r.content}\n  影响：${r.effect}`).join('\n');
}

function splitReport(text: string, tag: string) {
  const index = text.lastIndexOf(tag);
  if (index < 0) return { text };
  try {
    const trailer = text.slice(index + tag.length).trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trailer);
    const entries: unknown = JSON.parse(fenced?.[1] ?? trailer);
    if (!Array.isArray(entries) || !entries.length) return { text };
    const refs: MemoryReference[] = [];
    for (const row of entries) {
      if (!row || ![row.source, row.content, row.effect].every(v => typeof v === 'string' && v.trim())) return { text };
      refs.push({ source: row.source.trim(), content: row.content.trim(), effect: row.effect.trim() });
    }
    return { text: text.slice(0, index).trimEnd(), memoryReferences: refs };
  } catch { return { text }; }
}

/** Keep the optional machine-readable trailer out of streamed answers, including split tags. */
export async function* collectMemoryReport(events: AsyncIterable<ProviderEvent>, id: string, prompt: string): AsyncGenerator<ProviderEvent> {
  const tag = marker(id);
  if (!prompt.endsWith(tag)) {
    yield* events;
    return;
  }
  let pending = '';
  let streamed = '';
  for await (const event of events) {
    if (event.type === 'delta') {
      streamed += event.text;
      pending += event.text;
      const start = pending.indexOf(tag);
      let keep = start < 0 ? pending.length : start;
      if (start < 0) {
        // Only a suffix beginning at the last newline can be a partial marker.
        const newline = pending.lastIndexOf('\n');
        if (newline >= 0 && tag.startsWith(pending.slice(newline))) keep = newline;
      }
      if (keep) yield { type: 'delta', text: pending.slice(0, keep) };
      pending = pending.slice(keep);
    } else if (event.type === 'done') {
      const result = splitReport(event.text || streamed, tag);
      if (pending && !result.memoryReferences && !splitReport(pending, tag).memoryReferences) {
        yield { type: 'delta', text: pending };
      }
      pending = '';
      yield { ...event, ...result };
    } else {
      yield event;
    }
  }
}
