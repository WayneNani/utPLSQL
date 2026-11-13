/**
 * Parser + instrumenter for PL/SQL program units.
 *
 * The parser understands the control-flow structure of PL/SQL (blocks, IF, CASE,
 * loops, EXIT/CONTINUE WHEN, exception handlers, nested subprograms) and the
 * boolean structure of conditions (AND / OR / NOT, parentheses, BETWEEN ... AND).
 * Everything else (assignments, calls, SQL) is treated as opaque token runs,
 * which are only scanned for searched CASE expressions.
 *
 * Instrumentation is purely additive and never inserts line breaks, so line
 * numbers in error stacks and reports stay identical to the original source.
 */
import { tokenize, type Token } from './lexer.js';
import type {
  Branch, CondNode, Condition, Construct, ConstructKind, Decision, DecisionKind,
  Gap, IdCounters, LoopProbe, ObjectMap, Span, StatementProbe,
} from './model.js';

export interface InstrumentOptions {
  /** Instrument conditions inside SQL statements (requires Oracle 23ai / 26ai BOOLEAN in SQL). */
  sqlProbes: boolean;
  /** Name of the runtime package. */
  runtime?: string;
}

export interface InstrumentResult {
  instrumented: string;
  map: ObjectMap;
}

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(`${message} (Zeile ${line})`);
  }
}

interface Edit {
  pos: number;
  text: string;
  gen: number;
}

const STMT_TERMINATORS = new Set(['END', 'EXCEPTION', 'ELSIF', 'ELSE', 'WHEN']);
const SQL_START = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'OPEN', 'FORALL']);
const SQL_CLAUSES: Record<string, string> = {
  SELECT: 'select', FROM: 'from', WHERE: 'where', GROUP: 'group', HAVING: 'having', ORDER: 'order',
  SET: 'set', VALUES: 'values', ON: 'on', CONNECT: 'where', START: 'where', INTO: 'into',
  RETURNING: 'returning', RETURN: 'returning', USING: 'using', FETCH: 'fetch', OFFSET: 'fetch',
};
/** Clauses in which CASE expressions are instrumented. Predicates (WHERE, ON, ...) are left alone on purpose. */
const SQL_SAFE_CLAUSES = new Set(['select', 'set', 'values']);
const MAX_VECTOR_CONDS = 30;

export function instrument(source: string, owner: string, ids: IdCounters, opts: InstrumentOptions): InstrumentResult {
  const p = new Parser(source, owner, ids, opts);
  p.parseUnit();
  return { instrumented: p.applyEdits(), map: p.map };
}

class Parser {
  private t: Token[];
  private i = 0;
  private edits: Edit[] = [];
  private gen = 0;
  private rt: string;
  private nfPending = false;
  private nfRange = false;
  private nfNest = 0;
  private pendingInsert: number | null = null;
  map: ObjectMap;

  constructor(private src: string, owner: string, private ids: IdCounters, private opts: InstrumentOptions) {
    this.t = tokenize(src).filter((t) => t.kind !== 'trivia');
    this.rt = opts.runtime ?? 'cov$';
    this.map = { owner, name: '', type: '', source: src, statements: [], decisions: [], constructs: [], loops: [], gaps: [] };
  }

  // ---------------------------------------------------------------- helpers

