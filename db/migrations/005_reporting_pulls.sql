-- Reporting pulls from the team's other apps run as background jobs, like spreadsheet syncs:
-- Plant Revenue Breakdown (existing), Gross Profit and Corporate Gifting (new read-only reporting APIs).
-- One queued or running job per pull at a time. Content Intelligence stays inactive (still blocked).
alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in ('sheet', 'plant_breakdown', 'gross_profit', 'corporate_gifting'));
-- A pull that imported some records but not all (or did not finish paging) is recorded as partial, not success.
alter table sync_jobs drop constraint sync_jobs_status_check;
alter table sync_jobs add constraint sync_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'abandoned'));
drop index sync_jobs_one_active_pull;
create unique index sync_jobs_one_active_pull on sync_jobs (kind) where kind <> 'sheet' and status in ('queued', 'running');

insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('pull.gross_profit', 'Gross Profit', 'sb', 'pull', 'not_configured', null, '{"seeded":"true"}'),
  ('pull.corporate_gifting', 'Corporate Gifting', 'sb', 'pull', 'not_configured', null, '{"seeded":"true"}')
on conflict (id) do nothing;
-- The placeholders they replace held no data.
delete from source_connections s where s.id in ('blocked.gross_profit', 'blocked.corporate_gifting')
  and not exists (select 1 from import_runs r where r.source_id = s.id);
