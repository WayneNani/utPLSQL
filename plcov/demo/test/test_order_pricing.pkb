create or replace package body test_order_pricing is

  procedure vip_large_order is
  begin
    ut.expect(order_pricing.discount_pct(2000, true, null)).to_equal(10);
  end;

  procedure coupon_discount is
  begin
    ut.expect(order_pricing.discount_pct(100, false, 'WELCOME')).to_equal(5);
  end;

  procedure no_discount is
  begin
    ut.expect(order_pricing.discount_pct(100, false, null)).to_equal(0);
  end;

  procedure shipping_de is
  begin
    ut.expect(order_pricing.shipping_fee('DE', 5)).to_equal(4.90);
  end;

  procedure shipping_unknown_country is
  begin
    ut.expect(order_pricing.shipping_fee('US', 5)).to_equal(24.90);
  end;

  procedure risk_high is
  begin
    insert into customers (id, name, open_invoices, days_overdue) values (1, 'Muster GmbH', 5, 0);
    ut.expect(order_pricing.risk_class(1)).to_equal('HIGH');
  end;

  procedure risk_unknown is
  begin
    ut.expect(order_pricing.risk_class(-1)).to_equal('UNKNOWN');
  end;

  procedure bulk_discount is
    l_discount number;
  begin
    insert into customers (id, name) values (2, 'Beispiel AG');
    insert into orders (id, customer_id) values (10, 2);
    insert into order_lines values (10, 1, 20, 150);
    insert into order_lines values (10, 2, 10, 300);
    order_pricing.apply_bulk_discount(10);
    select discount into l_discount from orders where id = 10;
    ut.expect(l_discount).to_equal(0.03);
  end;

  procedure archive_in_batches is
    l_left number;
  begin
    insert into customers (id, name) values (3, 'Archiv KG');
    for i in 1 .. 3 loop
      insert into orders (id, customer_id, created) values (100 + i, 3, date '2020-01-01');
    end loop;
    archive_orders(date '2021-01-01', 2);
    select count(*) into l_left from orders where customer_id = 3;
    ut.expect(l_left).to_equal(0);
  end;

  procedure pricing_load is
    l_sum number := 0;
  begin
    for i in 1 .. 20000 loop
      l_sum := l_sum + order_pricing.discount_pct(2000 + mod(i, 50), true, null);
    end loop;
    ut.expect(l_sum).to_be_greater_than(0);
  end;

end test_order_pricing;
/