  private tok(k = 0): Token {
    const t = this.t[this.i + k];
    if (!t) throw new ParseError('Unerwartetes Ende des Quelltexts', this.t[this.t.length - 1]?.line ?? 1);
    return t;
  }
  private up(k = 0): string {
    return this.t[this.i + k]?.up ?? '';
  }
  private upAt(j: number): string {
    return this.t[j]?.up ?? '';
  }
  private is(...kw: string[]): boolean {
    return kw.includes(this.up());
  }
  private eof(): boolean {
    return this.i >= this.t.length;
  }
  private next(): Token {
    const t = this.tok();
    this.i++;
    return t;
  }
  private expect(kw: string): Token {
    if (this.up() !== kw) throw new ParseError(`Erwartet "${kw}", gefunden "${this.eof() ? 'Ende' : this.tok().text}"`, this.eof() ? 0 : this.tok().line);
    return this.next();
  }
  private ins(pos: number, text: string) {
    if (text.includes('\n')) throw new Error('Instrumentation must not insert line breaks');
    this.edits.push({ pos, text, gen: this.gen++ });
  }
  private gap(line: number, reason: string) {
    if (!this.map.gaps.some((g) => g.line === line && g.reason === reason)) this.map.gaps.push({ line, reason });
  }
  private endOf(tok: Token): { line: number; col: number } {
    const nl = tok.text.lastIndexOf('\n');
    if (nl < 0) return { line: tok.line, col: tok.col + tok.text.length };
    return { line: tok.line + (tok.text.match(/\n/g)?.length ?? 0), col: tok.text.length - nl };
  }
  private span(a: number, bInclusive: number): Span {
    const ta = this.t[a];
    const tb = this.t[bInclusive];
    const e = this.endOf(tb);
    return { start: ta.start, end: tb.end, line: ta.line, col: ta.col, endLine: e.line, endCol: e.col };
  }
  private text(a: number, bInclusive: number): string {
    return this.src.slice(this.t[a].start, this.t[bInclusive].end);
  }
  private get nf(): boolean {
    return this.nfPending || this.nfRange || this.nfNest > 0;
  }

  /**
   * Finds the index of the next token in `stops` at parenthesis depth 0 and
   * outside nested CASE ... END expressions.
   */
  private findAtDepth0(from: number, stops: Set<string>): number {
    let depth = 0;
    let caseDepth = 0;
    for (let k = from; k < this.t.length; k++) {
      const tk = this.t[k];
      const u = tk.up;
      if (depth === 0 && caseDepth === 0 && stops.has(u) && (tk.kind === 'ident' || tk.kind === 'op')) return k;
      if (tk.kind === 'op') {
        if (u === '(') depth++;
        else if (u === ')') {
          depth--;
          if (depth < 0) throw new ParseError(`Unbalancierte Klammer bei der Suche nach ${[...stops].join('/')}`, tk.line);
        }
      } else if (tk.kind === 'ident') {
        if (u === 'CASE') caseDepth++;
        else if (u === 'END' && caseDepth > 0) caseDepth--;
      }
    }
    throw new ParseError(`"${[...stops].join('/')}" nicht gefunden`, this.t[from]?.line ?? 0);
  }

  private matchingParen(open: number): number {
    let depth = 0;
    for (let k = open; k < this.t.length; k++) {
      const u = this.t[k].kind === 'op' ? this.t[k].up : '';
      if (u === '(') depth++;
      else if (u === ')' && --depth === 0) return k;
    }
    throw new ParseError('Schließende Klammer fehlt', this.t[open].line);
  }

  private skipToSemicolon() {
    this.i = this.findAtDepth0(this.i, new Set([';'])) + 1;
  }

  // ------------------------------------------------------------------ units

  parseUnit() {
    while (this.is('CREATE', 'OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING')) this.next();
    const kind = this.up();
    if (kind === 'PACKAGE') {
      this.next();
      if (this.up() !== 'BODY') throw new ParseError('Package-Spezifikationen werden nicht instrumentiert', this.tok().line);
      this.next();
      this.map.type = 'PACKAGE BODY';
      this.readName();
      this.i = this.findAtDepth0(this.i, new Set(['IS', 'AS'])) + 1;
      this.parseDeclSection();
      if (this.is('BEGIN')) {
        this.next();
        this.parseBodyRest();
      } else {
        this.expect('END');
        if (!this.is(';')) this.next();
        this.expect(';');
      }
    } else if (kind === 'PROCEDURE' || kind === 'FUNCTION') {
      this.map.type = kind;
      this.parseSubprogram(true);
    } else if (kind === 'TYPE') {
      this.next();
      this.expect('BODY');
      this.map.type = 'TYPE BODY';
      this.readName();
      this.i = this.findAtDepth0(this.i, new Set(['IS', 'AS'])) + 1;
      while (!this.is('END')) {
        while (this.is('MEMBER', 'STATIC', 'CONSTRUCTOR', 'MAP', 'ORDER', 'OVERRIDING', 'FINAL', 'INSTANTIABLE', 'NOT', ',')) this.next();
        if (this.is('PROCEDURE', 'FUNCTION')) this.parseSubprogram(false);
        else throw new ParseError(`Unerwartetes "${this.tok().text}" im Type Body`, this.tok().line);
      }
      this.expect('END');
      this.expect(';');
    } else if (kind === 'TRIGGER') {
      this.next();
      this.map.type = 'TRIGGER';
      this.readName();
      const startLine = this.tok().line;
      let k = this.i;
      while (k < this.t.length && !['DECLARE', 'BEGIN'].includes(this.t[k].up)) {
        if (this.t[k].up === 'COMPOUND') throw new ParseError('Compound-Trigger werden im Prototyp nicht unterstützt', this.t[k].line);
        if (this.t[k].up === 'WHEN') this.gap(this.t[k].line, 'WHEN-Klausel des Triggers wird nicht gemessen');
        if (this.t[k].up === '(') k = this.matchingParen(k);
        k++;
      }
      if (k >= this.t.length) throw new ParseError('Trigger-Rumpf nicht gefunden', startLine);
      this.i = k;
      this.parseBlock();
    } else {
      throw new ParseError(`Nicht unterstützter Objekttyp "${this.tok().text}"`, this.tok().line);
    }
  }

