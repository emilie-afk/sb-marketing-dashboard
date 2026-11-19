-- Corporate Gifts resolution and check-off items.
--  - Drafts follow the Corporate Gifts route: only Marketing tasks are drafts; a draft whose request becomes a
--    check-off item or waits for a routing decision is "moved" (it can come back if routed to Marketing again).
--  - Resolve: a draft not sent yet is closed as "resolved" (it can never be sent); a task already in Task Tracker is
--    completed there through its own completion rules (resolve_due until Task Tracker confirms).
--  - corporate_checkoffs mirrors Corporate Gifts check-off items (work owned outside Marketing) and items waiting
--    for a routing decision, for the Corporate Gifts view and the weekly report. Corporate Gifts stays the source.
--  Builds on 015 (shared "resolved" status, resolved_in, "resolved" receipts): status 'resolved' stays the shared
--  "closed without a Task Tracker task"; completion of a task already in Task Tracker is resolution_state.
-- Additive. Rollback: db/rollback/016_corporate_resolution.down.sql
alter table corporate_task_drafts drop constraint if exists corporate_task_drafts_status_check;
alter table corporate_task_drafts add constraint corporate_task_drafts_status_check check (status in ('pending', 'approved', 'dismissed', 'resolved', 'moved'));
alter table corporate_task_drafts add column route text not null default 'marketing' check (route in ('marketing', 'checkoff', 'review'));
alter table corporate_task_drafts add column resolution_state text check (resolution_state in ('requested', 'resolved'));
alter table corporate_task_drafts add column resolved_by text check (resolved_by is null or length(resolved_by) <= 120);
alter table corporate_task_drafts add column resolved_at timestamptz;
alter table corporate_task_drafts add column completed_on date;            -- date of the work (report calendar)
alter table corporate_task_drafts add column completion_source text check (completion_source in ('manual', 'slack'));
alter table corporate_task_drafts add column resolve_due boolean not null default false;   -- complete in Task Tracker
alter table corporate_task_drafts add column resolve_error text check (resolve_error is null or length(resolve_error) <= 500);
alter table corporate_task_drafts add column resolve_attempt_at timestamptz;
alter table corporate_task_drafts add column tracker_completed_on date;
-- Drafts resolved through 015 are completed records too (date in the report calendar, Vietnam).
update corporate_task_drafts set resolution_state = 'resolved', resolved_at = coalesce(reviewed_at, updated_at),
       completed_on = (coalesce(reviewed_at, updated_at) at time zone 'Asia/Ho_Chi_Minh')::date, completion_source = 'manual'
 where status = 'resolved' and resolution_state is null;
create index corporate_task_drafts_resolve on corporate_task_drafts (resolve_due) where resolve_due;
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
