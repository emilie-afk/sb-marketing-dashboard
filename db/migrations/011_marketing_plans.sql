-- Marketing Planning. Plans are owned by the dashboard (separate from promotions imported from the spreadsheets,
-- which keep syncing one way). Their assigned tasks are created in Task Tracker, which owns them; a plan keeps
-- only the link and the last task state it read. Rollback: db/rollback/011_marketing_plans.down.sql
--
-- Who sees what is decided on the server (server/planning.ts): the planning owner (PLANNING_OWNER_EMAIL) sees and
-- edits every plan; everyone else sees published plans in a rolling three-calendar-month window (Vietnam dates).
create table marketing_plans (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references businesses(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- Linked occasion (optional): a recurring gift occasion and its occurrence year, or a spreadsheet occasion.
  gift_occasion_id text references gift_occasions(id) on delete restrict,
  occurrence_year int check (occurrence_year is null or occurrence_year between 2000 and 2100),
  sheet_occasion_id uuid references occasions(id) on delete set null,
  promotion_id uuid references promotions(id) on delete set null,
  prep_start date not null,
  campaign_start date not null,
  campaign_end date not null,
  objective text check (objective is null or length(objective) <= 2000),
  channels text[] not null default '{}' check (cardinality(channels) <= 12),
  target_audience text check (target_audience is null or length(target_audience) <= 500),
  message_angle text check (message_angle is null or length(message_angle) <= 500),
  deliverables text check (deliverables is null or length(deliverables) <= 2000),
  notes text check (notes is null or length(notes) <= 4000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  check (prep_start <= campaign_start and campaign_start <= campaign_end),
  check ((status = 'published') = (published_at is not null)),
  check (occurrence_year is null or gift_occasion_id is not null),
  check (gift_occasion_id is null or sheet_occasion_id is null)
);
create index marketing_plans_prep on marketing_plans (status, prep_start, campaign_end);
create index marketing_plans_gift on marketing_plans (gift_occasion_id, occurrence_year) where gift_occasion_id is not null;
create index marketing_plans_sheet on marketing_plans (sheet_occasion_id) where sheet_occasion_id is not null;

-- One row per planned assignment. Its id is stable and is the Task Tracker idempotency key ("mkp:<id>"), so a
-- retry never creates a second task. Delivery state is kept apart from the plan's publication state.
create table plan_assignments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references marketing_plans(id) on delete cascade,
  sort_order int not null default 0,
  title text not null check (length(btrim(title)) between 1 and 300),
  brief text check (brief is null or length(brief) <= 1500),
  tracker_brand_id uuid not null,
  tracker_brand_name text not null check (length(tracker_brand_name) between 1 and 80),
  tracker_assignee_id uuid not null,
  tracker_assignee_name text not null check (length(tracker_assignee_name) between 1 and 120),
  due_date date not null,
  -- not_sent → sending (recorded BEFORE Task Tracker is called) → created | failed (refused: nothing was created) |
  -- unknown (no answer: the task may exist). While sending or unknown the assignment cannot be edited or removed;
  -- it is reconciled by its id (the idempotency key) on retry or Check Task Tracker.
  delivery_status text not null default 'not_sent' check (delivery_status in ('not_sent', 'sending', 'created', 'failed', 'unknown')),
  delivery_error text check (delivery_error is null or length(delivery_error) <= 500),
  last_attempt_at timestamptz,
  -- The greatest sent_at of any creation request sent for this assignment (stored before the request leaves), and the
  -- fence Task Tracker returned when it last confirmed that no task exists. An unanswered attempt is settled only when a
  -- fence covers highest_sent_at; every new request is sent with a sent_at after both values.
  highest_sent_at timestamptz,
  fenced_through timestamptz,
  -- Task Tracker's task, as last read from it (creation, retry or an explicit check). Status shown on the plan
  -- comes from the newer of this and the reporting sync (tracker_task_records).
  tracker_task_id uuid,
  tracker_version int,
  tracker_title text,
  tracker_due_date date,
  tracker_status text check (tracker_status is null or tracker_status in ('open', 'done', 'deleted')),
  tracker_assignee_name_now text,
  tracker_updated_at timestamptz,
  tracker_read_at timestamptz,
  created_at timestamptz not null default now(),
  check ((delivery_status = 'created') = (tracker_task_id is not null))
);
create index plan_assignments_plan on plan_assignments (plan_id, sort_order);
create unique index plan_assignments_task on plan_assignments (tracker_task_id) where tracker_task_id is not null;
