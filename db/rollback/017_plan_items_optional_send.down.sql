-- Rollback of 017_plan_items_optional_send.sql.
--
-- ORDER MATTERS: run this BEFORE deploying the previous build, while the current build is still live. The previous
-- build sends every plan item when a plan is published, so it must never see an item that was kept in the dashboard.
--   1. Run this file (one transaction). It locks plan_assignments, so no item can be added, claimed or sent while it
--      runs, then removes the items kept in the dashboard (never sent, so nothing in Task Tracker refers to them).
--      Their Slack suggestions show "Removed from its plan" and can be returned to review.
--   2. Deploy the previous build. Until it is live, the current build's plan pages, Slack Review and plan sends fail
--      (the column they read is gone), so nothing at all is sent in between.
-- Second safety while 017 is in place: the check plan_assignments_local_not_sent refuses to mark a dashboard-only
-- item "sending", which every build does before it calls Task Tracker, so even a previous build deployed too early
-- cannot send one (its publish fails for that item instead).
begin;
lock table plan_assignments in access exclusive mode;
delete from plan_assignments where not send_to_tracker;
alter table plan_assignments drop constraint plan_assignments_local_not_sent;
alter table plan_assignments drop constraint plan_assignments_brand_named;
alter table plan_assignments drop constraint plan_assignments_assignee_named;
alter table plan_assignments drop constraint plan_assignments_send_ready;
alter table plan_assignments alter column tracker_brand_id set not null;
alter table plan_assignments alter column tracker_brand_name set not null;
alter table plan_assignments alter column tracker_assignee_id set not null;
alter table plan_assignments alter column tracker_assignee_name set not null;
alter table plan_assignments alter column due_date set not null;
alter table plan_assignments drop column send_to_tracker;
delete from schema_migrations where name = '017_plan_items_optional_send.sql';
commit;
