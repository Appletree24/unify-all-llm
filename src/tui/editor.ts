import { charWidth } from './screen.js';

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/** The composer's text buffer: code points plus a caret, with readline-style editing. */
export class Editor {
  chars: string[] = [];
  caret = 0;

  get text(): string { return this.chars.join(''); }
  get empty(): boolean { return this.chars.length === 0; }

  set(text: string): void {
    this.chars = Array.from(text);
    this.caret = this.chars.length;
  }

  clear(): void { this.set(''); }

  insert(text: string): void {
    const add = Array.from(text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')).filter((c) => c === '\n' || charWidth(c.codePointAt(0)!) > 0);
    this.chars.splice(this.caret, 0, ...add);
    this.caret += add.length;
  }

  /** Replace the code points in [start, end) and leave the caret after the new text. */
  replace(start: number, end: number, text: string): void {
    const add = Array.from(text);
    this.chars.splice(start, end - start, ...add);
    this.caret = start + add.length;
  }

  private lineStart(at = this.caret): number {
    while (at > 0 && this.chars[at - 1] !== '\n') at--;
    return at;
  }

  private lineEnd(at = this.caret): number {
    while (at < this.chars.length && this.chars[at] !== '\n') at++;
    return at;
  }

  private wordLeftFrom(at: number): number {
    while (at > 0 && !isWord(this.chars[at - 1])) at--;
    while (at > 0 && isWord(this.chars[at - 1])) at--;
    return at;
  }

  private wordRightFrom(at: number): number {
    while (at < this.chars.length && !isWord(this.chars[at])) at++;
    while (at < this.chars.length && isWord(this.chars[at])) at++;
    return at;
  }

  left(): void { this.caret = Math.max(0, this.caret - 1); }
  right(): void { this.caret = Math.min(this.chars.length, this.caret + 1); }
  home(): void { this.caret = this.lineStart(); }
  end(): void { this.caret = this.lineEnd(); }
  wordLeft(): void { this.caret = this.wordLeftFrom(this.caret); }
  wordRight(): void { this.caret = this.wordRightFrom(this.caret); }

  backspace(): void { if (this.caret > 0) this.chars.splice(--this.caret, 1); }
  del(): void { this.chars.splice(this.caret, 1); }
  deleteWordBack(): void { this.replace(this.wordLeftFrom(this.caret), this.caret, ''); }
  deleteWordForward(): void { this.replace(this.caret, this.wordRightFrom(this.caret), ''); }
  killToStart(): void { this.replace(this.lineStart(), this.caret, ''); }

  /** Kill to the end of the line; at the end of a line, join it with the next. */
  killToEnd(): void {
    const end = this.lineEnd();
    this.replace(this.caret, end === this.caret ? Math.min(this.chars.length, end + 1) : end, '');
  }

  /** Move one logical line up or down, keeping the column. False at the first or last line. */
  vertical(dir: -1 | 1): boolean {
    const start = this.lineStart();
    const col = this.caret - start;
    if (dir < 0) {
      if (start === 0) return false;
      const prev = this.lineStart(start - 1);
      this.caret = Math.min(prev + col, start - 1);
    } else {
      const end = this.lineEnd();
      if (end === this.chars.length) return false;
      this.caret = Math.min(end + 1 + col, this.lineEnd(end + 1));
    }
    return true;
  }
}