  private readName() {
    let name = this.next().text;
    if (this.is('.')) {
      this.next();
      name = this.next().text;
    }
    this.map.name = name.startsWith('"') ? name.slice(1, -1) : name.toUpperCase();
  }

  /** At PROCEDURE/FUNCTION: header, then body (or forward declaration / external call spec). */
  private parseSubprogram(top: boolean) {
    this.next();
    if (top) this.readName();
    else this.next();
    for (;;) {
      if (this.is('(')) {
        this.i = this.matchingParen(this.i) + 1;
        continue;
      }
      if (this.is('AS') && this.up(1) === 'RESULT') {
        this.i += 2;
        continue;
      }
      if (this.is('IS', 'AS')) break;
      if (this.is(';')) {
        this.next(); // forward declaration
        return;
      }
      this.next();
    }
    this.next();
    if (this.is('LANGUAGE', 'EXTERNAL')) {
      this.skipToSemicolon();
      return;
    }
    this.parseDeclSection();
    this.expect('BEGIN');
    this.parseBodyRest();
  }

  private parseDeclSection() {
    while (!this.eof() && !this.is('BEGIN', 'END')) {
      if (this.is('PROCEDURE', 'FUNCTION')) {
        this.parseSubprogram(false);
      } else if (this.is('CURSOR')) {
        const semi = this.findAtDepth0(this.i, new Set([';']));
        let isIdx = -1;
        for (let k = this.i; k < semi; k++) if (this.t[k].up === 'IS') { isIdx = k; break; }
        if (isIdx > 0) this.scanExprRegion(isIdx + 1, semi, 'sql', 'start');
        this.i = semi + 1;
      } else if (this.is('PRAGMA')) {
        this.skipToSemicolon();
      } else {
        const semi = this.findAtDepth0(this.i, new Set([';']));
        for (let k = this.i; k < semi; k++) {
          if (this.t[k].up === ':=' || this.t[k].up === 'DEFAULT') {
            this.scanExprRegion(k + 1, semi, 'plsql', 'plsql');
            break;
          }
        }
        this.i = semi + 1;
      }
    }
  }

  /** After BEGIN: statements, optional exception section, END [label];  */
  private parseBodyRest() {
    this.parseStmtList();
    if (this.is('EXCEPTION')) {
      const excTok = this.next();
      this.parseHandlers(excTok);
    }
    this.expect('END');
    if (!this.is(';')) this.next();
    this.expect(';');
  }

  private parseHandlers(excTok: Token) {
    const c = this.newConstruct('handlers', 'plsql', excTok);
    while (this.is('WHEN')) {
      const whenIdx = this.i;
      const thenIdx = this.findAtDepth0(this.i + 1, new Set(['THEN']));
      const label = this.text(whenIdx + 1, thenIdx - 1).replace(/\s+/g, ' ');
      const thenTok = this.t[thenIdx];
      const id = this.ids.branch++;
      this.ins(thenTok.end, ` ${this.rt}.b(${id});`);
      this.i = thenIdx + 1;
      const r = this.parseStmtList();
      c.branches.push({ label: `WHEN ${label}`, line: this.t[whenIdx].line, col: this.t[whenIdx].col, nf: r.firstNF, probe: id });
    }
  }

