-- Rolls back 005. Fails if the new sources already hold imported data (by design: export and remove it first).
delete from sync_jobs where kind in ('gross_profit', 'corporate_gifting');
update sync_jobs set status = 'failed' where status = 'partial';
alter table sync_jobs drop constraint sync_jobs_status_check;
alter table sync_jobs add constraint sync_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed', 'abandoned'));
drop index sync_jobs_one_active_pull;
create unique index sync_jobs_one_active_pull on sync_jobs (kind) where kind = 'plant_breakdown' and status in ('queued', 'running');
alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in ('sheet', 'plant_breakdown'));
insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('blocked.gross_profit', 'Gross Profit', 'sb', 'pull', 'blocked', 'Needs a read-only reporting endpoint in that app before it can connect.', '{"seeded":"true"}'),
  ('blocked.corporate_gifting', 'Corporate Gifting', 'sb', 'pull', 'blocked', 'Needs a read-only reporting endpoint in that app before it can connect. Detailed editing stays in that app.', '{"seeded":"true"}')
on conflict (id) do nothing;
delete from source_connections where id in ('pull.gross_profit', 'pull.corporate_gifting');
delete from schema_migrations where name = '005_reporting_pulls.sql';
