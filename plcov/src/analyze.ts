/**
 * Turns probe map + raw hits into metrics, per-line status and findings.
 */
import type { CondNode, Hits, ObjectMap, Outcome, Span } from './model.js';

export interface Metric {
  covered: number;
  total: number;
}

export interface CondResult {
  i: number;
  text: string;
  span: Span;
  t: number;
  f: number;
  n: number;
  /** MC/DC: independence shown ("yes"), missing ("no"), or not measurable ("na", SQL decisions). */
  mcdc: 'yes' | 'no' | 'na';
  /** Human readable proposal for the missing test vector. */
  suggestion?: string;
}

export interface DecisionResult {
  id: number;
  kind: string;
  ctx: 'plsql' | 'sql';
  line: number;
  span: Span;
  text: string;
  outcomes: Record<Outcome, number>;
  conds: CondResult[];
  vectors: { v: string; out: Outcome; hits: number }[];
  nf: boolean;
}

export interface BranchResult {
  construct: number;
  constructKind: string;
  ctx: 'plsql' | 'sql';
  label: string;
  line: number;
  hits: number;
  nf: boolean;
  /** Explanation for derived branches, e.g. which outcome is missing. */
  reason?: string;
}

export interface LoopResult {
  id: number;
  kind: string;
  line: number;
  endLine: number;
  zero: number;
  one: number;
  many: number;
  nf: boolean;
}

export type LineStatus = 'covered' | 'partial' | 'missed' | 'nf';

export interface Finding {
  kind: 'stmt' | 'branch' | 'cond' | 'mcdc' | 'loop';
  line: number;
  title: string;
  detail?: string;
}

export interface ObjectResult {
  key: string;
  owner: string;
  name: string;
  type: string;
  lines: string[];
  metrics: Record<'stmt' | 'branch' | 'cond' | 'mcdc' | 'loop', Metric>;
  statements: { id: number; line: number; endLine: number; hits: number; nf: boolean }[];
  branches: BranchResult[];
  decisions: DecisionResult[];
  loops: LoopResult[];
  lineStatus: Record<number, LineStatus>;
  lineHits: Record<number, number>;
  gaps: { line: number; reason: string }[];
  findings: Finding[];
  /** Line coverage as reported by utPLSQL (DBMS_PROFILER) for the same tests. */
  utplsql?: { covered: number; total: number; lines: Record<number, boolean> };
  instrumentError?: string;
}

const WORD: Record<string, string> = { T: 'WAHR', F: 'FALSCH', N: 'NULL', '-': 'nicht ausgewertet' };

