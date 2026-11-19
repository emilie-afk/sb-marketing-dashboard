-- Corporate Gifts resolution and check-off items. Builds on the shared "resolved" status of 015_occasion_planning.sql
-- (status 'resolved' + resolved_in, for drafts handled without a task); it adds no second resolution status.
--  - Drafts follow the Corporate Gifts route: only Marketing tasks are drafts; a draft whose request becomes a
--    check-off item or waits for a routing decision is "moved" (it can come back if routed to Marketing again).
--  - Resolve: a draft not sent yet is closed as "resolved" (015's status; it can never be sent); a task already in
--    Task Tracker gets a resolve request (resolve_requested_at) and is completed there through Task Tracker's own
--    completion rules (resolve_due until Task Tracker confirms); it reads as resolved once Task Tracker shows it done.
--  - corporate_checkoffs mirrors Corporate Gifts check-off items (work owned outside Marketing) and items waiting
--    for a routing decision, for the Corporate Gifts view and the weekly report. Corporate Gifts stays the source.
-- Additive. Drafts already resolved keep their status and resolved_in; their completion date is the day they were
-- resolved (reviewed_at, Vietnam time). Rollback: db/rollback/016_corporate_resolution.down.sql
alter table corporate_task_drafts drop constraint corporate_task_drafts_status_check;
alter table corporate_task_drafts add constraint corporate_task_drafts_status_check check (status in ('pending', 'approved', 'dismissed', 'resolved', 'moved'));
alter table corporate_task_drafts add column route text not null default 'marketing' check (route in ('marketing', 'checkoff', 'review'));
alter table corporate_task_drafts add column resolved_by text check (resolved_by is null or length(resolved_by) <= 120);   -- who resolved (or asked for it)
alter table corporate_task_drafts add column completed_on date;            -- date of the work (report calendar)
alter table corporate_task_drafts add column completion_source text check (completion_source in ('manual', 'slack'));
alter table corporate_task_drafts add column resolve_requested_at timestamptz;              -- Resolve asked for a task in Task Tracker
alter table corporate_task_drafts add column resolve_due boolean not null default false;   -- complete in Task Tracker
alter table corporate_task_drafts add column resolve_error text check (resolve_error is null or length(resolve_error) <= 500);
alter table corporate_task_drafts add column resolve_attempt_at timestamptz;
alter table corporate_task_drafts add column tracker_completed_on date;
alter table corporate_task_drafts add constraint corporate_task_drafts_resolve_request check (resolve_requested_at is null or delivery_status = 'created');
create index corporate_task_drafts_resolve on corporate_task_drafts (resolve_due) where resolve_due;
update corporate_task_drafts set completed_on = (coalesce(reviewed_at, updated_at) at time zone 'Asia/Ho_Chi_Minh')::date, completion_source = 'manual'
 where status = 'resolved' and completed_on is null;
-- A claim sent to Corporate Gifts whose answer was lost (no Task Tracker task was started): released there before the
-- draft is sent again, and on each sync until Corporate Gifts confirms.
alter table corporate_task_drafts add column claim_release_due boolean not null default false;

create table corporate_checkoffs (
  id uuid primary key,                                        -- the Corporate Gifts request id
  title text not null check (length(btrim(title)) between 1 and 300),
  route text not null check (route in ('checkoff', 'review', 'marketing')),
  route_reason text check (route_reason is null or length(route_reason) <= 200),
  owner text check (owner is null or length(owner) <= 120),
  owner_team text check (owner_team in ('marketing', 'outside', 'external')),
  partners jsonb not null default '[]',
  due_date date,
  state text not null check (state in ('open', 'done', 'closed')),
  completed_on date,
  completion_source text check (completion_source in ('manual', 'slack')),
  resolved_by text check (resolved_by is null or length(resolved_by) <= 120),
  resolved_at timestamptz,
  evidence_count int not null default 0,
  cg_version int not null,
  cg_updated_at timestamptz not null,
  read_at timestamptz not null default now(),
  listed boolean not null default true,                       -- false: left the check-off list (kept so an older read can't bring it back)
  check (state <> 'done' or completed_on is not null)
);
create index corporate_checkoffs_open on corporate_checkoffs (state, route) where listed;
-- Position in the Corporate Gifts change feed (source updated_at and id of the last row read).
create table corporate_feed_cursors (
  name text primary key,
  after_at text not null,
  after_id uuid not null,
  updated_at timestamptz not null default now()
);
create index corporate_checkoffs_done on corporate_checkoffs (completed_on) where state = 'done' and listed;
