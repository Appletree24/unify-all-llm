export interface Key {
  /** 'char' | 'paste' | 'enter' | 'altenter' | 'backspace' | 'delete' | 'tab' | 'shifttab' | 'esc'
   *  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pgup' | 'pgdn' | 'ctrl+<letter>' | 'cmd+c'
   *  | 'wordleft' | 'wordright' | 'wordback' | 'worddel'
   *  'altenter' is any modified Enter (Shift, Alt or Ctrl): it inserts a newline. */
  name: string;
  text?: string;
  /** Screen cell of a mouse event, 0-based. */
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

const ALT: Record<string, string> = { b: 'wordleft', f: 'wordright', d: 'worddel', '\x7f': 'wordback', '\b': 'wordback' };

/** Explicit modifiers in kitty CSI u or xterm modifyOtherKeys. Bits 1/2/4/8 are Shift/Alt/Ctrl/Super. */
function modified(code: number, mod: number): Key | undefined {
  if (!Number.isFinite(code)) return undefined;
  if (mod & 8) return mod === 8 && (code === 99 || code === 67) ? { name: 'cmd+c' } : undefined;
  if (code === 13) return { name: mod ? 'altenter' : 'enter' };
  if (code === 27) return { name: 'esc' };
  if (code === 9) return { name: mod & 1 ? 'shifttab' : 'tab' };
  if (code === 127 || code === 8) return { name: mod & 6 ? 'wordback' : 'backspace' };
  if (code < 32) return undefined;
  const ch = String.fromCodePoint(code);
  if (mod & 4) return /^[a-z]$/i.test(ch) ? { name: `ctrl+${ch.toLowerCase()}` } : undefined;
  if (mod & 2) return ALT[ch.toLowerCase()] ? { name: ALT[ch.toLowerCase()] } : undefined;
  return { name: 'char', text: ch };
}

/** Turns raw-mode stdin chunks into keys. Bracketed pastes arrive as a single 'paste'. */
export class KeyParser {
  private paste: string | null = null;
  private csiPrefix = '';

  feed(s: string): Key[] {
    s = this.csiPrefix + s;
    this.csiPrefix = '';
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
        const m = /^\x1b(?:\[([0-9;:?<]*)([@-~])|O([A-Z]))/.exec(rest);
        if (!m && /^\x1b\[[0-9;:?<]*$/.test(rest)) {
          this.csiPrefix = rest;
          break;
        }
        if (m && m[1]?.startsWith('<')) {
          // SGR mouse report: ESC [ < button ; x ; y (M press | m release)
          const [b, x, y] = m[1].slice(1).split(';').map(Number);
          const at = { x: x - 1, y: y - 1 };
          if (b & 64) {
            if (m[2] === 'M' && (b & 3) < 2) out.push({ name: b & 1 ? 'wheeldown' : 'wheelup', ...at });
          } else if ((b & 131) === 0) {
            out.push({ name: m[2] === 'm' ? 'mouseup' : b & 32 ? 'mousedrag' : 'mousedown', ...at });
          }
          i += m[0].length;
          continue;
        }
        if (m) {
          const final = m[2] ?? m[3];
          const params = (m[1] ?? '').split(';').map((p) => parseInt(p, 10));
          const mod = ((params[1] || 1) - 1) & 15;
          if (final === 'u' || (final === '~' && params[0] === 27)) {
            const key = modified(final === 'u' ? params[0] : params[2], mod);
            if (key) out.push(key);
          } else {
            let name: string | undefined = final === '~' ? CSI_TILDE[params[0]] : CSI_LETTER[final];
            if ((mod & 8) && (name === 'left' || name === 'right')) name = undefined;
            if (mod & 6) name = name === 'left' ? 'wordleft' : name === 'right' ? 'wordright' : name === 'delete' ? 'worddel' : name;
            if (name) out.push({ name });
          }
          i += m[0].length;
          continue;
        }
        if (ALT[rest[1]]) out.push({ name: ALT[rest[1]] }); // other Alt+<key> chords are ignored
        i += 2;
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
