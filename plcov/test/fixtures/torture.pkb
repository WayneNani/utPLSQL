package body plcov_torture is

  function side(p boolean) return boolean is
  begin
    g_calls := g_calls + 1;
    return p;
  end;

  function shortcircuit(a boolean, b boolean) return varchar2 is
  begin
    g_calls := 0;
    if side(a) and side(b) then
      return 'Y' || g_calls;
    elsif side(a) or side(b) then
      return 'O' || g_calls;
    else
      return 'N' || g_calls;
    end if;
  end;

  function negated(a boolean, b boolean) return varchar2 is
  begin
    g_calls := 0;
    if not (side(a) and side(b)) then
      return 'A' || g_calls;
    elsif not (side(a) or side(b)) then
      return 'B' || g_calls;
    elsif not (not side(b)) and not side(a) then
      return 'C' || g_calls;
    end if;
    return 'D' || g_calls;
  end;

  function nulls(a number) return varchar2 is
  begin
    if a > 1 then return 'T'; elsif not (a > 1) then return 'F'; else return 'N'; end if;
  end;

  function fact(n number) return number is
  begin
    if n <= 1 or fact(n - 1) < 0 then
      return 1;
    end if;
    return n * fact(n - 1);
  end;

  function cnf(p varchar2) return varchar2 is
    l varchar2(10);
  begin
    case p when 'A' then l := 'a'; end case;
    return l;
  exception
    when case_not_found then return 'CNF' || sqlcode;
  end;

  function err_in_cond(p number) return varchar2 is
  begin
    if 1 / p > 0.5 and side(true) then return 'big'; end if;
    return 'small';
  exception
    when zero_divide then return 'ZD';
  end;

  function sql_case(p number) return varchar2 is
    l varchar2(10);
  begin
    select case when p > 1 and p < 10 then 'mid' when p is null then 'null' else 'other' end
      into l from dual;
    return l;
  end;

  function loops(n number) return number is
    s number := 0;
    i number := 0;
  begin
    while i < n loop
      i := i + 1;
      continue when mod(i, 2) = 0;
      s := s + i;
    end loop;
    <<o>>
    for j in 1 .. 3 loop
      for k in 1 .. 3 loop
        exit o when j * k > 4;
        s := s + 1;
      end loop;
    end loop o;
    return s;
  end;

  function check_all return varchar2 is
  begin
    return shortcircuit(true, true) || shortcircuit(true, false) || shortcircuit(false, true) || shortcircuit(null, false)
      || ',' || negated(null, true) || negated(null, false) || negated(true, null) || negated(false, null)
      || negated(null, null) || negated(true, true)
      || ',' || nulls(5) || nulls(0) || nulls(null)
      || ',' || fact(5)
      || ',' || cnf('A') || cnf('B')
      || ',' || err_in_cond(1) || err_in_cond(4) || err_in_cond(0) || nulls(3)
      || ',' || sql_case(5) || sql_case(null) || sql_case(50)
      || ',' || loops(7) || ':' || loops(0);
  end;

end plcov_torture;
