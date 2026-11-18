-- Rolls back 013: deletes the Corporate Gifts task drafts. Tasks already created in Task Tracker stay there, and
-- Corporate Gifts keeps its requests (their last reported state stays as it was). Redeploy the previous build first.
drop table if exists corporate_task_drafts;
delete from schema_migrations where name = '014_corporate_tasks.sql';
