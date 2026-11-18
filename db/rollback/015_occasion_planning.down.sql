-- Rolls back 015. Deploy the previous build first.
-- "Resolved" items become "dismissed" (both mean: no task is created, and later scans or reads never bring them back);
-- Slack suggestions are tagged "resolved_before_rollback" so they can be found (unless they already have 10 flags).
-- Corporate Gifts already received "dismissed" for resolved drafts, so nothing changes there.
-- Black Friday and Cyber Monday are deactivated, not deleted, because plans or promotions may link to them.
-- Occasion links on Slack suggestions and plan categories are dropped.
begin;
alter table corporate_task_drafts drop constraint if exists corporate_task_drafts_resolved_not_sent;
alter table corporate_task_drafts drop constraint corporate_task_drafts_status_check;
update corporate_task_drafts set status = 'dismissed', updated_at = now(), version = version + 1 where status = 'resolved';
alter table corporate_task_drafts add constraint corporate_task_drafts_status_check check (status in ('pending', 'approved', 'dismissed'));

alter table review_suggestions drop constraint if exists review_suggestions_resolved_not_sent;
alter table review_suggestions drop constraint review_suggestions_status_check;
update review_suggestions
   set status = 'dismissed',
       flags = case when 'resolved_before_rollback' = any(flags) or cardinality(flags) >= 10 then flags else flags || array['resolved_before_rollback'] end,
       updated_at = now(), version = version + 1
 where status = 'resolved';
alter table review_suggestions add constraint review_suggestions_status_check check (status in ('pending', 'approved', 'dismissed', 'planned'));
drop index if exists review_suggestions_occasion;
alter table review_suggestions drop constraint if exists review_suggestions_occasion_year,
  drop column if exists occasion_status, drop column if exists occasion_id, drop column if exists occasion_year, drop column if exists occasion_candidates,
  drop column if exists occasion_matched_at, drop column if exists occasion_confirmed_at, drop column if exists prep_date;

drop index if exists marketing_plans_categories;
alter table marketing_plans drop column if exists categories;

update gift_occasions set active = false where id in ('black-friday', 'cyber-monday');
alter table gift_occasions drop column if exists aliases;
delete from schema_migrations where name = '015_occasion_planning.sql';
commit;
