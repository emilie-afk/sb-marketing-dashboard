-- Rolls back 004. Job history is dropped; sync results remain in sync_runs.
drop table if exists sync_jobs;
delete from schema_migrations where name = '004_sync_jobs.sql';
