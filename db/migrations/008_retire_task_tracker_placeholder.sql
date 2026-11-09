-- The Task Tracker is now read by the reporting pull (pull.task_tracker, migration 006). The placeholder row from
-- 003 said it had no data to share and showed as a second "Task Tracker" source. It never held data.
delete from source_connections s where s.id = 'blocked.task_tracker'
  and not exists (select 1 from import_runs r where r.source_id = s.id);
