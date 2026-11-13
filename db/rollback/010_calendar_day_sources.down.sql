-- Rolls back 010. Removes the figures read from the Daily Analytics Report and the EOS scorecard, their
-- registrations and source records. Weekly figures from the intake spreadsheet are not touched.
begin;
delete from observations where source_id in ('sheet.daily_analytics', 'sheet.eos_scorecard');
delete from import_runs where source_id in ('sheet.daily_analytics', 'sheet.eos_scorecard');
delete from sheet_sources where role in ('daily_analytics', 'eos_scorecard');
delete from source_connections where id in ('sheet.daily_analytics', 'sheet.eos_scorecard');
alter table sheet_sources drop constraint if exists sheet_sources_role_check;
alter table sheet_sources add constraint sheet_sources_role_check check (role in ('annual_calendar', 'seasonal_program', 'intake'));
alter table sheet_sources drop constraint if exists sheet_sources_check;
alter table sheet_sources add constraint sheet_sources_check check (role = 'intake' or year is not null);
delete from schema_migrations where name = '010_calendar_day_sources.sql';
commit;
