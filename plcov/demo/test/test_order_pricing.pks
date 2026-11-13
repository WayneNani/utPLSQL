create or replace package test_order_pricing is
  --%suite(Order pricing)

  --%test(VIP with large order gets 10 percent)
  procedure vip_large_order;
  --%test(Coupon gives 5 percent)
  procedure coupon_discount;
  --%test(No discount for small orders)
  procedure no_discount;

  --%test(Shipping to Germany)
  procedure shipping_de;
  --%test(Unknown country uses fallback fee)
  procedure shipping_unknown_country;

  --%test(Customer with many open invoices is high risk)
  procedure risk_high;
  --%test(Unknown customer)
  procedure risk_unknown;

  --%test(Bulk discount for large orders)
  procedure bulk_discount;

  --%test(Archive deletes old orders in batches)
  procedure archive_in_batches;

  --%test(Pricing under load)
  procedure pricing_load;
end test_order_pricing;
/
