-- Rolls back 019. Linked items keep their Task Tracker task; only the Slack identity and link time are dropped.
alter table corporate_task_drafts drop column if exists intake_checked_at;
alter table review_suggestions drop column if exists intake_checked_at;
alter table corporate_task_drafts drop column if exists intake_linked_at;
alter table review_suggestions drop column if exists intake_linked_at;
alter table corporate_task_drafts drop column if exists slack_sources;
delete from schema_migrations where name = '019_slack_request_links.sql';
