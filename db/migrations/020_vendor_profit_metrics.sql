-- Vendor profit by day from the Gross Profit app (its reporting API's days[].vendors). Stored as ordinary daily
-- observations, scoped gp_vendor:<vendor slug>, so the Vendors table can add up exact date ranges (any Saturday–Friday
-- week) from published days only. Product GP is before shipping and covers known-cost lines only; the revenue whose
-- cost is missing is kept beside it. Rollback: db/rollback/020_vendor_profit_metrics.down.sql
insert into metric_definitions (key, label, unit, kind, good_direction, numerator, denominator, acquisition_event, description) values
  ('vendor_product_gp', 'Product gross profit by vendor (before shipping)', 'currency', 'base', 'up', null, null, null,
   'From the Gross Profit app: known-cost product revenue minus known product cost, per vendor and order date. Shipping is not allocated to vendors.'),
  ('vendor_product_gp_revenue_basis', 'Known-cost product revenue by vendor', 'currency', 'base', 'neutral', null, null, null,
   'The revenue a vendor''s product gross profit was calculated on. Used only as that margin''s denominator; never part of revenue totals.'),
  ('vendor_missing_cost_revenue', 'Product revenue with missing cost, by vendor', 'currency', 'base', 'down', null, null, null,
   'Revenue on lines whose product cost is unknown (can be $0 or negative). Not included in product gross profit.'),
  ('vendor_missing_cost_lines', 'Product lines with missing cost, by vendor', 'count', 'base', 'down', null, null, null,
   'Lines whose product cost is unknown. Any line above zero makes that vendor''s product gross profit and margin incomplete.'),
  ('vendor_breakdown_vendors', 'Vendors in the Gross Profit breakdown', 'count', 'base', 'neutral', null, null, null,
   'Coverage marker: the day has a vendor breakdown from a published Gross Profit week.')
on conflict (key) do nothing;