export function analyze(map: ObjectMap, hits: Hits): ObjectResult {
  const g = <K>(m: Map<K, number>, k: K) => m.get(k) ?? 0;
  const lines = map.source.replace(/\n$/, '').split('\n');

  const statements = map.statements.map((s) => ({ id: s.id, line: s.line, endLine: s.endLine, hits: g(hits.stmt, s.id), nf: s.nf }));

  const decisions: DecisionResult[] = map.decisions.map((d) => {
    const n = d.conds.length;
    const vectors: DecisionResult['vectors'] = [];
    for (const [key, cnt] of hits.vec) {
      const [id, vec, out] = key.split('|');
      if (Number(id) === d.id) vectors.push({ v: vec.slice(0, n), out: out as Outcome, hits: cnt });
    }
    const conds: CondResult[] = d.conds.map((c) => ({
      i: c.i, text: c.text, span: c.span,
      t: g(hits.cond, `${d.id}:${c.i}:T`), f: g(hits.cond, `${d.id}:${c.i}:F`), n: g(hits.cond, `${d.id}:${c.i}:N`),
      mcdc: d.vectors ? 'no' : 'na',
    }));
    if (d.vectors) computeMcdc(d.tree, conds, vectors);
    return {
      id: d.id, kind: d.kind, ctx: d.ctx, line: d.span.line, span: d.span, text: d.text, nf: d.nf, conds, vectors,
      outcomes: { T: g(hits.dec, `${d.id}:T`), F: g(hits.dec, `${d.id}:F`), N: g(hits.dec, `${d.id}:N`) },
    };
  });
  const decById = new Map(decisions.map((d) => [d.id, d]));

  const branches: BranchResult[] = [];
  for (const c of map.constructs) {
    for (const b of c.branches) {
      let h = 0;
      let reason: string | undefined;
      if (b.probe !== undefined) h = g(hits.branch, b.probe);
      else if (b.derived) {
        const d = decById.get(b.derived.decision)!;
        h = b.derived.outcome === 'T' ? d.outcomes.T : d.outcomes.F + d.outcomes.N;
        if (h === 0) {
          reason = b.derived.outcome === 'T'
            ? `Bedingung \`${short(d.text)}\` war nie WAHR`
            : `Bedingung \`${short(d.text)}\` war nie FALSCH oder NULL`;
          if (d.outcomes.T + d.outcomes.F + d.outcomes.N === 0) reason = `Bedingung \`${short(d.text)}\` wurde nie ausgewertet`;
        }
      }
      branches.push({ construct: c.id, constructKind: c.kind, ctx: c.ctx, label: b.label, line: b.line, hits: h, nf: b.nf || (b.derived ? decById.get(b.derived.decision)!.nf : false), reason });
    }
  }

  const loops: LoopResult[] = map.loops.map((l) => ({
    id: l.id, kind: l.kind, line: l.line, endLine: l.endLine, nf: l.nf,
    zero: g(hits.loop, `${l.id}:0`), one: g(hits.loop, `${l.id}:1`), many: g(hits.loop, `${l.id}:n`),
  }));

  // ---- metrics
  const metric = (): Metric => ({ covered: 0, total: 0 });
  const metrics = { stmt: metric(), branch: metric(), cond: metric(), mcdc: metric(), loop: metric() };
  for (const s of statements) if (!s.nf) { metrics.stmt.total++; if (s.hits > 0) metrics.stmt.covered++; }
  for (const b of branches) if (!b.nf) { metrics.branch.total++; if (b.hits > 0) metrics.branch.covered++; }
  for (const d of decisions) {
    if (d.nf) continue;
    for (const c of d.conds) {
      metrics.cond.total += 2;
      metrics.cond.covered += (c.t > 0 ? 1 : 0) + (c.f > 0 ? 1 : 0);
      if (c.mcdc !== 'na') { metrics.mcdc.total++; if (c.mcdc === 'yes') metrics.mcdc.covered++; }
    }
  }
  // A basic LOOP always runs at least once, so "0 iterations" is not a meaningful goal there.
  for (const l of loops) {
    if (l.nf) continue;
    metrics.loop.total += l.kind === 'loop' ? 2 : 3;
    metrics.loop.covered += (l.kind === 'loop' ? 0 : +(l.zero > 0)) + +(l.one > 0) + +(l.many > 0);
  }

  // ---- per-line status
  const lineStatus: Record<number, LineStatus> = {};
  const lineHits: Record<number, number> = {};
  const byLine = new Map<number, { hit: number; miss: number; nf: number }>();
  for (const s of statements) {
    const e = byLine.get(s.line) ?? { hit: 0, miss: 0, nf: 0 };
    if (s.nf) e.nf++; else if (s.hits > 0) e.hit++; else e.miss++;
    byLine.set(s.line, e);
    lineHits[s.line] = Math.max(lineHits[s.line] ?? 0, s.hits);
  }
  for (const [line, e] of byLine) {
    lineStatus[line] = e.miss && e.hit ? 'partial' : e.miss ? 'missed' : e.hit ? 'covered' : 'nf';
  }
  const markPartial = (line: number) => { if (lineStatus[line] === 'covered' || lineStatus[line] === undefined) lineStatus[line] = 'partial'; };
  for (const b of branches) if (!b.nf && b.hits === 0) markPartial(b.line);
  for (const d of decisions) if (!d.nf && d.conds.some((c) => c.t === 0 || c.f === 0 || c.mcdc === 'no')) markPartial(d.line);

  // ---- findings
  const findings: Finding[] = [];
  let run: { from: number; to: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    findings.push({ kind: 'stmt', line: run.from, title: run.from === run.to ? `Zeile ${run.from} nie ausgeführt` : `Zeilen ${run.from}–${run.to} nie ausgeführt` });
    run = null;
  };
  for (const s of [...statements].sort((a, b) => a.line - b.line)) {
    if (s.nf || s.hits > 0) { flushRun(); continue; }
    if (run && s.line <= run.to + 1) run.to = Math.max(run.to, s.endLine);
    else { flushRun(); run = { from: s.line, to: s.endLine }; }
  }
  flushRun();
  for (const b of branches) {
    if (b.nf || b.hits > 0) continue;
    findings.push({ kind: 'branch', line: b.line, title: `Zweig ${b.label} nie durchlaufen`, detail: b.reason });
  }
  for (const d of decisions) {
    if (d.nf) continue;
    for (const c of d.conds) {
      const miss = [c.t === 0 ? 'WAHR' : '', c.f === 0 ? 'FALSCH' : ''].filter(Boolean);
      if (miss.length && (c.t || c.f || c.n)) {
        findings.push({ kind: 'cond', line: c.span.line, title: `Teilbedingung \`${short(c.text)}\` nie ${miss.join(' und nie ')}` });
      }
      if (c.mcdc === 'no' && d.conds.length > 1) {
        findings.push({
          kind: 'mcdc', line: c.span.line,
          title: `MC/DC: unabhängige Wirkung von \`${short(c.text)}\` nicht nachgewiesen`,
          detail: c.suggestion ? `Fehlender Testfall: ${c.suggestion}` : undefined,
        });
      }
    }
  }
  for (const l of loops) {
    if (l.nf) continue;
    const miss = [l.zero || l.kind === 'loop' ? '' : '0-mal', l.one ? '' : 'genau 1-mal', l.many ? '' : 'mehrfach'].filter(Boolean);
    if (miss.length && (l.zero || l.one || l.many)) {
      findings.push({ kind: 'loop', line: l.line, title: `Schleife nie ${miss.join(', nie ')} durchlaufen` });
    }
  }
  findings.sort((a, b) => a.line - b.line);

  return {
    key: `${map.type} ${map.owner}.${map.name}`.toLowerCase(),
    owner: map.owner, name: map.name, type: map.type, lines,
    metrics, statements, branches, decisions, loops, lineStatus, lineHits, gaps: map.gaps, findings,
  };
}

