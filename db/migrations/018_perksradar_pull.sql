-- Perksradar reporting pull: daily counts (sign-ups, cards added, reminders sent, emails delivered / opened / clicked)
-- from the Perksradar app's read-only reporting API. Adds the pull as a sync job kind and its source record (not
-- configured until PERKSRADAR_API_URL and PERKSRADAR_REPORTING_SECRET are set). No existing data changes.
-- Rollback: db/rollback/018_perksradar_pull.down.sql
alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in ('sheet', 'plant_breakdown', 'gross_profit', 'corporate_gifting', 'task_tracker', 'perksradar'));
insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('pull.perksradar', 'Perksradar', 'perksradar', 'pull', 'not_configured', null, '{"seeded":"true"}')
on conflict (id) do nothing;
