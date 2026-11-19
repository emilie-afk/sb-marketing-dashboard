-- Rollback for 016_corporate_resolution.sql. Run only after redeploying code from before migration 016.
-- Moved drafts become dismissed; resolved drafts stay resolved (015's shared status); the check-off mirror is dropped
-- (Corporate Gifts keeps the records). A completion still waiting for Task Tracker is dropped (the task stays open).
begin;
drop table if exists corporate_checkoffs;
drop table if exists corporate_feed_cursors;
update corporate_task_drafts set status = 'dismissed' where status = 'moved';
drop index if exists corporate_task_drafts_resolve;
alter table corporate_task_drafts drop column if exists claim_release_due, drop column if exists tracker_completed_on, drop column if exists resolve_attempt_at, drop column if exists resolve_error,
  drop column if exists resolve_due, drop column if exists completion_source, drop column if exists completed_on, drop column if exists resolved_at,
  drop column if exists resolved_by, drop column if exists resolution_state, drop column if exists route;
alter table corporate_task_drafts drop constraint if exists corporate_task_drafts_status_check;
alter table corporate_task_drafts add constraint corporate_task_drafts_status_check check (status in ('pending', 'approved', 'dismissed', 'resolved'));
delete from schema_migrations where name = '016_corporate_resolution.sql';
commit;
