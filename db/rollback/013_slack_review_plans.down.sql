-- Rolls back 013. Deploy the previous build first.
-- Suggestions that were added to a plan are NOT reopened: their plan still holds the item (and may already have sent it),
-- so reopening them could turn the same work into a second task. They become "dismissed" instead (the previous build
-- can neither create a task from them nor bring them back in a scan) and are tagged "in_plan_before_rollback" so they
-- can be found (when the row already has the maximum of 10 flags, it is only dismissed). The plans keep their items and
-- send them when published, as before.
begin;
alter table review_suggestions drop constraint if exists review_suggestions_planned_at;
alter table review_suggestions drop constraint if exists review_suggestions_planned_not_sent;
alter table review_suggestions drop constraint review_suggestions_status_check;
update review_suggestions
   set status = 'dismissed',
       flags = case when 'in_plan_before_rollback' = any(flags) or cardinality(flags) >= 10 then flags else flags || array['in_plan_before_rollback'] end,
       updated_at = now(), version = version + 1
 where status = 'planned';
alter table review_suggestions add constraint review_suggestions_status_check check (status in ('pending', 'approved', 'dismissed'));
drop index if exists review_suggestions_plan_assignment;
alter table review_suggestions drop column if exists planned_at, drop column if exists plan_assignment_id, drop column if exists plan_id;
delete from schema_migrations where name = '013_slack_review_plans.sql';
commit;
