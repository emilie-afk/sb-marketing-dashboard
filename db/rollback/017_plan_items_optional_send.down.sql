-- Rollback of 017_plan_items_optional_send.sql. Older code sends every plan item when a plan is published and needs
-- brand, assignee and due date on each, so items kept in the dashboard only are removed (their Slack suggestions show
-- "Removed from its plan" and can be returned to review). Items to send are unchanged.
begin;
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
