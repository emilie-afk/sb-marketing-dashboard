-- Rollback of 018_tracker_closed_reason.sql. Deploy the previous build first. Copies removed as closed keep their
-- removal under the general reason (they are no longer restored automatically).
begin;
update tracker_task_records set removed_reason = 'no_longer_reported' where removed_reason = 'closed';
alter table tracker_task_records drop constraint tracker_task_records_removed_reason_check;
alter table tracker_task_records add constraint tracker_task_records_removed_reason_check check (removed_reason is null or removed_reason in
  ('deleted', 'brand_unassigned', 'brand_not_reported', 'out_of_scope', 'not_in_snapshot', 'no_longer_reported'));
delete from schema_migrations where name = '018_tracker_closed_reason.sql';
commit;
