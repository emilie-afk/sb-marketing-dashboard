-- Corporate Gifts tasks: explicit, open Corporate Gifts actions found by the Corporate Gifts app (from Slack or added
-- there by hand) wait here as drafts for the planning owner, who assigns them (a configured default, in bulk if needed)
-- and sends them to Task Tracker with the same idempotent delivery as plan assignments and Slack Review. They then
-- appear in Marketing Tasks through the normal Task Tracker sync. Each draft's id is the Corporate Gifts request id,
-- so re-reading the request never creates a second draft or a second task. Delivery results are reported back to
-- Corporate Gifts (receipts). Only the title, brief (with marketplace links), brand, assignee and due date go to Task
-- Tracker. Rollback: db/rollback/014_corporate_tasks.down.sql
create table corporate_task_drafts (
  id uuid primary key,                                        -- the Corporate Gifts request id (delivery id "mkp:<id>")
  -- As read from Corporate Gifts (updated on every read).
  cg_title text not null check (length(btrim(cg_title)) between 1 and 300),
  cg_brief text check (cg_brief is null or length(cg_brief) <= 1500),
  owner_hint text check (owner_hint is null or length(owner_hint) <= 80),
  partners jsonb not null default '[]',                       -- [{ name, url }] (Corporate Gifts marketplace links)
  cg_due_date date,
  slack_status text not null default 'open' check (slack_status in ('open', 'done', 'cancelled')),
  cg_delivery_status text not null,
  cg_content_version int not null check (cg_content_version >= 1),
  cg_read_at timestamptz not null default now(),
  -- The planning owner's review. Reads never change these once edited.
  title text not null check (length(btrim(title)) between 1 and 300),
  brief text check (brief is null or length(brief) <= 2000),
  tracker_brand_id uuid,
  tracker_brand_name text check (tracker_brand_name is null or length(tracker_brand_name) between 1 and 80),
  tracker_assignee_id uuid,
  tracker_assignee_name text check (tracker_assignee_name is null or length(tracker_assignee_name) between 1 and 120),
  due_date date,
  status text not null default 'pending' check (status in ('pending', 'approved', 'dismissed')),
  edited boolean not null default false,
  reviewed_at timestamptz,
  version int not null default 1,
  -- Delivery to Task Tracker (same columns and states as plan_assignments and review_suggestions).
  delivery_status text not null default 'not_sent' check (delivery_status in ('not_sent', 'sending', 'created', 'failed', 'unknown')),
  delivery_error text check (delivery_error is null or length(delivery_error) <= 500),
  last_attempt_at timestamptz,
  highest_sent_at timestamptz,
  fenced_through timestamptz,
  tracker_task_id uuid,
  tracker_version int,
  tracker_title text,
  tracker_due_date date,
  tracker_status text check (tracker_status is null or tracker_status in ('open', 'done', 'deleted')),
  tracker_assignee_name_now text,
  tracker_updated_at timestamptz,
  tracker_read_at timestamptz,
  open_url text,
  -- Corporate Gifts content version whose due date Task Tracker already has (after delivery).
  synced_content_version int,
  -- Receipt to Corporate Gifts: what was last reported, and whether a new one is due.
  receipt_due boolean not null default true,
  receipt_state text check (receipt_state is null or receipt_state in ('in_review', 'delivered', 'failed', 'dismissed')),
  receipt_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((delivery_status = 'created') = (tracker_task_id is not null)),
  check (status <> 'pending' or delivery_status = 'not_sent'),
  check (status <> 'dismissed' or delivery_status in ('not_sent', 'failed'))
);
create index corporate_task_drafts_status on corporate_task_drafts (status, created_at desc);
create index corporate_task_drafts_receipts on corporate_task_drafts (receipt_due) where receipt_due;
create unique index corporate_task_drafts_task on corporate_task_drafts (tracker_task_id) where tracker_task_id is not null;
