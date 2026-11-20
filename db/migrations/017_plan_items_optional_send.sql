-- Plan items that stay in the Marketing Dashboard. Sending a plan item to Task Tracker becomes a choice per item
-- (send_to_tracker). An item that is not sent needs only a title: business comes from its plan; assignee and due date
-- are optional and are kept for the plan only. An item to send still needs the Task Tracker brand, assignee and due
-- date, checked as before. Publishing a plan sends only the items marked to send.
-- Existing items keep send_to_tracker = true, so they behave exactly as before.
-- Rollback: run db/rollback/017_plan_items_optional_send.down.sql FIRST, then deploy the previous build (see that file).
-- plan_assignments_local_not_sent also stops any build from marking a dashboard-only item "sending" (sent).
alter table plan_assignments add column send_to_tracker boolean not null default true;
alter table plan_assignments alter column tracker_brand_id drop not null;
alter table plan_assignments alter column tracker_brand_name drop not null;
alter table plan_assignments alter column tracker_assignee_id drop not null;
alter table plan_assignments alter column tracker_assignee_name drop not null;
alter table plan_assignments alter column due_date drop not null;
alter table plan_assignments add constraint plan_assignments_send_ready check (not send_to_tracker or (tracker_brand_id is not null and tracker_brand_name is not null and due_date is not null
  and tracker_assignee_id is not null and tracker_assignee_name is not null));
alter table plan_assignments add constraint plan_assignments_assignee_named check ((tracker_assignee_id is null) = (tracker_assignee_name is null));
alter table plan_assignments add constraint plan_assignments_brand_named check ((tracker_brand_id is null) = (tracker_brand_name is null));
alter table plan_assignments add constraint plan_assignments_local_not_sent check (send_to_tracker or delivery_status = 'not_sent');
