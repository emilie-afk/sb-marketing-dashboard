-- Rollback of 020_vendor_profit_metrics.sql. Observations using these metrics must be removed first.
delete from observations where metric_key in ('vendor_product_gp', 'vendor_product_gp_revenue_basis', 'vendor_missing_cost_revenue', 'vendor_missing_cost_lines', 'vendor_breakdown_vendors');
delete from metric_definitions where key in ('vendor_product_gp', 'vendor_product_gp_revenue_basis', 'vendor_missing_cost_revenue', 'vendor_missing_cost_lines', 'vendor_breakdown_vendors');
delete from schema_migrations where name = '020_vendor_profit_metrics.sql';
