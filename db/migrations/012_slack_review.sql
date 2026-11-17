-- Slack Review: a private queue of task suggestions found in a Slack channel, visible only to the planning owner
-- (PLANNING_OWNER_EMAIL). Nothing here feeds shared views, exports or reporting. Approved suggestions become Task
-- Tracker tasks through the same idempotent delivery as plan assignments. Rollback: db/rollback/012_slack_review.down.sql
create table review_suggestions (
  id uuid primary key default gen_random_uuid(),            -- also the Task Tracker delivery id ("mkp:<id>")
  -- Source identity: channel id, message ts and a stable action id from the scanner. Unique: rescans never duplicate.
  source_key text not null unique check (source_key ~ '^slack:[A-Z0-9]{6,20}:[0-9]{9,11}\.[0-9]{6}:[a-z0-9-]{1,40}$'),
  channel_id text not null check (channel_id ~ '^[A-Z0-9]{6,20}$'),
  message_ts text not null check (message_ts ~ '^[0-9]{9,11}\.[0-9]{6}$'),
  thread_ts text check (thread_ts is null or thread_ts ~ '^[0-9]{9,11}\.[0-9]{6}$'),
  posted_at timestamptz not null,
  message_url text check (message_url is null or message_url ~ '^https://[a-z0-9-]+\.slack\.com/'),
  thread_url text check (thread_url is null or thread_url ~ '^https://[a-z0-9-]+\.slack\.com/'),
  excerpt text not null check (length(excerpt) between 1 and 4000),          -- private: never sent anywhere
  scanner_note text check (scanner_note is null or length(scanner_note) <= 1000),
  deadline_text text check (deadline_text is null or length(deadline_text) <= 200),   -- original wording of an unclear deadline
  flags text[] not null default '{}' check (cardinality(flags) <= 10),
  -- What the scanner suggested (kept as submitted).
  suggested_title text not null check (length(btrim(suggested_title)) between 1 and 300),
  suggested_brief text check (suggested_brief is null or length(suggested_brief) <= 1500),
  suggested_business text check (suggested_business is null or suggested_business in ('sb', 'p2s', 'perksradar')),
  suggested_assignee text check (suggested_assignee is null or length(suggested_assignee) <= 120),
  suggested_due_date date,
  -- Emilie's review. Scans never change these.
  title text not null check (length(btrim(title)) between 1 and 300),
  brief text check (brief is null or length(brief) <= 1500),
  business_id text references businesses(id),
  tracker_brand_id uuid,
  tracker_brand_name text check (tracker_brand_name is null or length(tracker_brand_name) between 1 and 80),
  tracker_assignee_id uuid,
  tracker_assignee_name text check (tracker_assignee_name is null or length(tracker_assignee_name) between 1 and 120),
  due_date date,
  status text not null default 'pending' check (status in ('pending', 'approved', 'dismissed')),
  reviewed_at timestamptz,
  edited boolean not null default false,
  version int not null default 1,
  -- Delivery to Task Tracker (same columns and states as plan_assignments).
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((delivery_status = 'created') = (tracker_task_id is not null)),
  check (status <> 'pending' or delivery_status = 'not_sent'),
  check (status <> 'dismissed' or delivery_status in ('not_sent', 'failed'))
);
create index review_suggestions_status on review_suggestions (status, posted_at desc);
create unique index review_suggestions_task on review_suggestions (tracker_task_id) where tracker_task_id is not null;

-- Later Slack messages about the same action (follow-ups). Private, attached to their suggestion; never overwrite it.
create table review_followups (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid not null references review_suggestions(id) on delete cascade,
  source_key text not null unique check (source_key ~ '^slack:[A-Z0-9]{6,20}:[0-9]{9,11}\.[0-9]{6}:[a-z0-9-]{1,40}$'),
  posted_at timestamptz not null,
  message_url text check (message_url is null or message_url ~ '^https://[a-z0-9-]+\.slack\.com/'),
  excerpt text not null check (length(excerpt) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index review_followups_suggestion on review_followups (suggestion_id, posted_at);

-- The scanner's checkpoint, advanced only in the same transaction that accepts a batch. One row per channel.
create table review_scan_state (
  channel_id text primary key check (channel_id ~ '^[A-Z0-9]{6,20}$'),
  checkpoint_ts text check (checkpoint_ts is null or checkpoint_ts ~ '^[0-9]{9,11}\.[0-9]{6}$'),
  updated_at timestamptz not null default now()
);
-- Accepted batches, by the scanner's batch id (a retried batch is answered from here). Counts only, no message text.
create table review_scan_batches (
  batch_id text primary key check (batch_id ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  channel_id text not null,
  range_from_ts text, range_to_ts text,
  created_count int not null, followup_count int not null, unchanged_count int not null, skipped_count int not null,
  received_at timestamptz not null default now()
);
