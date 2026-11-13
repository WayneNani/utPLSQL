create table customers (
  id            number primary key,
  name          varchar2(100),
  open_invoices number default 0 not null,
  days_overdue  number default 0 not null
);

create table orders (
  id          number primary key,
  customer_id number references customers,
  created     date default sysdate not null,
  discount    number default 0 not null
);

create table order_lines (
  order_id   number references orders on delete cascade,
  line_no    number,
  qty        number not null,
  unit_price number not null,
  primary key (order_id, line_no)
);
