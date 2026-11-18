-- Occasion planning: occasion aliases (and Black Friday / Cyber Monday), product categories on plans, Slack Review
-- suggestions linked to occasions, and the "resolved" review status (handled, no task) for Slack Review and Corporate
-- Gifts (shared with the Corporate Gifts app for its requests). Rollback: db/rollback/015_occasion_planning.down.sql
--
-- The occasion rows below are also written by server/giftSeed.ts (shared/giftCalendar.ts); they are included here so
-- the migration is complete on its own when applied without the seed.

-- ---------------------------------------------------------------- occasions: aliases, Black Friday, Cyber Monday
alter table gift_occasions add column aliases text[] not null default '{}' check (cardinality(aliases) <= 20);

update gift_occasions set sort_order = sort_order + 2
 where sort_order > (select sort_order from gift_occasions where id = 'thanksgiving')
   and not exists (select 1 from gift_occasions where id = 'black-friday');
insert into gift_occasions (id, name, kind, rule, month_label, timing_text, themes, seasonal, sort_order, active)
select v.id, v.name, 'dated', v.rule::jsonb, v.month_label, v.timing_text, v.themes, false, t.sort_order + v.n, true
  from (values
    ('black-friday', 'Black Friday', '{"t":"nth_weekday","m":11,"wd":4,"n":4,"offset":1}', 'November', 'Day after Thanksgiving', 'Holiday sale kickoff, gift sets and bundles', 1),
    ('cyber-monday', 'Cyber Monday', '{"t":"nth_weekday","m":11,"wd":4,"n":4,"offset":4}', 'November or December', 'Monday after Thanksgiving', 'Online holiday deals', 2)
  ) v(id, name, rule, month_label, timing_text, themes, n)
  cross join (select sort_order from gift_occasions where id = 'thanksgiving') t
on conflict (id) do nothing;
update gift_occasions set active = true where id in ('black-friday', 'cyber-monday');   -- re-applied after a rollback
insert into gift_occasion_brands (occasion_id, business_id)
select o, b from unnest(array['black-friday', 'cyber-monday']) o cross join unnest(array['sb', 'p2s']) b
 where exists (select 1 from businesses where id = b) and exists (select 1 from gift_occasions where id = o)
on conflict do nothing;

update gift_occasions g set aliases = a.aliases from (values
  ('valentines-day', array['Valentines', 'Valentine', 'V-Day', 'Vday']),
  ('national-caregivers-day', array['Caregivers Day', 'Caregiver Day']),
  ('employee-appreciation-day', array['Employee Appreciation']),
  ('administrative-professionals-day', array['Admin Professionals Day', 'Administrative Professionals Week', 'Admin Day', 'Secretaries Day']),
  ('national-volunteer-week', array['Volunteer Week']),
  ('teacher-appreciation-week', array['Teacher Appreciation', 'Teachers Appreciation Week', 'Teacher Week']),
  ('mothers-day', array['Mom''s Day', 'Moms Day']),
  ('national-nurses-week', array['Nurses Week', 'Nurse Week', 'Nurses Day']),
  ('graduation-season', array['Graduation season', 'Grad season']),
  ('fathers-day', array['Dad''s Day', 'Dads Day']),
  ('fourth-of-july', array['4th of July', 'July 4th', 'July 4', 'Independence Day']),
  ('back-to-school', array['Back-to-school season']),
  ('grandparents-day', array['Grandparent''s Day', 'Grandparents Day']),
  ('customer-service-week', array['CS Week']),
  ('world-teachers-day', array['World Teachers Day', 'World Teacher Day']),
  ('bosses-day', array['Bosses Day', 'Boss Day', 'National Boss Day', 'National Bosses Day']),
  ('thanksgiving', array['Thanksgiving Day', 'Turkey Day']),
  ('black-friday', array['BF', 'BFCM', 'BF/CM', 'BF-CM', 'Black Friday Cyber Monday', 'Black Friday weekend', 'Cyber Weekend']),
  ('cyber-monday', array['Cyber Mon']),
  ('christmas', array['Xmas', 'X-mas', 'Christmas Day', 'Christmas Eve']),
  ('year-end-gifting', array['Year-end gifts', 'Year-end gifting', 'Year end gifts', 'Year-end gift'])
) a(id, aliases) where g.id = a.id;

-- ---------------------------------------------------------------- plans: product categories
-- A plan can link to an occasion, to one or more product categories, or both (e.g. "Corporate gift boxes").
alter table marketing_plans add column categories text[] not null default '{}'
  check (cardinality(categories) <= 10 and array_position(categories, '') is null);
create index marketing_plans_categories on marketing_plans using gin (categories);

-- ---------------------------------------------------------------- Slack Review: occasion links and "resolved"
alter table review_suggestions drop constraint review_suggestions_status_check;
alter table review_suggestions add constraint review_suggestions_status_check check (status in ('pending', 'approved', 'dismissed', 'planned', 'resolved'));
alter table review_suggestions
  -- unmatched: nothing found; suggested: one clear match (preselected, not confirmed); ambiguous: several possible
  -- matches listed in occasion_candidates; confirmed: the owner's choice; cleared: the owner removed the link.
  -- Scans never change these once set (the owner's choice is kept on every rescan).
  add column occasion_status text not null default 'unmatched' check (occasion_status in ('unmatched', 'suggested', 'ambiguous', 'confirmed', 'cleared')),
  add column occasion_id text references gift_occasions(id) on delete set null,
  add column occasion_year int check (occasion_year is null or occasion_year between 2000 and 2100),
  add column occasion_candidates jsonb not null default '[]' check (jsonb_typeof(occasion_candidates) = 'array'),
  add column occasion_matched_at timestamptz,                 -- null: not matched yet (matched when next listed)
  add column occasion_confirmed_at timestamptz,
  add column prep_date date,                                   -- the owner's prep date when there is no task deadline
  add constraint review_suggestions_resolved_not_sent check (status <> 'resolved' or delivery_status in ('not_sent', 'failed')),
  add constraint review_suggestions_occasion_year check ((occasion_id is null) = (occasion_year is null));
create index review_suggestions_occasion on review_suggestions (occasion_id, occasion_year) where occasion_status = 'confirmed';

-- ---------------------------------------------------------------- Corporate Gifts drafts: "resolved"
alter table corporate_task_drafts drop constraint corporate_task_drafts_status_check;
alter table corporate_task_drafts add constraint corporate_task_drafts_status_check check (status in ('pending', 'approved', 'dismissed', 'resolved'));
alter table corporate_task_drafts add constraint corporate_task_drafts_resolved_not_sent check (status <> 'resolved' or delivery_status in ('not_sent', 'failed'));
-- "resolved" is shared with Corporate Gifts (its migration 008): the same request id, resolved in either app, is closed
-- in both. resolved_in records where it was resolved; receipt_state can now be "resolved".
alter table corporate_task_drafts add column resolved_in text check (resolved_in is null or resolved_in in ('dashboard', 'corporate_gifts'));
alter table corporate_task_drafts add constraint corporate_task_drafts_resolved_in check ((status = 'resolved') = (resolved_in is not null));
alter table corporate_task_drafts drop constraint corporate_task_drafts_receipt_state_check;
alter table corporate_task_drafts add constraint corporate_task_drafts_receipt_state_check
  check (receipt_state is null or receipt_state in ('in_review', 'delivered', 'failed', 'dismissed', 'resolved'));