  // ------------------------------------------------------------- statements

  private parseStmtList(): { firstNF: boolean } {
    let firstNF: boolean | null = null;
    // PRAGMA COVERAGE('NOT_FEASIBLE') marks the rest of the current statement sequence (its basic block).
    let listNf = 0;
    try {
      while (!this.eof() && !STMT_TERMINATORS.has(this.up())) {
        const nf = this.parseStatement();
        if (nf === null && this.nfPending) {
          this.nfPending = false;
          this.nfNest++;
          listNf++;
        }
        if (nf !== null && firstNF === null) firstNF = nf;
      }
    } finally {
      this.nfNest -= listNf;
    }
    return { firstNF: firstNF ?? false };
  }

  /** Returns the not-feasible flag of the statement, or null if no statement was parsed (pragma). */
  private parseStatement(): boolean | null {
    let insertPos = this.tok().start;
    while (this.is('<<')) {
      this.next();
      this.next();
      this.expect('>>');
    }
    if (this.is('PRAGMA')) {
      if (this.up(1) === 'COVERAGE') {
        const arg = this.t[this.i + 3]?.text.toUpperCase() ?? '';
        if (arg === "'NOT_FEASIBLE'") this.nfPending = true;
        else if (arg === "'NOT_FEASIBLE_START'") this.nfRange = true;
        else if (arg === "'NOT_FEASIBLE_END'") this.nfRange = false;
      } else {
        // e.g. PRAGMA INLINE must stay directly in front of its statement
        this.pendingInsert ??= insertPos;
      }
      this.skipToSemicolon();
      return null;
    }
    if (this.pendingInsert !== null) {
      insertPos = this.pendingInsert;
      this.pendingInsert = null;
    }
    if (this.eof() || STMT_TERMINATORS.has(this.up())) return null;

    const first = this.tok();
    const nf = this.nf;
    this.nfPending = false;
    const stmt: StatementProbe = { id: this.ids.stmt++, line: first.line, endLine: first.line, kind: '', nf };
    this.map.statements.push(stmt);
    this.ins(insertPos, `${this.rt}.s(${stmt.id});`);
    if (nf) this.nfNest++;
    try {
      stmt.kind = this.dispatch(insertPos);
    } finally {
      if (nf) this.nfNest--;
    }
    stmt.endLine = this.endOf(this.t[this.i - 1]).line;
    return nf;
  }

  private dispatch(insertPos: number): string {
    const u = this.up();
    if (this.up(1) === ':=' || this.up(1) === '.' && this.up(3) === ':=') {
      this.scanStatement('plsql');
      return 'assignment';
    }
    switch (u) {
      case 'IF': this.parseIf(); return 'if';
      case 'CASE': this.parseCaseStmt(); return 'case';
      case 'LOOP': case 'WHILE': case 'FOR': this.parseLoop(insertPos); return 'loop';
      case 'EXIT': case 'CONTINUE': this.parseExitWhen(); return u.toLowerCase();
      case 'BEGIN': case 'DECLARE': this.parseBlock(); return 'block';
      case 'EXECUTE':
        this.gap(this.tok().line, 'Dynamisches SQL (EXECUTE IMMEDIATE) wird nicht instrumentiert');
        this.skipToSemicolon();
        return 'execute-immediate';
      default:
        if (SQL_START.has(u)) {
          this.scanStatement('sql');
          return 'sql';
        }
        this.scanStatement('plsql');
        return u === 'RETURN' ? 'return' : u === 'RAISE' ? 'raise' : 'call';
    }
  }

  private scanStatement(ctx: 'plsql' | 'sql') {
    const semi = this.findAtDepth0(this.i, new Set([';']));
    this.scanExprRegion(this.i, semi, ctx, ctx === 'sql' ? 'start' : 'plsql');
    this.i = semi + 1;
  }

  private parseBlock() {
    if (this.is('DECLARE')) {
      this.next();
      this.parseDeclSection();
    }
    this.expect('BEGIN');
    this.parseBodyRest();
  }

