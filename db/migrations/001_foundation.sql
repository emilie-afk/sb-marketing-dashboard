-- Marketing Dashboard foundation schema.
-- Every observation carries its source, business, period, timezone, scope and import run.
-- Rollback: db/rollback/001_foundation.down.sql

create extension if not exists pgcrypto;

-- ------------------------------------------------------------ reference
create table businesses (
  id text primary key check (id ~ '^[a-z0-9_]{2,30}$'),
  name text not null,
  sort_order int not null default 0,
  active boolean not null default true
);

-- Kinds of value a figure can be in. Zero is a value; missing, not applicable and incomplete are not.
create type value_state as enum ('value', 'missing', 'not_applicable', 'incomplete');
create type completeness as enum ('complete', 'partial', 'provisional', 'incomplete');
create type granularity as enum ('day', 'week', 'month', 'rolling_30', 'custom');

create table metric_definitions (
  key text primary key check (key ~ '^[a-z0-9_]{2,60}$'),
  label text not null,
  unit text not null check (unit in ('currency', 'count', 'ratio', 'percent', 'multiple')),
  kind text not null check (kind in ('base', 'derived', 'reported_ratio')),
  -- Which direction is good. 'down' for CPA and bot traffic; 'neutral' when it depends.
  good_direction text not null default 'up' check (good_direction in ('up', 'down', 'neutral')),
  numerator text,
  denominator text,
  acquisition_event text,      -- CPA only: which event counts as an acquisition
  description text
);

-- ------------------------------------------------------------ sources and automation
create table source_connections (
  id text primary key check (id ~ '^[a-z0-9_.-]{2,60}$'),
  label text not null,
  business_id text references businesses(id),
  kind text not null check (kind in ('submission', 'pull', 'spreadsheet', 'manual')),
  -- 'not_configured' | 'blocked' (needs a source change) | 'ok' | 'failing'
  status text not null default 'not_configured' check (status in ('not_configured', 'blocked', 'ok', 'failing')),
  blocked_reason text,
  config jsonb not null default '{}'::jsonb,   -- non-secret settings only
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table automation_clients (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_hash text not null unique,           -- sha256 of the token; the token is shown once
  token_hint text not null,                  -- last 4 chars, for recognition only
  allowed_sources text[] not null,
  allowed_businesses text[] not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references source_connections(id),
  business_id text references businesses(id),
  submission_id text not null,               -- stable id chosen by the submitter
  -- Ownership: which integration sent it ('client:<automation client id>', 'sheet:<sheet source id>', 'pull:<name>')
  -- and the envelope's source label. Duplicates, corrections and attachments are matched within this scope only.
  submitter text not null,
  submission_source text not null,
  schema_version int not null,
  content_hash text not null,
  revision int not null default 1,
  corrects_submission_id text,               -- the submission this one corrects
  period_start date,
  period_end date,
  timezone text,
  collected_at timestamptz,
  completeness completeness,
  outcome text not null check (outcome in ('accepted', 'unchanged', 'rejected', 'failed')),
  accepted_count int not null default 0,
  rejected_count int not null default 0,
  errors jsonb not null default '[]'::jsonb,
  actor text not null,                        -- 'client:<label>' or 'user:<email>'
  received_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'superseded', 'none')),
  superseded_by uuid references import_runs(id)
);
-- One active accepted run per owner scope + submission id.
create unique index import_runs_one_active on import_runs (source_id, submitter, business_id, submission_source, submission_id) where status = 'active';
create index import_runs_recent on import_runs (source_id, received_at desc);

-- ------------------------------------------------------------ observations
create table observations (
  id bigserial primary key,
  import_run_id uuid not null references import_runs(id) on delete cascade,
  source_id text not null references source_connections(id),
  business_id text not null references businesses(id),
  metric_key text not null references metric_definitions(key),
  scope_key text not null default 'all',      -- e.g. 'all', 'channel:online_store', 'platform:google'
  scope_label text,
  period_start date not null,
  period_end date not null,
  granularity granularity not null,
  timezone text not null,
  value numeric,
  value_state value_state not null,
  completeness completeness not null,
  collected_at timestamptz,
  attribution text,                            -- ads: attribution window/setting as reported
  status text not null default 'active' check (status in ('active', 'superseded')),
  check (period_end >= period_start),
  check ((value_state = 'value') = (value is not null))
);
create unique index observations_one_active on observations
  (source_id, business_id, metric_key, scope_key, period_start, period_end, granularity) where status = 'active';