function short(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// ------------------------------------------------------------------ MC/DC

type V = 'T' | 'F' | 'N' | '-';

/** Evaluates the decision for a T/F assignment with PL/SQL short-circuit semantics. */
function evaluate(node: CondNode, assign: ('T' | 'F')[], seen: V[]): boolean {
  switch (node.t) {
    case 'cond':
      seen[node.i - 1] = assign[node.i - 1];
      return assign[node.i - 1] === 'T';
    case 'not':
      return !evaluate(node.c[0], assign, seen);
    case 'and':
      for (const c of node.c) if (!evaluate(c, assign, seen)) return false;
      return true;
    case 'or':
      for (const c of node.c) if (evaluate(c, assign, seen)) return true;
      return false;
  }
}

/** Unique-cause MC/DC with short-circuit relaxation (unevaluated conditions match anything). */
function isPair(i: number, a: { v: string; out: boolean }, b: { v: string; out: boolean }): boolean {
  if (a.out === b.out) return false;
  const ai = a.v[i];
  const bi = b.v[i];
  if (!((ai === 'T' && bi === 'F') || (ai === 'F' && bi === 'T'))) return false;
  for (let j = 0; j < a.v.length; j++) {
    if (j === i) continue;
    if (a.v[j] !== b.v[j] && a.v[j] !== '-' && b.v[j] !== '-') return false;
  }
  return true;
}

function computeMcdc(tree: CondNode, conds: CondResult[], vectors: DecisionResult['vectors']) {
  const n = conds.length;
  const observed = vectors.map((x) => ({ v: x.v.padEnd(n, '-'), out: x.out === 'T' }));
  let candidates: { v: string; out: boolean }[] = [];
  if (n <= 10) {
    for (let mask = 0; mask < 1 << n; mask++) {
      const assign = Array.from({ length: n }, (_, k) => ((mask >> k) & 1 ? 'T' : 'F') as 'T' | 'F');
      const seen: V[] = Array(n).fill('-');
      const out = evaluate(tree, assign, seen);
      const v = seen.join('');
      if (!candidates.some((c) => c.v === v)) candidates.push({ v, out });
    }
  }
  for (let i = 0; i < n; i++) {
    const c = conds[i];
    let ok = false;
    for (let a = 0; a < observed.length && !ok; a++) {
      for (let b = a + 1; b < observed.length && !ok; b++) if (isPair(i, observed[a], observed[b])) ok = true;
    }
    c.mcdc = ok ? 'yes' : 'no';
    if (ok || !candidates.length) continue;
    const fmt = (x: { v: string; out: boolean }) =>
      conds.map((cc, k) => (x.v[k] === '-' ? null : `\`${short(cc.text, 40)}\` = ${WORD[x.v[k]]}`)).filter(Boolean).join(', ') +
      ` → Ergebnis ${x.out ? 'WAHR' : 'FALSCH'}`;
    let suggestion: string | undefined;
    for (const o of observed) {
      const partner = candidates.find((cand) => isPair(i, o, cand));
      if (partner) { suggestion = fmt(partner); break; }
    }
    if (!suggestion) {
      outer: for (const x of candidates) for (const y of candidates) {
        if (isPair(i, x, y)) { suggestion = `${fmt(x)} sowie ${fmt(y)}`; break outer; }
      }
    }
    c.suggestion = suggestion;
  }
}
