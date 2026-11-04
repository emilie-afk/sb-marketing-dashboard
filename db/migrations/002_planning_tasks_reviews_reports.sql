-- Promotions and spreadsheet sync, tasks, Etsy listing reviews, reports and private attachments.
-- Rollback: db/rollback/002_planning_tasks_reviews_reports.down.sql

-- ------------------------------------------------------------ spreadsheet registry and sync
-- One row per registered Google spreadsheet, added in Settings without code changes.
-- Roles: annual_calendar (occasions + monthly promotion tabs), seasonal_program (e.g. Nov to Dec program),
-- intake (structured results appended by scheduled tasks: listing checks, ads, activities, metrics).
-- All reads are one-way: spreadsheet to dashboard. The dashboard never writes to a spreadsheet.
create table sheet_sources (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references businesses(id),
  year int check (year between 2020 and 2100),
  role text not null check (role in ('annual_calendar', 'seasonal_program', 'intake')),
  label text not null,
  file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{20,80}$'),  -- Drive file id; server-side only
  file_kind text not null check (file_kind in ('google_sheet', 'xlsx')),
  sync_interval_minutes int not null default 360 check (sync_interval_minutes between 15 and 10080),
  active boolean not null default true,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (file_id, role),
  check (role = 'intake' or year is not null)
);

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  sheet_source_id uuid not null references sheet_sources(id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'failed', 'partial')),
  tabs_read jsonb not null default '[]'::jsonb,
  created_count int not null default 0,
  updated_count int not null default 0,
  unchanged_count int not null default 0,
  review_count int not null default 0,
  error text,
  actor text not null
);

-- Promotions, occasions-in-use, vendor offers and special collections share one record type.
create table promotions (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references businesses(id),
  year int not null,
  kind text not null check (kind in ('promotion', 'vendor_offer', 'special_collection', 'launch', 'milestone')),
  title text not null,
  start_date date,
  end_date date,
  date_text text,                              -- the source text, kept verbatim
  offer text,
  code text,
  channels text,
  materials text,
  vendor text,
  vendor_cost_reduction numeric,               -- vendor side; never mixed with customer discount
  customer_discount numeric,
  special_dates_text text,                     -- e.g. BF/CM dates
  special_cost_reduction numeric,
  special_customer_discount numeric,
  terms text,
  collection_url text,
  feature_date date,                           -- special collections: the day it is featured
  prep_deadline date,
  -- Dashboard-owned fields: never written by sync.
  execution_status text not null default 'planned'
    check (execution_status in ('planned', 'preparing', 'ready', 'launched', 'ended', 'cancelled')),
  execution_note text,
  owner text,
  -- Sync bookkeeping
  review_state text not null default 'ok' check (review_state in ('ok', 'needs_review')),
  missing_from_source_since timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index promotions_dates on promotions (business_id, start_date);

-- Persisted identity mapping: a stable key per source row identity, so renamed or moved rows keep their promotion.
create table promotion_source_links (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references promotions(id) on delete cascade,
  sheet_source_id uuid not null references sheet_sources(id) on delete cascade,
  identity_key text not null,                  -- e.g. 'code:<CODE>', 'vendor:<slug>', 'title:<slug>:<start>'
  last_tab text,
  last_row int,                                -- informational only, never identity
  last_values jsonb,
  last_seen_at timestamptz,
  unique (sheet_source_id, identity_key)
);

create table promotion_revisions (
  id bigserial primary key,
  promotion_id uuid not null references promotions(id) on delete cascade,
  sync_run_id uuid references sync_runs(id) on delete set null,
  changed_by text not null,
  changed_at timestamptz not null default now(),
  changes jsonb not null                        -- { field: { from, to } }
);

create table review_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('conflict', 'removed_from_source', 'ambiguous_match', 'unparsed_date', 'blank_tab', 'finding_dependency')),
  promotion_id uuid references promotions(id) on delete cascade,
  finding_id uuid,
  sync_run_id uuid references sync_runs(id) on delete set null,
  details jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);
create index review_items_open on review_items (created_at) where resolved_at is null;

-- Annual occasions. An occasion only becomes an execution record when selected for use.
create table occasions (
  id uuid primary key default gen_random_uuid(),
  sheet_source_id uuid references sheet_sources(id) on delete set null,
  business_id text not null references businesses(id),
  identity_key text not null,
  name text not null,
  occasion_date date not null,
  occasion_type text,
  note text,
  selected_promotion_id uuid references promotions(id) on delete set null,
  unique (business_id, identity_key)
);

-- ------------------------------------------------------------ tasks
create table tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 300),
  business_id text not null references businesses(id),
  activity text,
  owner text,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'waiting', 'done', 'cancelled')),
  due_date date,
  promotion_id uuid references promotions(id) on delete set null,
  -- Recurrence: null for one-off. 'weekly:1' (ISO weekday), 'monthly:15', 'daily'.
  recurrence text check (recurrence is null or recurrence ~ '^(daily|weekly:[1-7]|monthly:([1-9]|[12][0-9]|3[01]|last))$'),
  recurrence_until date,
  description text,
  source text not null default 'dashboard',     -- 'dashboard' | 'finding_approval'
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  version int not null default 1
);
-- Occurrences of a recurring task. Each has its own status; the series stays one task.
create table task_occurrences (
  task_id uuid not null references tasks(id) on delete cascade,
  due_date date not null,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'waiting', 'done', 'cancelled')),
  owner text,
  completed_at timestamptz,
  primary key (task_id, due_date)
);
create table task_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  target_type text not null check (target_type in ('product', 'vendor', 'listing', 'campaign', 'finding', 'promotion', 'report', 'url')),
  target_id text,
  url text,
  label text
);
create table task_updates (
  id bigserial primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  changes jsonb not null,
  comment text
);