  private parseIf() {
    const ifTok = this.next();
    const c = this.newConstruct('if', 'plsql', ifTok);
    let kwTok = ifTok;
    let kind: DecisionKind = 'if';
    let last: Decision | null = null;
    for (;;) {
      const thenIdx = this.findAtDepth0(this.i, new Set(['THEN']));
      last = this.instrumentDecision(kind, this.i, thenIdx, 'plsql');
      this.i = thenIdx + 1;
      const r = this.parseStmtList();
      c.branches.push({
        label: kind === 'if' ? 'THEN' : 'ELSIF … THEN', line: kwTok.line, col: kwTok.col, nf: r.firstNF,
        derived: { decision: last!.id, outcome: 'T' },
      });
      if (!this.is('ELSIF')) break;
      kwTok = this.next();
      kind = 'elsif';
    }
    if (this.is('ELSE')) {
      const elseTok = this.next();
      const r = this.parseStmtList();
      c.branches.push({ label: 'ELSE', line: elseTok.line, col: elseTok.col, nf: r.firstNF, derived: { decision: last!.id, outcome: 'notT' } });
    } else {
      const endTok = this.tok();
      c.branches.push({ label: 'ELSE (implizit)', line: endTok.line, col: endTok.col, nf: false, derived: { decision: last!.id, outcome: 'notT' } });
    }
    this.expect('END');
    this.expect('IF');
    this.expect(';');
  }

  private parseCaseStmt() {
    const caseTok = this.next();
    const searched = this.is('WHEN');
    const c = this.newConstruct('case', 'plsql', caseTok);
    if (!searched) this.i = this.findAtDepth0(this.i, new Set(['WHEN']));
    let last: Decision | null = null;
    while (this.is('WHEN')) {
      const whenTok = this.next();
      const thenIdx = this.findAtDepth0(this.i, new Set(['THEN']));
      const label = `WHEN ${this.text(this.i, thenIdx - 1).replace(/\s+/g, ' ')}`;
      const br: Branch = { label, line: whenTok.line, col: whenTok.col, nf: false };
      if (searched) {
        last = this.instrumentDecision('case-when', this.i, thenIdx, 'plsql');
        br.derived = { decision: last!.id, outcome: 'T' };
      } else {
        br.probe = this.ids.branch++;
        this.ins(this.t[thenIdx].end, ` ${this.rt}.b(${br.probe});`);
      }
      this.i = thenIdx + 1;
      br.nf = this.parseStmtList().firstNF;
      c.branches.push(br);
    }
    if (this.is('ELSE')) {
      const elseTok = this.next();
      const br: Branch = { label: 'ELSE', line: elseTok.line, col: elseTok.col, nf: false };
      if (searched) br.derived = { decision: last!.id, outcome: 'notT' };
      else {
        br.probe = this.ids.branch++;
        this.ins(elseTok.end, ` ${this.rt}.b(${br.probe});`);
      }
      br.nf = this.parseStmtList().firstNF;
      c.branches.push(br);
    } else {
      const endTok = this.tok();
      const br: Branch = { label: 'ELSE (implizit → CASE_NOT_FOUND)', line: endTok.line, col: endTok.col, nf: false };
      if (searched) br.derived = { decision: last!.id, outcome: 'notT' };
      else {
        br.probe = this.ids.branch++;
        this.ins(endTok.start, `else ${this.rt}.b(${br.probe}); raise case_not_found; `);
      }
      c.branches.push(br);
    }
    this.expect('END');
    this.expect('CASE');
    if (!this.is(';')) this.next();
    this.expect(';');
  }

