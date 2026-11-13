/**
 * The in-database runtime: a hit table and the probe package cov$.
 *
 * Probes only count in package memory (associative arrays); nothing is written
 * per hit. flush() persists the counters in one autonomous transaction.
 */

export const HITS_TABLE = `
create table plcov_hits (
  run_id  varchar2(64)  not null,
  kind    varchar2(1)   not null,
  k       varchar2(200) not null,
  hits    number        not null,
  sid     number        default sys_context('userenv', 'sid'),
  created timestamp     default systimestamp
)`;

export const RUNTIME_SPEC = `
create or replace package cov$ authid definer is
  /* plcov runtime: probe functions called by instrumented code. */
  function o(p_d pls_integer) return boolean;
  function c(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean;
  function n(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean;
  function d(p_d pls_integer, p_v boolean) return boolean;
  procedure s(p_s pls_integer);
  procedure b(p_b pls_integer);
  procedure le(p_l pls_integer);
  procedure li(p_l pls_integer);
  procedure lx(p_l pls_integer);
  procedure reset;
  procedure flush(p_run varchar2);
end cov$;`;

/* Recording logic shared by the condition probes c and n (inlined: one call less per condition). */
const PROBE_DECL = `l_v pls_integer; k pls_integer; b pls_integer;`;
const PROBE_BODY = `if p_v then l_v := 0; elsif not p_v then l_v := 1; else l_v := 2; end if;
    k := p_d * 256 + p_i * 4 + l_v;
    if g_c.exists(k) then g_c(k) := g_c(k) + 1; else g_c(k) := 1; end if;
    if g_top > 0 and p_i <= 30 then
      if g_fd(g_top) = p_d then
        b := g_pow(p_i);
        g_fe(g_top) := g_fe(g_top) + b;
        if l_v = 0 then g_ft(g_top) := g_ft(g_top) + b; elsif l_v = 2 then g_fn(g_top) := g_fn(g_top) + b; end if;
      end if;
    end if;`;

