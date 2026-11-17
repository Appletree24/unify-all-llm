// LaTeX → Unicode. A terminal cannot typeset math, so formulas are flattened to
// one line using real math glyphs: \frac{a}{b} → a/b, x^2 → x², \alpha → α.
// Anything not understood is left as readable source rather than dropped.

const SYM: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', circ: '∘', bullet: '•',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃',
  propto: '∝', ll: '≪', gg: '≫', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', iff: '⟺', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', infty: '∞', sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮',
  partial: '∂', nabla: '∇', in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅', forall: '∀',
  exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗',
  perp: '⊥', parallel: '∥', angle: '∠', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  mid: '|', vert: '|', Vert: '‖', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈',
  rceil: '⌉', ell: 'ℓ', hbar: 'ℏ', prime: '′', degree: '°', top: '⊤', bot: '⊥', star: '⋆',
  triangle: '△', square: '□', therefore: '∴', because: '∵', aleph: 'ℵ', Re: 'ℜ', Im: 'ℑ',
  lbrace: '{', rbrace: '}', backslash: '\\', colon: ':', dagger: '†',
};
const FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln',
  'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'arg', 'det', 'dim', 'ker', 'deg', 'gcd', 'Pr', 'mod',
]);
const PASS = new Set([
  'text', 'textbf', 'textit', 'textrm', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathscr',
  'mathfrak', 'operatorname', 'boldsymbol', 'bm', 'mbox', 'underline', 'boxed',
]);
const SILENT = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'hline', 'nonumber', 'notag']);
const BB: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ', F: '𝔽' };
const ACCENT: Record<string, string> = {
  hat: '̂', widehat: '̂', bar: '̄', overline: '̄', vec: '⃗', tilde: '̃',
  widetilde: '̃', dot: '̇', ddot: '̈',
};

const zip = (from: string, to: string) => Object.fromEntries(Array.from(from).map((c, i) => [c, Array.from(to)[i]]));
const SUP = zip('0123456789+-=()abcdefghijklmnoprstuvwxyzTβγδθφ', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᵀᵝᵞᵟᶿᵠ');
const SUB = zip('0123456789+-=()aehijklmnoprstuvxβγρφ', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩ');

const atomic = (a: string) => Array.from(a).length <= 1 || /^√?[\p{L}\p{N}.′]+$/u.test(a);
const paren = (a: string) => (atomic(a) ? a : `(${a})`);

function script(text: string, map: Record<string, string>, mark: string): string {
  const chars = Array.from(text.replace(/\s+/g, ''));
  if (chars.length === 0) return '';
  if (chars.every((c) => c in map)) return chars.map((c) => map[c]).join('');
  return chars.length === 1 ? mark + chars[0] : `${mark}(${text.trim()})`;
}

export function tex(s: string): string {
  let i = 0;
  let out = '';

  /** Next argument: a {group}, a \command, or a single character. */
  const group = (): string => {
    while (s[i] === ' ') i++;
    if (s[i] === '{') {
      const start = i + 1;
      let depth = 0;
      for (; i < s.length; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) {
          const inner = s.slice(start, i);
          i++;
          return tex(inner);
        }
      }
      return tex(s.slice(start)); // unclosed (still streaming)
    }
    if (s[i] === '\\') return command();
    const ch = s.codePointAt(i);
    if (ch === undefined) return '';
    const c = String.fromCodePoint(ch);
    i += c.length;
    return c;
  };

  const command = (): string => {
    i++; // the backslash
    const m = /^[a-zA-Z]+/.exec(s.slice(i, i + 24));
    if (!m) {
      const c = s[i++] ?? '';
      if (c === '\\') return '\n';
      if (c === '!') return '';
      if (',;: '.includes(c)) return ' ';
      if (c === '|') return '‖';
      return c; // \{ \} \% \$ \_ \&
    }
    const name = m[0];
    i += name.length;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const a = group();
      const b = group();
      return `${paren(a)}/${paren(b)}`;
    }
    if (name === 'binom') {
      const a = group();
      return `C(${a}, ${group()})`;
    }
    if (name === 'sqrt') {
      let index = '';
      if (s[i] === '[') {
        const end = s.indexOf(']', i);
        if (end > 0) {
          index = script(tex(s.slice(i + 1, end)), SUP, '');
          i = end + 1;
        }
      }
      const arg = group();
      return `${index}√${Array.from(arg).length <= 1 ? arg : `(${arg})`}`;
    }
    if (name === 'mathbb') {
      const a = group();
      return BB[a] ?? a;
    }
    if (name in ACCENT) {
      const a = group();
      return Array.from(a).length === 1 ? a + ACCENT[name] : `${name}(${a})`;
    }
    if (PASS.has(name)) return group();
    if (name === 'left' || name === 'right') {
      if (s[i] === '.') i++;
      return '';
    }
    if (name === 'begin' || name === 'end') {
      group(); // environment name
      if (s[i] === '{' && name === 'begin') group(); // column spec of array/tabular
      return '';
    }
    if (name === 'quad' || name === 'qquad') return '  ';
    if (SILENT.has(name)) return '';
    if (name in SYM) return SYM[name];
    if (FUNCS.has(name)) return name;
    return '\\' + name;
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') out += command();
    else if (c === '^' || c === '_') {
      i++;
      out += script(group(), c === '^' ? SUP : SUB, c);
    } else if (c === '{') out += group();
    else if (c === '}') i++;
    else if (c === '&') {
      out += '  ';
      i++;
    } else if (c === '~') {
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
