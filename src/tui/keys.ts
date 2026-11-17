export interface Key {
  /** 'char' | 'paste' | 'enter' | 'altenter' | 'backspace' | 'delete' | 'tab' | 'shifttab' | 'esc'
   *  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pgup' | 'pgdn' | 'ctrl+<letter>' */
  name: string;
  text?: string;
  /** Screen cell of a mouse event ('wheelup' | 'wheeldown' | 'click'), 0-based. */
  x?: number;
  y?: number;
}

const CSI_LETTER: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shifttab',
};
const CSI_TILDE: Record<number, string> = { 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete', 5: 'pgup', 6: 'pgdn' };

/** Turns raw-mode stdin chunks into keys. Bracketed pastes arrive as a single 'paste'. */
export class KeyParser {
  private paste: string | null = null;

  feed(s: string): Key[] {
    const out: Key[] = [];
    let i = 0;
    while (i < s.length) {
      if (this.paste !== null) {
        const end = s.indexOf('\x1b[201~', i);
        if (end < 0) {
          this.paste += s.slice(i);
          break;
        }
        out.push({ name: 'paste', text: this.paste + s.slice(i, end) });
        this.paste = null;
        i = end + 6;
        continue;
      }
      const rest = s.slice(i);
      if (rest.startsWith('\x1b[200~')) {
        this.paste = '';
        i += 6;
        continue;
      }
      const ch = rest[0];
      if (ch === '\x1b') {
        if (rest.length === 1) {
          out.push({ name: 'esc' });
          i += 1;
          continue;
        }
        if (rest[1] === '\r' || rest[1] === '\n') {
          out.push({ name: 'altenter' });
          i += 2;
          continue;
        }
        const m = /^\x1b(?:\[([0-9;?<]*)([@-~])|O([A-Z]))/.exec(rest);
        if (m && m[1]?.startsWith('<')) {
          // SGR mouse report: ESC [ < button ; x ; y (M press | m release)
          const [b, x, y] = m[1].slice(1).split(';').map(Number);
          const at = { x: x - 1, y: y - 1 };
          if (b & 64) out.push({ name: b & 1 ? 'wheeldown' : 'wheelup', ...at });
          else if (m[2] === 'M' && (b & 35) === 0) out.push({ name: 'click', ...at });
          i += m[0].length;
          continue;
        }
        if (m) {
          const final = m[2] ?? m[3];
          const name = final === '~' ? CSI_TILDE[parseInt(m[1], 10)] : CSI_LETTER[final];
          if (name) out.push({ name });
          i += m[0].length;
          continue;
        }
        i += 2; // Alt+<key>: ignored
        continue;
      }
      if (ch === '\r') out.push({ name: 'enter' });
      else if (ch === '\t') out.push({ name: 'tab' });
      else if (ch === '\x7f' || ch === '\b') out.push({ name: 'backspace' });
      else if (ch < ' ') out.push({ name: `ctrl+${String.fromCharCode(ch.charCodeAt(0) + 96)}` });
      else {
        let j = i;
        while (j < s.length && s[j] >= ' ' && s[j] !== '\x7f') j++;
        out.push({ name: 'char', text: s.slice(i, j) });
        i = j;
        continue;
      }
      i += 1;
    }
    return out;
  }
}
