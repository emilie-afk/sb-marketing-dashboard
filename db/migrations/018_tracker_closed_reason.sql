-- Task Tracker copies removed because the work was closed in the tracker (an archived owner's unfinished work) get
-- their own removal reason, so they can be restored when the person is restored, even outside the reporting window.
-- Rollback: db/rollback/018_tracker_closed_reason.down.sql
alter table tracker_task_records drop constraint tracker_task_records_removed_reason_check;
alter table tracker_task_records add constraint tracker_task_records_removed_reason_check check (removed_reason is null or removed_reason in
  ('deleted', 'brand_unassigned', 'brand_not_reported', 'out_of_scope', 'not_in_snapshot', 'no_longer_reported', 'closed'));
