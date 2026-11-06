-- Rolls back 006. Removes the synchronized Task Tracker copies (the tracker itself keeps every task; the next
-- pull after re-applying 006 rebuilds them). Dashboard-created tasks are not touched.
delete from sync_jobs where kind = 'task_tracker';
alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in ('sheet', 'plant_breakdown', 'gross_profit', 'corporate_gifting'));
delete from source_connections where id = 'pull.task_tracker';
drop table if exists tracker_snapshots;
drop table if exists tracker_task_records;
delete from schema_migrations where name = '006_task_tracker.sql';
