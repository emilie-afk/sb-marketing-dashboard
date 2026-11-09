-- Rolls back 008. Restores the Task Tracker placeholder row from 003.
insert into source_connections (id, label, business_id, kind, status, blocked_reason, config) values
  ('blocked.task_tracker', 'Task Tracker', null, 'pull', 'blocked', 'Has no shared data to read. Marketing tasks are managed in this dashboard.', '{"seeded":"true"}')
on conflict (id) do nothing;
delete from schema_migrations where name = '008_retire_task_tracker_placeholder.sql';