  private parseLoop(insertPos: number) {
    const first = this.tok();
    const loop: LoopProbe = { id: this.ids.loop++, kind: 'loop', line: first.line, endLine: first.line, nf: this.nf };
    this.map.loops.push(loop);
    if (this.is('WHILE')) {
      loop.kind = 'while';
      this.next();
      const loopIdx = this.findAtDepth0(this.i, new Set(['LOOP']));
      const c = this.newConstruct('while', 'plsql', first);
      const d = this.instrumentDecision('while', this.i, loopIdx, 'plsql')!;
      c.branches.push(
        { label: 'Bedingung WAHR → Durchlauf', line: first.line, col: first.col, nf: false, derived: { decision: d.id, outcome: 'T' } },
        { label: 'Bedingung nicht WAHR → Ende', line: first.line, col: first.col, nf: false, derived: { decision: d.id, outcome: 'notT' } },
      );
      this.i = loopIdx;
    } else if (this.is('FOR')) {
      this.next();
      const loopIdx = this.findAtDepth0(this.i, new Set(['LOOP']));
      for (let k = this.i; k < loopIdx; k++) {
        if (this.t[k].up === 'SELECT' || this.t[k].up === 'WITH') loop.kind = 'cursor-for';
        if (this.t[k].up === 'WHEN') this.gap(this.t[k].line, 'WHEN-Filter in FOR-Iterationen (21c) wird nicht gemessen');
      }
      if (loop.kind === 'cursor-for') this.scanExprRegion(this.i, loopIdx, 'sql', 'start');
      else loop.kind = 'for';
      this.i = loopIdx;
    }
    const loopTok = this.expect('LOOP');
    this.ins(insertPos, `${this.rt}.le(${loop.id});`);
    this.ins(loopTok.end, ` ${this.rt}.li(${loop.id});`);
    this.parseStmtList();
    this.expect('END');
    this.expect('LOOP');
    if (!this.is(';')) this.next();
    const semi = this.expect(';');
    this.ins(semi.end, ` ${this.rt}.lx(${loop.id});`);
    loop.endLine = semi.line;
  }

  private parseExitWhen() {
    const kw = this.next();
    if (!this.is('WHEN', ';')) this.next(); // label
    if (this.is('WHEN')) {
      this.next();
      const semi = this.findAtDepth0(this.i, new Set([';']));
      const kind = kw.up === 'EXIT' ? 'exit-when' : 'continue-when';
      const c = this.newConstruct(kind, 'plsql', kw);
      const d = this.instrumentDecision(kind, this.i, semi, 'plsql')!;
      const verb = kw.up === 'EXIT' ? 'Schleife verlassen' : 'nächste Iteration';
      c.branches.push(
        { label: `WAHR → ${verb}`, line: kw.line, col: kw.col, nf: false, derived: { decision: d.id, outcome: 'T' } },
        { label: 'nicht WAHR → weiter', line: kw.line, col: kw.col, nf: false, derived: { decision: d.id, outcome: 'notT' } },
      );
      this.i = semi + 1;
    } else {
      this.expect(';');
    }
  }

  private newConstruct(kind: ConstructKind, ctx: 'plsql' | 'sql', tok: Token): Construct {
    const c: Construct = { id: this.ids.construct++, kind, ctx, line: tok.line, col: tok.col, branches: [] };
    this.map.constructs.push(c);
    return c;
  }

  // -------------------------------------------------------------- decisions

  /** Wraps the condition in tokens [a, b) with decision and condition probes. */
  private instrumentDecision(kind: DecisionKind, a: number, b: number, ctx: 'plsql' | 'sql'): Decision | null {
    if (b <= a) throw new ParseError('Leere Bedingung', this.t[a]?.line ?? 0);
    if (ctx === 'sql' && !this.opts.sqlProbes) return null;
    const id = this.ids.dec++;
    const vectors = ctx === 'plsql';
    const rt = this.rt;
    this.ins(this.t[a].start, vectors ? `${rt}.d(${id},${rt}.o(${id}) and (` : `${rt}.d(${id},`);
    const conds: Condition[] = [];
    const tree = this.parseOr(a, b, id, conds, true);
    this.ins(this.t[b - 1].end, vectors ? '))' : ')');
    const d: Decision = {
      id, kind, ctx, span: this.span(a, b - 1), text: this.text(a, b - 1), conds, tree,
      vectors: vectors && conds.length <= MAX_VECTOR_CONDS, nf: this.nf,
    };
    this.map.decisions.push(d);
    return d;
  }

  // Boolean expression parser on tokens [j, end). Each function returns [node, nextIndex].

  // `pos` is the polarity: false under an odd number of NOTs (see runtime functions c / n).
  private parseOr(j: number, end: number, d: number, conds: Condition[], pos: boolean): CondNode {
    const [node, k] = this.pOr(j, end, d, conds, pos);
    if (k !== end) throw new ParseError(`Bedingung nicht vollständig verstanden bei "${this.t[k].text}"`, this.t[k].line);
    return node;
  }