create index observations_lookup on observations (business_id, metric_key, period_start) where status = 'active';

-- ------------------------------------------------------------ products and vendors
create table vendors (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references businesses(id),
  name text not null,
  unique (business_id, name)
);
create table products (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references businesses(id),
  title text not null,
  vendor_id uuid references vendors(id),
  category text,
  genus text,
  url text,
  first_seen date
);
-- Product identity is owned by one integration: the same external id from another integration, business or
-- envelope source is a different product record, so no integration can rename or re-vendor another's products.
create table product_source_ids (
  source_id text not null,
  submitter text not null,
  submission_source text not null,
  business_id text not null references businesses(id),
  external_id text not null,
  product_id uuid not null references products(id) on delete cascade,
  primary key (source_id, submitter, submission_source, business_id, external_id)
);
create table product_observations (
  id bigserial primary key,
  import_run_id uuid not null references import_runs(id) on delete cascade,
  product_id uuid not null references products(id),
  business_id text not null references businesses(id),
  channel_scope text not null,                -- states which channels the figures cover
  period_start date not null,
  period_end date not null,
  granularity granularity not null,
  timezone text not null,
  revenue numeric,
  units numeric,
  orders numeric,
  gross_profit numeric,                       -- null when cost is missing; never zero-filled
  cost_state text not null default 'missing' check (cost_state in ('complete', 'partial', 'missing', 'not_applicable')),
  completeness completeness not null,
  status text not null default 'active' check (status in ('active', 'superseded'))
);
create unique index product_obs_one_active on product_observations
  (product_id, channel_scope, period_start, period_end, granularity) where status = 'active';

-- ------------------------------------------------------------ advertising
create table ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references businesses(id),
  platform text not null,
  external_id text not null,
  name text not null,
  -- Campaign identity is owned by the integration that reported it (same rule as products).
  submitter text not null,
  submission_source text not null,
  unique (business_id, platform, external_id, submitter, submission_source)
);
-- Current status is observed at a time; it is not derived from spend.
create table campaign_status_history (
  id bigserial primary key,
  campaign_id uuid not null references ad_campaigns(id) on delete cascade,
  status text not null,
  observed_at timestamptz not null,
  import_run_id uuid references import_runs(id) on delete cascade
);
create table campaign_performance (
  id bigserial primary key,
  campaign_id uuid not null references ad_campaigns(id) on delete cascade,
  import_run_id uuid not null references import_runs(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  granularity granularity not null,
  timezone text not null,
  spend numeric,
  acquisitions numeric,
  acquisition_event text not null default 'purchase',
  conversion_value numeric,
  attribution text,
  reported_cpa numeric,                        -- kept at original scope when only the ratio exists
  reported_roas numeric,
  status text not null default 'active' check (status in ('active', 'superseded'))
);
create unique index campaign_perf_one_active on campaign_performance
  (campaign_id, period_start, period_end, granularity) where status = 'active';
-- New active campaigns explicitly shown even with zero spend.
create table campaign_inclusions (
  campaign_id uuid primary key references ad_campaigns(id) on delete cascade,
  included_by text not null,
  included_at timestamptz not null default now(),
  note text
);

-- ------------------------------------------------------------ activities (counts keep their meaning)
create table activities (
  id bigserial primary key,
  import_run_id uuid references import_runs(id) on delete cascade,
  business_id text not null references businesses(id),
  activity_type text not null check (activity_type in ('content', 'social', 'pitching', 'vendor', 'ai_tool', 'outreach', 'listing', 'other')),
  name text not null,
  count numeric,
  count_unit text,                             -- e.g. 'social posts per channel'
  period_start date not null,
  period_end date not null,
  link text,
  status text not null default 'active' check (status in ('active', 'superseded'))
);

-- ------------------------------------------------------------ users and audit
create table audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb
);

create table rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);
