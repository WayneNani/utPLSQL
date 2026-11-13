import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrument } from '../src/instrument.js';
import { analyze } from '../src/analyze.js';
import { newIds, type Hits } from '../src/model.js';

const run = (src: string, sqlProbes = true) => instrument(src, 'S', newIds(), { sqlProbes });
const proc = (body: string, decl = '') => `procedure p(a number, b number, c boolean) is\n${decl}begin\n${body}\nend p;\n`;

test('keeps line count and never inserts line breaks', () => {
  const src = proc('  if a > 1\n     and b > 2 then\n    null;\n  end if;');
  const r = run(src);
  assert.equal(r.instrumented.split('\n').length, src.split('\n').length);
  assert.match(r.instrumented, /cov\$\.d\(1,cov\$\.o\(1\) and \(cov\$\.c\(1,1,a > 1\)\n\s+and cov\$\.c\(1,2,b > 2\)\)\) then/);
});

test('BETWEEN ... AND stays one condition', () => {
  const r = run(proc('  if a between 1 and 5 and b = 2 then null; end if;'));
  assert.deepEqual(r.map.decisions[0].conds.map((c) => c.text), ['a between 1 and 5', 'b = 2']);
});

test('parentheses and NOT build the boolean tree', () => {
  const r = run(proc('  if not (a > 1 or b > 1) and c then null; end if;'));
  const d = r.map.decisions[0];
  assert.deepEqual(d.tree, { t: 'and', c: [{ t: 'not', c: [{ t: 'or', c: [{ t: 'cond', i: 1 }, { t: 'cond', i: 2 }] }] }, { t: 'cond', i: 3 }] });
  // under NOT the probes use negative polarity (n) so NULL short-circuits like in the original
  assert.match(r.instrumented, /not \(cov\$\.n\(1,1,a > 1\) or cov\$\.n\(1,2,b > 1\)\) and cov\$\.c\(1,3,c\)/);
});

test('parenthesised comparison and function calls are atoms', () => {
  const r = run(proc("  if (a > 1) and nvl(b, 0) in (1, 2) and f(a and c) then null; end if;"));
  assert.deepEqual(r.map.decisions[0].conds.map((c) => c.text), ['(a > 1)', 'nvl(b, 0) in (1, 2)', 'f(a and c)']);
});

test('keywords in strings and comments are ignored', () => {
  const r = run(proc("  if a = 1 /* then if */ then -- if b then\n    dbms_output.put_line('end if; then and');\n    x := q'[ end; ]';\n  end if;"));
  assert.equal(r.map.decisions.length, 1);
  assert.equal(r.map.statements.length, 3);
});

test('simple CASE statement gets branch probes and keeps CASE_NOT_FOUND semantics', () => {
  const r = run(proc("  case a\n    when 1 then null;\n    when 2 then null;\n  end case;"));
  assert.match(r.instrumented, /else cov\$\.b\(3\); raise case_not_found; end case;/);
  assert.equal(r.map.constructs[0].branches.length, 3);
});

test('searched CASE statement derives branches from decisions', () => {
  const r = run(proc('  case\n    when a > 1 then null;\n    else null;\n  end case;'));
  const c = r.map.constructs[0];
  assert.deepEqual(c.branches.map((b) => b.derived?.outcome), ['T', 'notT']);
});

