import { Lexer, type Token, type Tokens } from 'marked';

/** Number visible Markdown blocks identically in the anonymous prompt and source reader. */
export function answerPassages(text: string) {
  const blocks = Lexer.lex(text, { gfm: true }).flatMap((token): Token[] => {
    if (token.type !== 'list') return [token];
    const list = token as Tokens.List;
    return list.items.map((item, i) => ({
      ...list, raw: item.raw, items: [item], start: typeof list.start === 'number' ? list.start + i : list.start,
    }));
  });
  let number = 0;
  return blocks.map(token => ({
    token, number: token.type === 'space' || token.type === 'def' ? undefined : ++number,
  }));
}
