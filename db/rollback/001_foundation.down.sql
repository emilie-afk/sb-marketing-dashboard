-- Rolls back 001 (run 003 and 002 rollbacks first). Destroys all imported observations.
drop table if exists rate_limits, audit_events, activities, campaign_inclusions, campaign_performance,
  campaign_status_history, ad_campaigns, product_observations, product_source_ids, products, vendors,
  observations, import_runs, automation_clients, source_connections, metric_definitions, businesses cascade;
drop type if exists value_state, completeness, granularity;
delete from schema_migrations where name = '001_foundation.sql';
