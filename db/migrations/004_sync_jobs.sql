-- Background sync jobs. The scheduled function and the "Refresh from spreadsheet" button only queue a job and
-- start the background function; the sync itself runs there. At most one queued or running job per spreadsheet
-- (and one Plant Revenue Breakdown pull) at a time. A job whose lease has passed (the background function was
-- stopped) is marked abandoned before a new one may start. Sync results stay in sync_runs as before.
create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sheet', 'plant_breakdown')),
  sheet_source_id uuid references sheet_sources(id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual')),
  actor text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'abandoned')),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz not null,
  result jsonb,
  error text,
  check ((kind = 'sheet') = (sheet_source_id is not null))
);
create unique index sync_jobs_one_active_sheet on sync_jobs (sheet_source_id) where kind = 'sheet' and status in ('queued', 'running');
create unique index sync_jobs_one_active_pull on sync_jobs (kind) where kind = 'plant_breakdown' and status in ('queued', 'running');
create index sync_jobs_recent on sync_jobs (queued_at desc);
