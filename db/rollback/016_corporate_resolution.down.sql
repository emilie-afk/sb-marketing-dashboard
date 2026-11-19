-- Rollback for 016_corporate_resolution.sql. Run only after redeploying code from before migration 016.
-- Moved drafts go back to "To review" as before 016 (Corporate Gifts keeps their route); resolve requests, completion
-- dates and the check-off mirror are dropped (Corporate Gifts keeps the records). Resolved drafts stay resolved (015).
begin;
drop table if exists corporate_checkoffs;
drop table if exists corporate_feed_cursors;
update corporate_task_drafts set status = 'pending', updated_at = now(), version = version + 1 where status = 'moved';
drop index if exists corporate_task_drafts_resolve;
alter table corporate_task_drafts drop constraint if exists corporate_task_drafts_resolve_request;
alter table corporate_task_drafts drop column if exists claim_release_due, drop column if exists tracker_completed_on, drop column if exists resolve_attempt_at, drop column if exists resolve_error,
  drop column if exists resolve_due, drop column if exists resolve_requested_at, drop column if exists completion_source, drop column if exists completed_on,
  drop column if exists resolved_by, drop column if exists route;
alter table corporate_task_drafts drop constraint corporate_task_drafts_status_check;
alter table corporate_task_drafts add constraint corporate_task_drafts_status_check check (status in ('pending', 'approved', 'dismissed', 'resolved'));
delete from schema_migrations where name = '016_corporate_resolution.sql';
commit;
