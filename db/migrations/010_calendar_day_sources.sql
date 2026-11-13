-- Figures by calendar day and calendar month: the Daily Analytics Report (daily revenue and orders) and the EOS
-- scorecard's month columns (month revenue, US website funnel rates, ad spend). Both are read-only spreadsheet
-- sources registered in Settings; this only allows the two new roles and adds their source records.
alter table sheet_sources drop constraint if exists sheet_sources_role_check;
alter table sheet_sources add constraint sheet_sources_role_check
  check (role in ('annual_calendar', 'seasonal_program', 'intake', 'daily_analytics', 'eos_scorecard'));
-- Only the calendars are per year.
alter table sheet_sources drop constraint if exists sheet_sources_check;
alter table sheet_sources add constraint sheet_sources_check check (role not in ('annual_calendar', 'seasonal_program') or year is not null);

insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('sheet.daily_analytics', 'Daily Analytics Report (daily revenue and orders)', null, 'spreadsheet', 'not_configured', null, '{"seeded":"true"}'),
  ('sheet.eos_scorecard', 'EOS scorecard (month totals)', null, 'spreadsheet', 'not_configured', null, '{"seeded":"true"}')
on conflict (id) do nothing;
