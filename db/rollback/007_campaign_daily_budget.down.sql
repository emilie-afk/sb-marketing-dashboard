-- Rolls back 007. Drops the recorded daily budgets; spend and results are not touched.
alter table campaign_performance drop column if exists budget_note;
alter table campaign_performance drop column if exists daily_budget;
delete from schema_migrations where name = '007_campaign_daily_budget.sql';
