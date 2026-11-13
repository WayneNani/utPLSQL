create or replace procedure archive_orders(p_before date, p_batch pls_integer := 100) is
  l_rows pls_integer;
  procedure log(p_msg varchar2) is
  begin
    dbms_output.put_line(p_msg);
  end log;
begin
  loop
    delete from orders where created < p_before and rownum <= p_batch;
    l_rows := sql%rowcount;
    log('deleted ' || l_rows);
    exit when l_rows < p_batch;
  end loop;
exception
  when others then
    pragma coverage('NOT_FEASIBLE');
    log(sqlerrm);
    raise;
end archive_orders;
/
