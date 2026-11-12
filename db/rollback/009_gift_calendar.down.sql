-- Rolls back 009. Removes the gift calendar and every promotion's gift occasion link; the promotions themselves
-- (titles, dates, offers, status) are kept.
drop index if exists promotions_gift_occasion;
alter table promotions drop constraint if exists promotions_gift_year_needs_occasion;
alter table promotions drop column if exists gift_occasion_year;
alter table promotions drop column if exists gift_occasion_id;
drop table if exists gift_occasion_overrides;
drop table if exists gift_occasion_brands;
drop table if exists gift_occasions;
delete from schema_migrations where name = '009_gift_calendar.sql';