-- ------------------------------------------------------------ Etsy listing reviews
create table listing_review_runs (
  run_id text primary key check (run_id ~ '^[A-Za-z0-9_.:-]{3,80}$'),
  import_run_id uuid references import_runs(id) on delete cascade,
  business_id text not null references businesses(id),
  window_start date not null,                  -- the check's own 30-day window
  window_end date not null,
  timezone text not null,
  collected_at timestamptz not null,
  scope_note text not null,                    -- e.g. 'listings with >= 1 click, excluding one listing'
  excluded_listing_ids text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'superseded'))
);
create table listing_results (
  run_id text not null references listing_review_runs(run_id) on delete cascade,
  listing_id text not null check (listing_id ~ '^[0-9]{4,20}$'),
  title text not null,
  url text,
  clicks numeric, orders numeric, spend numeric,
  primary key (run_id, listing_id)
);
create table listing_options (
  run_id text not null,
  listing_id text not null,
  option_key text not null,
  label text not null,
  format text not null check (format in ('digital', 'printed', 'physical')),
  size text, pages int, pack_qty int, addons text,
  price numeric not null,
  primary key (run_id, listing_id, option_key),
  foreign key (run_id, listing_id) references listing_results(run_id, listing_id) on delete cascade
);
create table listing_keywords (
  run_id text not null,
  listing_id text not null,
  keyword text not null,
  kind text not null check (kind in ('reported', 'fallback_title_phrase')),
  views numeric, clicks numeric, orders numeric,
  primary key (run_id, listing_id, keyword),
  foreign key (run_id, listing_id) references listing_results(run_id, listing_id) on delete cascade
);
create table competitor_options (
  id bigserial primary key,
  run_id text not null,
  listing_id text not null,
  keyword text,
  competitor_listing_id text,
  competitor_url text not null,
  competitor_title text,
  option_label text not null,
  format text not null check (format in ('digital', 'printed', 'physical')),
  size text, pages int, pack_qty int, addons text,
  price numeric not null,
  original_price numeric,
  price_basis text not null default 'option' check (price_basis in ('option', 'from_price')),  -- 'from' prices are never compared
  bestseller boolean,
  review_count int,
  foreign key (run_id, listing_id) references listing_results(run_id, listing_id) on delete cascade
);
-- Market price statistics always carry their sample.
create table market_samples (
  run_id text not null references listing_review_runs(run_id) on delete cascade,
  keyword text not null,
  sample_size int not null check (sample_size >= 0),
  sampling_scope text not null,
  min_price numeric, median_price numeric, max_price numeric,
  pct_digital numeric,
  primary key (run_id, keyword)
);
create table findings (
  id uuid primary key default gen_random_uuid(),
  finding_key text not null,                    -- stable id from the submitter, unique per run
  run_id text not null references listing_review_runs(run_id) on delete cascade,
  listing_id text,
  category text not null check (category in ('pricing', 'title', 'description', 'specification', 'options', 'keyword', 'other')),
  statement text not null,
  is_suggestion boolean not null default false,
  -- guarantee / shipping promise / proof / product option suggestions stay proposals until approved
  sensitive_topic text check (sensitive_topic in ('guarantee', 'shipping_promise', 'proof', 'product_option')),
  depends_on text[] not null default '{}',     -- finding_keys this one relies on
  state text not null default 'active' check (state in ('active', 'superseded', 'needs_review')),
  superseded_by uuid references findings(id),
  created_at timestamptz not null default now(),
  unique (run_id, finding_key)
);
create table finding_corrections (
  id uuid primary key default gen_random_uuid(),
  supersedes_finding_id uuid not null references findings(id),
  replacement_finding_id uuid references findings(id),
  reason text not null,
  corrected_by text not null,
  corrected_at timestamptz not null default now()
);
create table action_decisions (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references findings(id) on delete cascade,
  decision text not null check (decision in ('approved', 'rejected', 'deferred')),
  decided_by text not null,
  decided_at timestamptz not null default now(),
  note text,
  task_id uuid references tasks(id) on delete set null,
  implemented_at timestamptz,
  implementation_note text
);

-- ------------------------------------------------------------ reports
create table reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('weekly', 'monthly')),
  business_id text references businesses(id),  -- null = all businesses
  period_start date not null,
  period_end date not null,
  title text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (kind, business_id, period_start, period_end)
);
-- Published revisions are immutable snapshots referencing fixed import runs.
create table report_revisions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  revision int not null,
  state text not null check (state in ('draft', 'published')),
  content jsonb not null,                       -- frozen figures and sections
  source_runs uuid[] not null default '{}',     -- import runs the figures came from
  corrects_revision int,
  correction_note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (report_id, revision)
);
create or replace function report_revision_immutable() returns trigger language plpgsql as $$
begin
  if old.state = 'published' then
    raise exception 'report_revision_immutable';
  end if;
  return new;
end $$;
create trigger report_revision_immutable before update or delete on report_revisions
  for each row execute function report_revision_immutable();

create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('report_revision', 'task', 'promotion', 'import_run')),
  owner_id text not null,
  filename text not null,
  content_type text not null,
  size_bytes int not null check (size_bytes > 0),
  sha256 text not null,
  storage_key text not null unique,
  -- Images attached to reports are never auto-extracted into charts.
  structured_review text not null default 'none' check (structured_review in ('none', 'reviewed')),
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);
create index attachments_owner on attachments (owner_type, owner_id);