export const RUNTIME_BODY = `
create or replace package body cov$ is
  /*
    Hot path uses integer keys only:
      conditions  d*256 + i*4 + v      (v: 0 = TRUE, 1 = FALSE, 2 = NULL)
      decisions   d*4 + v
    Condition vectors (for MC/DC) are kept as three bit masks per open frame
    (evaluated / true / null) and turned into one string key per decision outcome.
  */
  type t_num is table of pls_integer index by pls_integer;
  type t_str is table of pls_integer index by varchar2(200);

  g_s  t_num;   -- statement hits
  g_b  t_num;   -- explicit branch hits
  g_c  t_num;   -- condition values
  g_d  t_num;   -- decision outcomes
  g_v  t_str;   -- condition vectors  d|evaluated|true|null|outcome
  g_l  t_str;   -- loop iterations    l:0|1|n
  g_li t_num;   -- open loop iteration counters
  g_fd t_num;   -- frame stack: decision id
  g_fe t_num;   -- frame stack: evaluated mask
  g_ft t_num;   -- frame stack: true mask
  g_fn t_num;   -- frame stack: null mask
  g_pow t_num;
  g_top pls_integer := 0;

  function o(p_d pls_integer) return boolean is
    pragma udf;
  begin
    if g_top >= 1000 then g_top := 0; end if;   -- leaked frames after exceptions
    g_top := g_top + 1;
    g_fd(g_top) := p_d;
    g_fe(g_top) := 0;
    g_ft(g_top) := 0;
    g_fn(g_top) := 0;
    return true;
  exception when others then return true;
  end;

  /*
    Conditions are evaluated in a jumping-code context (IF, WHILE, WHEN): only "is it TRUE?"
    matters, and Oracle short-circuits NULL like FALSE. To keep exactly that evaluation order
    (and therefore all side effects), probes record the real value but return it mapped:
      c: positive polarity, NULL -> FALSE
      n: under an odd number of NOTs, NULL -> TRUE
  */
  function c(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean is
    pragma udf;
    ${PROBE_DECL}
  begin
    ${PROBE_BODY}
    return case when p_v then true else false end;   -- NULL -> FALSE
  exception when others then return case when p_v then true else false end;
  end;

  function n(p_d pls_integer, p_i pls_integer, p_v boolean) return boolean is
    pragma udf;
    ${PROBE_DECL}
  begin
    ${PROBE_BODY}
    return case when not p_v then false else true end; -- NULL -> TRUE
  exception when others then return case when not p_v then false else true end;
  end;

  function d(p_d pls_integer, p_v boolean) return boolean is
    pragma udf;
    l_v pls_integer;
    k   pls_integer;
    ks  varchar2(200);
  begin
    if p_v then l_v := 0; elsif not p_v then l_v := 1; else l_v := 2; end if;
    k := p_d * 4 + l_v;
    if g_d.exists(k) then g_d(k) := g_d(k) + 1; else g_d(k) := 1; end if;
    k := g_top;
    while k > 0 and g_fd(k) != p_d loop
      k := k - 1;
    end loop;
    if k > 0 then
      ks := p_d || '|' || g_fe(k) || '|' || g_ft(k) || '|' || g_fn(k) || '|' || l_v;
      if g_v.exists(ks) then g_v(ks) := g_v(ks) + 1; else g_v(ks) := 1; end if;
      g_top := k - 1;
    end if;
    return p_v;
  exception when others then return p_v;
  end;

  procedure s(p_s pls_integer) is
  begin
    if g_s.exists(p_s) then g_s(p_s) := g_s(p_s) + 1; else g_s(p_s) := 1; end if;
  exception when others then null;
  end;

  procedure b(p_b pls_integer) is
  begin
    if g_b.exists(p_b) then g_b(p_b) := g_b(p_b) + 1; else g_b(p_b) := 1; end if;
  exception when others then null;
  end;

  procedure close_loop(p_l pls_integer) is
    ks varchar2(30);
  begin
    if g_li.exists(p_l) then
      ks := p_l || ':' || case when g_li(p_l) = 0 then '0' when g_li(p_l) = 1 then '1' else 'n' end;
      if g_l.exists(ks) then g_l(ks) := g_l(ks) + 1; else g_l(ks) := 1; end if;
      g_li.delete(p_l);
    end if;
  end;

  procedure le(p_l pls_integer) is
  begin
    close_loop(p_l);
    g_li(p_l) := 0;
  exception when others then null;
  end;

  procedure li(p_l pls_integer) is
  begin
    if g_li.exists(p_l) then g_li(p_l) := g_li(p_l) + 1; else g_li(p_l) := 1; end if;
  exception when others then null;
  end;

  procedure lx(p_l pls_integer) is
  begin
    close_loop(p_l);
  exception when others then null;
  end;

  procedure reset is
  begin
    g_s.delete; g_b.delete; g_c.delete; g_d.delete; g_v.delete; g_l.delete; g_li.delete;
    g_fd.delete; g_fe.delete; g_ft.delete; g_fn.delete; g_top := 0;
  end;

  procedure flush(p_run varchar2) is
    pragma autonomous_transaction;
    k  pls_integer;
    ks varchar2(200);
    procedure put(p_kind varchar2, p_k varchar2, p_hits pls_integer) is
    begin
      insert into plcov_hits (run_id, kind, k, hits) values (p_run, p_kind, p_k, p_hits);
    end;
    function tfn(p pls_integer) return varchar2 is
    begin
      return case p when 0 then 'T' when 1 then 'F' else 'N' end;
    end;
  begin
    k := g_li.first;
    while k is not null loop
      close_loop(k);
      k := g_li.first;
    end loop;
    k := g_s.first; while k is not null loop put('S', k, g_s(k)); k := g_s.next(k); end loop;
    k := g_b.first; while k is not null loop put('B', k, g_b(k)); k := g_b.next(k); end loop;
    k := g_c.first;
    while k is not null loop
      put('C', trunc(k / 256) || ':' || trunc(mod(k, 256) / 4) || ':' || tfn(mod(k, 4)), g_c(k));
      k := g_c.next(k);
    end loop;
    k := g_d.first;
    while k is not null loop
      put('D', trunc(k / 4) || ':' || tfn(mod(k, 4)), g_d(k));
      k := g_d.next(k);
    end loop;
    ks := g_v.first; while ks is not null loop put('V', ks, g_v(ks)); ks := g_v.next(ks); end loop;
    ks := g_l.first; while ks is not null loop put('L', ks, g_l(ks)); ks := g_l.next(ks); end loop;
    commit;
    reset;
  end;

begin
  for i in 1 .. 30 loop
    g_pow(i) := power(2, i - 1);
  end loop;
end cov$;`;
