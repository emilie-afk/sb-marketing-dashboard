-- Rolls back 013. Suggestions that were added to a plan go back to "pending" (the plan keeps its assignment).
-- Deploy the previous build first.
update review_suggestions set status = 'pending' where status = 'planned';
drop index if exists review_suggestions_plan_assignment;
alter table review_suggestions drop constraint if exists review_suggestions_planned_at;
alter table review_suggestions drop constraint if exists review_suggestions_planned_not_sent;
alter table review_suggestions drop column if exists planned_at, drop column if exists plan_assignment_id, drop column if exists plan_id;
alter table review_suggestions drop constraint review_suggestions_status_check;
alter table review_suggestions add constraint review_suggestions_status_check check (status in ('pending', 'approved', 'dismissed'));
delete from schema_migrations where name = '013_slack_review_plans.sql';
