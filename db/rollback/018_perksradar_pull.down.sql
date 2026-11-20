-- Rollback of 018_perksradar_pull.sql and of the scorecard week figures released with it. Deploy the previous build
-- first. Removes the Perksradar pull's jobs, its figures and its source record, and the EOS scorecard's week figures
-- (the previous build has no source priority, so a scorecard week next to a weekly report week would show as a
-- conflict). Month totals from the scorecard are kept.
begin;
delete from import_runs where source_id = 'sheet.eos_scorecard' and submission_id like 'eosw:%';
delete from sync_jobs where kind = 'perksradar';
delete from import_runs where source_id = 'pull.perksradar';
delete from source_connections where id = 'pull.perksradar';
alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in ('sheet', 'plant_breakdown', 'gross_profit', 'corporate_gifting', 'task_tracker'));
delete from schema_migrations where name = '018_perksradar_pull.sql';
commit;
