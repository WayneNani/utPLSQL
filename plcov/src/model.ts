/** Shared data model: the probe map written by the instrumenter and read by the reporter. */

export type Outcome = 'T' | 'F' | 'N';

/** Boolean structure of a decision, used to compute MC/DC and to suggest missing test vectors. */
export type CondNode =
  | { t: 'cond'; i: number }
  | { t: 'and' | 'or'; c: CondNode[] }
  | { t: 'not'; c: [CondNode] };

export interface Span {
  start: number;
  end: number;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface StatementProbe {
  id: number;
  line: number;
  endLine: number;
  kind: string;
  /** Marked with PRAGMA COVERAGE('NOT_FEASIBLE'). */
  nf: boolean;
}

export interface Condition {
  i: number;
  text: string;
  span: Span;
}

export type DecisionKind = 'if' | 'elsif' | 'while' | 'exit-when' | 'continue-when' | 'case-when' | 'case-expr-when';

export interface Decision {
  id: number;
  kind: DecisionKind;
  /** "sql" decisions run inside the SQL engine (needs 23ai BOOLEAN support). */
  ctx: 'plsql' | 'sql';
  span: Span;
  text: string;
  conds: Condition[];
  tree: CondNode;
  /** Whether full condition vectors are recorded (PL/SQL only, needed for MC/DC). */
  vectors: boolean;
  nf: boolean;
}

export interface Branch {
  label: string;
  line: number;
  col: number;
  nf: boolean;
  /** Branch counted by an explicit probe cov$.b(id). */
  probe?: number;
  /** Branch derived from a decision outcome: taken when decision had outcome T (or not T). */
  derived?: { decision: number; outcome: 'T' | 'notT' };
}

export type ConstructKind = 'if' | 'case' | 'case-expr' | 'handlers' | 'while' | 'exit-when' | 'continue-when';

export interface Construct {
  id: number;
  kind: ConstructKind;
  ctx: 'plsql' | 'sql';
  line: number;
  col: number;
  branches: Branch[];
}

export interface LoopProbe {
  id: number;
  kind: 'loop' | 'while' | 'for' | 'cursor-for';
  line: number;
  endLine: number;
  nf: boolean;
}

export interface Gap {
  line: number;
  reason: string;
}

export interface ObjectMap {
  owner: string;
  name: string;
  type: string;
  /** Source exactly as instrumented (post-processed, line structure identical to the original). */
  source: string;
  statements: StatementProbe[];
  decisions: Decision[];
  constructs: Construct[];
  loops: LoopProbe[];
  gaps: Gap[];
}

/** Global id counters so that probe ids are unique across all objects of a run. */
export interface IdCounters {
  stmt: number;
  dec: number;
  branch: number;
  loop: number;
  construct: number;
}

export const newIds = (): IdCounters => ({ stmt: 1, dec: 1, branch: 1, loop: 1, construct: 1 });

/** Raw hit data as collected from the runtime package. */
export interface Hits {
  stmt: Map<number, number>;
  branch: Map<number, number>;
  /** key `${decision}:${cond}:${T|F|N}` */
  cond: Map<string, number>;
  /** key `${decision}:${T|F|N}` */
  dec: Map<string, number>;
  /** key `${decision}|${vector}|${outcome}` */
  vec: Map<string, number>;
  /** key `${loop}:${0|1|n}` */
  loop: Map<string, number>;
}