  private pOr(j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    const parts: CondNode[] = [];
    let [n, k] = this.pAnd(j, end, d, conds, pos);
    parts.push(n);
    while (k < end && this.upAt(k) === 'OR') {
      [n, k] = this.pAnd(k + 1, end, d, conds, pos);
      parts.push(n);
    }
    return [parts.length === 1 ? parts[0] : { t: 'or', c: parts }, k];
  }

  private pAnd(j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    const parts: CondNode[] = [];
    let [n, k] = this.pNot(j, end, d, conds, pos);
    parts.push(n);
    while (k < end && this.upAt(k) === 'AND') {
      [n, k] = this.pNot(k + 1, end, d, conds, pos);
      parts.push(n);
    }
    return [parts.length === 1 ? parts[0] : { t: 'and', c: parts }, k];
  }

  private pNot(j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    if (this.upAt(j) === 'NOT') {
      const [n, k] = this.pNot(j + 1, end, d, conds, !pos);
      return [{ t: 'not', c: [n] }, k];
    }
    return this.pPrimary(j, end, d, conds, pos);
  }

  private pPrimary(j: number, end: number, d: number, conds: Condition[], pos: boolean): [CondNode, number] {
    if (j >= end) throw new ParseError('Operand fehlt in Bedingung', this.t[Math.min(j, this.t.length - 1)].line);
    if (this.t[j].up === '(' && this.t[j].kind === 'op') {
      const m = this.matchingParen(j);
      const after = this.upAt(m + 1);
      if (m < end && (m + 1 === end || after === 'AND' || after === 'OR') && this.groupIsBoolean(j + 1, m)) {
        const [n, k] = this.pOr(j + 1, m, d, conds, pos);
        if (k !== m) throw new ParseError('Klammerausdruck nicht verstanden', this.t[k].line);
        return [n, m + 1];
      }
    }
    // atom: until AND/OR at depth 0 (BETWEEN x AND y and CASE ... END stay inside)
    let k = j;
    let depth = 0;
    let caseDepth = 0;
    let between = false;
    while (k < end) {
      const tk = this.t[k];
      const u = tk.up;
      if (depth === 0 && caseDepth === 0 && tk.kind === 'ident') {
        if (u === 'OR' || (u === 'AND' && !between)) break;
        if (u === 'AND') between = false;
        if (u === 'BETWEEN') between = true;
      }
      if (tk.kind === 'op' && u === '(') depth++;
      else if (tk.kind === 'op' && u === ')') depth--;
      else if (tk.kind === 'ident' && u === 'CASE') caseDepth++;
      else if (tk.kind === 'ident' && u === 'END' && caseDepth > 0) caseDepth--;
      k++;
    }
    if (k === j) throw new ParseError(`Operand fehlt vor "${this.t[k].text}"`, this.t[k].line);
    const i = conds.length + 1;
    conds.push({ i, text: this.text(j, k - 1), span: this.span(j, k - 1) });
    this.ins(this.t[j].start, `${this.rt}.${pos ? 'c' : 'n'}(${d},${i},`);
    this.ins(this.t[k - 1].end, ')');
    return [{ t: 'cond', i }, k];
  }

