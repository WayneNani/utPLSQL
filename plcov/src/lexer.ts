/**
 * PL/SQL lexer.
 *
 * Produces tokens with exact source offsets so that the instrumenter can insert
 * text without touching anything else. Whitespace and comments are kept as
 * tokens (kind "trivia") but the parser works on the significant tokens only.
 */

export type TokenKind = 'trivia' | 'ident' | 'qident' | 'string' | 'number' | 'op';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Upper-cased text for keyword comparison (identifiers only, otherwise text). */
  up: string;
  start: number;
  end: number;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
}

const MULTI_OPS = [':=', '=>', '..', '||', '**', '<>', '!=', '~=', '^=', '<=', '>=', '<<', '>>'];
const Q_CLOSERS: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

const isIdentStart = (ch: string) => /[A-Za-z_$#À-￿]/.test(ch);
const isIdentPart = (ch: string) => /[A-Za-z0-9_$#À-￿]/.test(ch);
const isDigit = (ch: string) => ch >= '0' && ch <= '9';

export class LexError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`${message} (line ${line}, column ${col})`);
  }
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const push = (kind: TokenKind, start: number, end: number, startLine: number, startCol: number) => {
    const text = src.slice(start, end);
    tokens.push({ kind, text, up: kind === 'ident' ? text.toUpperCase() : text, start, end, line: startLine, col: startCol });
  };

  /** Advance pos to `to`, keeping line bookkeeping correct. */
  const advance = (to: number) => {
    for (let k = pos; k < to; k++) {
      if (src[k] === '\n') {
        line++;
        lineStart = k + 1;
      }
    }
    pos = to;
  };

  while (pos < src.length) {
    const ch = src[pos];
    const start = pos;
    const startLine = line;
    const startCol = pos - lineStart + 1;

    // whitespace
    if (/\s/.test(ch)) {
      let k = pos;
      while (k < src.length && /\s/.test(src[k])) k++;
      advance(k);
      push('trivia', start, pos, startLine, startCol);
      continue;
    }

    // comments
    if (ch === '-' && src[pos + 1] === '-') {
      let k = src.indexOf('\n', pos);
      if (k < 0) k = src.length;
      advance(k);
      push('trivia', start, pos, startLine, startCol);
      continue;
    }
    if (ch === '/' && src[pos + 1] === '*') {
      const k = src.indexOf('*/', pos + 2);
      if (k < 0) throw new LexError('Unterminated comment', startLine, startCol);
      advance(k + 2);
      push('trivia', start, pos, startLine, startCol);
      continue;
    }

    // q-quoted strings: q'[...]', nq'{...}'
    const qMatch = /^(n?q)'/i.exec(src.slice(pos, pos + 3));
    if (qMatch) {
      const openPos = pos + qMatch[1].length + 1;
      const open = src[openPos];
      const close = Q_CLOSERS[open] ?? open;
      const k = src.indexOf(close + "'", openPos + 1);
      if (k < 0) throw new LexError('Unterminated q-quoted string', startLine, startCol);
      advance(k + 2);
      push('string', start, pos, startLine, startCol);
      continue;
    }

    // national strings n'...'
    if ((ch === 'n' || ch === 'N') && src[pos + 1] === "'") {
      advance(pos + 1);
    }

    // strings
    if (src[pos] === "'") {
      let k = pos + 1;
      for (;;) {
        if (k >= src.length) throw new LexError('Unterminated string', startLine, startCol);
        if (src[k] === "'") {
          if (src[k + 1] === "'") {
            k += 2;
            continue;
          }
          break;
        }
        k++;
      }
      advance(k + 1);
      push('string', start, pos, startLine, startCol);
      continue;
    }

    // quoted identifiers
    if (ch === '"') {
      const k = src.indexOf('"', pos + 1);
      if (k < 0) throw new LexError('Unterminated quoted identifier', startLine, startCol);
      advance(k + 1);
      push('qident', start, pos, startLine, startCol);
      continue;
    }

    // numbers (careful with ranges like 1..10)
    if (isDigit(ch) || (ch === '.' && isDigit(src[pos + 1] ?? ''))) {
      let k = pos;
      while (k < src.length && isDigit(src[k])) k++;
      if (src[k] === '.' && src[k + 1] !== '.') {
        k++;
        while (k < src.length && isDigit(src[k])) k++;
      }
      if ((src[k] === 'e' || src[k] === 'E') && /[+\-0-9]/.test(src[k + 1] ?? '')) {
        k++;
        if (src[k] === '+' || src[k] === '-') k++;
        while (k < src.length && isDigit(src[k])) k++;
      }
      if (/[fFdD]/.test(src[k] ?? '') && !isIdentPart(src[k + 1] ?? '')) k++;
      advance(k);
      push('number', start, pos, startLine, startCol);
      continue;
    }

    // identifiers / keywords
    if (isIdentStart(ch)) {
      let k = pos + 1;
      while (k < src.length && isIdentPart(src[k])) k++;
      advance(k);
      push('ident', start, pos, startLine, startCol);
      continue;
    }

    // operators
    const two = src.slice(pos, pos + 2);
    if (MULTI_OPS.includes(two)) {
      advance(pos + 2);
      push('op', start, pos, startLine, startCol);
      continue;
    }
    advance(pos + 1);
    push('op', start, pos, startLine, startCol);
  }
  return tokens;
}

/** Converts a 0-based offset into a 1-based line/column. */
export function lineColOf(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < offset && k < src.length; k++) {
    if (src[k] === '\n') {
      line++;
      lineStart = k + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}
