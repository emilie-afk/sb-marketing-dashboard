-- Recurring U.S. gift calendar. Occasions are reference data seeded from shared/giftCalendar.ts by
-- server/giftSeed.ts (run after migrations; safe to rerun). Dated occasions carry a date rule and are placed per
-- year on the calendar as all-day dates; year-round occasions appear only in the promotion picker.
create table gift_occasions (
  id text primary key check (id ~ '^[a-z0-9-]{2,60}$'),       -- stable: promotion links point at it
  name text not null check (length(name) between 1 and 120),
  kind text not null check (kind in ('dated', 'year_round')),
  category text,                                               -- year-round grouping in the picker
  rule jsonb,                                                  -- dated only; see GiftRule
  month_label text not null,
  timing_text text not null,
  themes text,
  lead_in text,                                                -- suggested campaign start, kept apart from the dates shown
  lead_in_month int check (lead_in_month between 1 and 12),
  seasonal boolean not null default false,                     -- multi-week window the Calendar can hide
  parent_id text references gift_occasions(id),                -- shown inside the parent's details, not as its own entry
  sort_order int not null default 0,
  active boolean not null default true,
  check ((kind = 'dated') = (rule is not null))
);
create table gift_occasion_brands (
  occasion_id text not null references gift_occasions(id) on delete cascade,
  business_id text not null references businesses(id),
  primary key (occasion_id, business_id)
);
-- Confirmed dates for one year (e.g. organizer-announced National Volunteer Week).
create table gift_occasion_overrides (
  occasion_id text not null references gift_occasions(id) on delete cascade,
  year int not null check (year between 2000 and 2100),
  start_date date not null,
  end_date date not null,
  note text,
  primary key (occasion_id, year),
  check (end_date >= start_date)
);
-- A promotion's gift occasion is a dashboard-owned field: spreadsheet sync never writes it.
alter table promotions add column gift_occasion_id text references gift_occasions(id) on delete set null;
alter table promotions add column gift_occasion_year int check (gift_occasion_year is null or gift_occasion_year between 2000 and 2100);
alter table promotions add constraint promotions_gift_year_needs_occasion check (gift_occasion_year is null or gift_occasion_id is not null);
create index promotions_gift_occasion on promotions (gift_occasion_id, gift_occasion_year) where gift_occasion_id is not null;
