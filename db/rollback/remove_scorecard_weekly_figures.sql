-- Rollback cleanup for the EOS scorecard's weekly figures (scorecard week columns, source priority and the weekly
-- figures warning). No forward migration belongs to that feature; this file is used only to roll it back.
--
-- Why: the previous build has no source priority, so a scorecard week stored next to a weekly report week for the same
-- metric would show as a conflict. This removes only the scorecard's WEEKLY submissions (submission ids "eosw:...").
-- Scorecard month totals ("eos:..."), weekly report intake figures and all other data are kept.
--
-- Order:
--   1. Pause the EOS scorecard source, which stops its scheduled and manual syncs:
--        update sheet_sources set active = false where role = 'eos_scorecard';
--      then let a sync already running finish. This file refuses to run while that source is active or one of its
--      syncs is queued or running.
--   2. Run this file (one transaction; it blocks new submissions while it runs).
--   3. Deploy the previous build.
--   4. Resume the source (the previous build syncs month totals only):
--        update sheet_sources set active = true where role = 'eos_scorecard';
-- Deleting a submission also deletes its figures (observations cascade). Earlier revisions of a week point to later
-- ones (superseded_by, no cascade), so every weekly revision is deleted together in one statement.
begin;
lock table import_runs in share row exclusive mode;
do $$
begin
  if exists (select 1 from sheet_sources where role = 'eos_scorecard' and active) then
    raise exception 'Pause the EOS scorecard source first (step 1), then run this cleanup.';
  end if;
  if exists (select 1 from sync_jobs j join sheet_sources s on s.id = j.sheet_source_id
              where s.role = 'eos_scorecard' and j.status in ('queued', 'running') and j.lease_until > now()) then
    raise exception 'An EOS scorecard sync is still queued or running; wait for it to finish, then run this cleanup.';
  end if;
  if exists (select 1 from import_runs r join import_runs w on w.id = r.superseded_by
              where w.source_id = 'sheet.eos_scorecard' and w.submission_id like 'eosw:%'
                and not (r.source_id = 'sheet.eos_scorecard' and r.submission_id like 'eosw:%')) then
    raise exception 'Another submission refers to a scorecard weekly submission; nothing was changed.';
  end if;
end $$;
delete from import_runs where source_id = 'sheet.eos_scorecard' and submission_id like 'eosw:%';
commit;
