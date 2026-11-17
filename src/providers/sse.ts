/** Decode SSE across arbitrary UTF-8 chunks, CR/LF variants, and multiline data fields. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  function line(value: string): string | undefined {
    if (!value) {
      if (!data.length) return;
      const event = data.join('\n');
      data = [];
      return event;
    }
    if (value === 'data') data.push('');
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!chunk.done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const event = line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (event !== undefined) yield event;
      }
      if (buffer.length > 4 * 1024 * 1024 || data.join('').length > 4 * 1024 * 1024) throw new Error('SSE 事件超出 4 MiB');
      if (chunk.done) {
        if (buffer) line(buffer);
        const event = line('');
        if (event !== undefined) yield event;
        return;
      }
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
