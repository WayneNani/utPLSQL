create or replace package order_pricing is
  function discount_pct(p_amount number, p_vip boolean, p_coupon varchar2) return number;
  function shipping_fee(p_country varchar2, p_weight_kg number) return number;
  function risk_class(p_customer_id number) return varchar2;
  procedure apply_bulk_discount(p_order_id number);
end order_pricing;
/