  /** True if the token range is a boolean combination (top-level AND/OR or leading NOT). */
  private groupIsBoolean(a: number, b: number): boolean {
    if (this.upAt(a) === 'NOT') return true;
    let depth = 0;
    let caseDepth = 0;
    let between = false;
    for (let k = a; k < b; k++) {
      const tk = this.t[k];
      const u = tk.up;
      if (tk.kind === 'op' && u === '(') depth++;
      else if (tk.kind === 'op' && u === ')') depth--;
      else if (tk.kind === 'ident') {
        if (u === 'CASE') caseDepth++;
        else if (u === 'END' && caseDepth > 0) caseDepth--;
        else if (depth === 0 && caseDepth === 0) {
          if (u === 'BETWEEN') between = true;
          else if (u === 'AND' && between) between = false;
          else if (u === 'AND' || u === 'OR') return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------ CASE expressions

  /**
   * Scans an opaque token region [a, b) for searched CASE expressions and
   * instruments them. In SQL only CASE expressions in the select list, SET and
   * VALUES clauses are touched; predicates would change execution plans.
   */
  private scanExprRegion(a: number, b: number, ctx: 'plsql' | 'sql', clause: string) {
    let hasGroupBy = false;
    if (ctx === 'sql') {
      for (let k = a; k < b - 1; k++) if (this.t[k].up === 'GROUP' && this.t[k + 1].up === 'BY') hasGroupBy = true;
    }
    const stack = [clause];
    for (let k = a; k < b; k++) {
      const tk = this.t[k];
      const u = tk.up;
      if (tk.kind === 'op' && u === '(') {
        stack.push(stack[stack.length - 1]);
        continue;
      }
      if (tk.kind === 'op' && u === ')') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (tk.kind !== 'ident') continue;
      if (ctx === 'sql' && SQL_CLAUSES[u]) {
        stack[stack.length - 1] = SQL_CLAUSES[u];
        continue;
      }
      if (u !== 'CASE') continue;
      const cl = stack[stack.length - 1];
      const searched = this.upAt(k + 1) === 'WHEN';
      if (ctx === 'sql' && !this.opts.sqlProbes) {
        this.gap(tk.line, 'CASE-Ausdruck in SQL: Messung erst ab Oracle 23ai/26ai möglich');
        continue;
      }
      if (ctx === 'sql' && !SQL_SAFE_CLAUSES.has(cl)) {
        this.gap(tk.line, `CASE in ${cl.toUpperCase()}-Klausel bewusst nicht gemessen (würde den Ausführungsplan verändern)`);
        continue;
      }
      if (ctx === 'sql' && cl === 'select' && hasGroupBy) {
        this.gap(tk.line, 'CASE in Abfrage mit GROUP BY nicht gemessen (Ausdrücke müssen identisch bleiben)');
        continue;
      }
      if (!searched) {
        this.gap(tk.line, 'Einfacher CASE-Ausdruck (CASE x WHEN …) wird im Prototyp nicht gemessen');
        continue;
      }
      k = this.instrumentCaseExpr(k, ctx, cl);
    }
  }

  /** Instruments a searched CASE expression starting at index k; returns index of its END. */
  private instrumentCaseExpr(k: number, ctx: 'plsql' | 'sql', clause: string): number {
    const caseTok = this.t[k];
    const c = this.newConstruct('case-expr', ctx, caseTok);
    let j = k + 1;
    let last: Decision | null = null;
    const stops = new Set(['WHEN', 'ELSE', 'END']);
    while (this.upAt(j) === 'WHEN') {
      const whenTok = this.t[j];
      const thenIdx = this.findAtDepth0(j + 1, new Set(['THEN']));
      last = this.instrumentDecision('case-expr-when', j + 1, thenIdx, ctx)!;
      c.branches.push({
        label: `WHEN ${this.text(j + 1, thenIdx - 1).replace(/\s+/g, ' ')}`, line: whenTok.line, col: whenTok.col,
        nf: false, derived: { decision: last.id, outcome: 'T' },
      });
      const resEnd = this.findAtDepth0(thenIdx + 1, stops);
      this.scanExprRegion(thenIdx + 1, resEnd, ctx, clause);
      j = resEnd;
    }
    if (this.upAt(j) === 'ELSE') {
      const elseTok = this.t[j];
      const resEnd = this.findAtDepth0(j + 1, new Set(['END']));
      this.scanExprRegion(j + 1, resEnd, ctx, clause);
      c.branches.push({ label: 'ELSE', line: elseTok.line, col: elseTok.col, nf: false, derived: { decision: last!.id, outcome: 'notT' } });
      j = resEnd;
    } else {
      const endTok = this.t[j];
      c.branches.push({ label: 'ELSE (implizit → NULL)', line: endTok.line, col: endTok.col, nf: false, derived: { decision: last!.id, outcome: 'notT' } });
    }
    if (this.upAt(j) !== 'END') throw new ParseError('END des CASE-Ausdrucks fehlt', this.t[j]?.line ?? 0);
    return j;
  }

  // ------------------------------------------------------------------ edits

  applyEdits(): string {
    const sorted = [...this.edits].sort((x, y) => x.pos - y.pos || x.gen - y.gen);
    let out = '';
    let last = 0;
    for (const e of sorted) {
      out += this.src.slice(last, e.pos) + e.text;
      last = e.pos;
    }
    return out + this.src.slice(last);
  }
}