test('labels, loops and EXIT label WHEN', () => {
  const r = run(proc('  <<outer>>\n  for i in 1 .. 3 loop\n    exit outer when i = 2;\n  end loop outer;'));
  assert.match(r.instrumented, /cov\$\.s\(1\);cov\$\.le\(1\);<<outer>>/);
  assert.match(r.instrumented, /exit outer when cov\$\.d\(1,/);
  assert.match(r.instrumented, /end loop outer; cov\$\.lx\(1\);/);
  assert.equal(r.map.loops[0].kind, 'for');
});

test('probe goes in front of PRAGMA INLINE', () => {
  const r = run(proc("  pragma inline(f, 'YES');\n  x := f(1);"));
  assert.match(r.instrumented, /cov\$\.s\(1\);pragma inline\(f, 'YES'\);\n  x := f\(1\);/);
});

test('PRAGMA COVERAGE NOT_FEASIBLE marks the rest of the block', () => {
  const r = run(proc("  null;\nexception\n  when others then\n    pragma coverage('NOT_FEASIBLE');\n    log(1);\n    raise;"));
  assert.deepEqual(r.map.statements.map((s) => s.nf), [false, true, true]);
  assert.equal(r.map.constructs[0].branches[0].nf, true);
});

test('package body with nested and forward-declared subprograms', () => {
  const src = `package body pk is
  g number := case when sysdate > date '2000-01-01' then 1 else 0 end;
  procedure fwd;
  function f(x number) return number deterministic is
    function inner(y number) return number is begin return y; end;
  begin
    return inner(x);
  end f;
  procedure fwd is begin null; end;
begin
  g := 2;
end pk;
`;
  const r = run(src);
  assert.equal(r.map.type, 'PACKAGE BODY');
  assert.equal(r.map.name, 'PK');
  assert.equal(r.map.statements.length, 4);
  assert.equal(r.map.decisions[0].kind, 'case-expr-when');
});

test('type body constructor with RETURN SELF AS RESULT', () => {
  const src = `type body t is
  constructor function t(p number) return self as result is
  begin
    self.v := p;
    return;
  end;
  member function get return number is begin return self.v; end;
end;
`;
  const r = run(src);
  assert.equal(r.map.type, 'TYPE BODY');
  assert.equal(r.map.statements.length, 3);
});

test('trigger body is instrumented, WHEN clause reported as gap', () => {
  const src = `trigger trg before insert on t for each row when (new.x > 0)
declare
  v number;
begin
  if :new.x > 10 then :new.x := 10; end if;
end;
`;
  const r = run(src);
  assert.equal(r.map.type, 'TRIGGER');
  assert.equal(r.map.decisions.length, 1);
  assert.equal(r.map.gaps.length, 1);
});

test('SQL: CASE in select list and SET is instrumented, WHERE and GROUP BY are not', () => {
  const r = run(proc(`  select case when a > 1 then 1 end into x from dual where case when b > 1 then 1 end = 1;
  select case when a > 1 then 1 end, count(*) into x, y from dual group by case when a > 1 then 1 end;
  update t set v = case when c then 1 else 0 end where id = 1;`));
  assert.equal(r.map.decisions.filter((d) => d.ctx === 'sql').length, 2);
  assert.ok(r.map.gaps.some((g) => g.reason.includes('WHERE')));
  assert.ok(r.map.gaps.some((g) => g.reason.includes('GROUP BY')));
});

test('SQL probes can be switched off for databases before 23ai', () => {
  const r = run(proc('  select case when a > 1 then 1 end into x from dual;'), false);
  assert.equal(r.map.decisions.length, 0);
  assert.match(r.map.gaps[0].reason, /23ai/);
});

test('MC/DC: detects independence pairs and proposes the missing vector', () => {
  const r = run(proc('  if a > 1 and b > 1 then null; end if;'));
  const hits: Hits = { stmt: new Map(), branch: new Map(), cond: new Map(), dec: new Map(), vec: new Map(), loop: new Map() };
  // observed: (T,T)->T and (F,-)->F
  hits.vec.set(`1|TT|T`, 3);
  hits.vec.set(`1|F-|F`, 2);
  for (const k of ['1:1:T', '1:1:F', '1:2:T']) hits.cond.set(k, 1);
  hits.dec.set('1:T', 3);
  hits.dec.set('1:F', 2);
  const res = analyze(r.map, hits);
  const [c1, c2] = res.decisions[0].conds;
  assert.equal(c1.mcdc, 'yes');
  assert.equal(c2.mcdc, 'no');
  assert.match(c2.suggestion!, /`a > 1` = WAHR, `b > 1` = FALSCH → Ergebnis FALSCH/);
  assert.deepEqual(res.metrics.mcdc, { covered: 1, total: 2 });
  assert.deepEqual(res.metrics.branch, { covered: 2, total: 2 });
});
