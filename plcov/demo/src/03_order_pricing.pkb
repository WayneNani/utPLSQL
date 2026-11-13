create or replace package body order_pricing is

  function discount_pct(p_amount number, p_vip boolean, p_coupon varchar2) return number is
    l_pct number := 0;
  begin
    if p_vip and p_amount > 1000 then
      l_pct := 10;
    elsif p_coupon is not null or p_amount between 500 and 1000 then
      l_pct := 5;
    end if;
    return l_pct;
  end discount_pct;

  function shipping_fee(p_country varchar2, p_weight_kg number) return number is
    l_fee number;
  begin
    case p_country
      when 'DE' then l_fee := 4.90;
      when 'AT' then l_fee := 7.90;
      when 'CH' then l_fee := 14.90;
    end case;
    if p_weight_kg > 20 then l_fee := l_fee * 2; end if;
    return l_fee;
  exception
    when case_not_found then
      return 24.90;
  end shipping_fee;

  function risk_class(p_customer_id number) return varchar2 is
    l_class varchar2(10);
  begin
    select case
             when c.open_invoices > 3 or c.days_overdue > 60 then 'HIGH'
             when c.open_invoices > 0 then 'MEDIUM'
             else 'LOW'
           end
      into l_class
      from customers c
     where c.id = p_customer_id;
    return l_class;
  exception
    when no_data_found then
      return 'UNKNOWN';
  end risk_class;

  procedure apply_bulk_discount(p_order_id number) is
    l_total number := 0;
  begin
    for r in (select qty, unit_price from order_lines where order_id = p_order_id) loop
      l_total := l_total + r.qty * r.unit_price;
      exit when l_total > 10000;
    end loop;
    update orders
       set discount = case when l_total >= 5000 then 0.03 else 0 end
     where id = p_order_id;
  end apply_bulk_discount;

end order_pricing;
/
