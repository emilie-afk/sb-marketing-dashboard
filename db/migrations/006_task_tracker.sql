-- Task Tracker reporting pull (one way: Task Tracker -> Marketing Dashboard).
-- Tracker tasks live in their own source-owned tables, never in `tasks`, so no dashboard task route or query
-- can edit them. Each row is one reported record: a one-time task or one occurrence of a recurring task.
-- Rows are written only when a complete, validated snapshot is published (atomically); a failed or partial
-- pull changes nothing. Records that leave the source are kept with a removal marker and hidden from views.
create table tracker_task_records (
  source_instance text not null check (source_instance ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  record_id text not null check (record_id ~ '^(task:[0-9a-f-]{36}|occ:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2})$'),
  task_id uuid not null,
  kind text not null check (kind in ('task', 'occurrence')),
  occurrence_date date,
  business_id text not null references businesses(id),
  title text not null check (length(title) between 1 and 300),
  task_type text not null check (task_type in ('routine', 'adhoc', 'video')),
  brand_name text not null check (length(brand_name) between 1 and 80),
  brand_archived boolean not null default false,
  assignee_name text not null check (length(assignee_name) between 1 and 120),
  assignee_archived boolean not null default false,
  recurrence text check (recurrence in ('daily', 'weekdays', 'weekly', 'monthly')),
  due_date date,
  status text not null check (status in ('open', 'done')),
  completed_on date,
  created_on date,
  source_updated_at timestamptz,
  snapshot_id text not null check (snapshot_id ~ '^snp_[0-9a-f]{32}$'),
  synced_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_reason text check (removed_reason is null or removed_reason in ('deleted', 'brand_unassigned', 'brand_not_reported', 'out_of_scope', 'not_in_snapshot', 'no_longer_reported')),
  primary key (source_instance, record_id),
  check ((kind = 'occurrence') = (occurrence_date is not null))
);
create index tracker_task_records_active on tracker_task_records (business_id, due_date) where removed_at is null;
create index tracker_task_records_task on tracker_task_records (source_instance, task_id);

-- One row per published snapshot (source freshness and an audit trail of what was applied).
create table tracker_snapshots (
  id bigserial primary key,
  source_instance text not null,
  snapshot_id text not null,
  generated_at timestamptz not null,
  window_from date not null,
  window_to date not null,
  record_count int not null,
  removal_count int not null,
  marked_removed int not null,
  published_at timestamptz not null default now()
);
create index tracker_snapshots_recent on tracker_snapshots (published_at desc);

alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in ('sheet', 'plant_breakdown', 'gross_profit', 'corporate_gifting', 'task_tracker'));

insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('pull.task_tracker', 'Task Tracker', 'sb', 'pull', 'not_configured', null, '{"seeded":"true"}')
on conflict (id) do nothing;
