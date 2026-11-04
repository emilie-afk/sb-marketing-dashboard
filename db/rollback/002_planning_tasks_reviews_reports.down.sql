-- Rolls back 002. Destroys promotions, tasks, listing reviews, reports and attachment records.
-- Export private data first (docs/GUIDE.md, "Rollback"). Attachment blobs are not deleted by SQL.
drop table if exists attachments, report_revisions, reports, action_decisions, finding_corrections, findings,
  market_samples, competitor_options, listing_keywords, listing_options, listing_results, listing_review_runs,
  task_updates, task_links, task_occurrences, tasks, occasions, review_items, promotion_revisions,
  promotion_source_links, promotions, sync_runs, sheet_sources cascade;
drop function if exists report_revision_immutable() cascade;
delete from schema_migrations where name = '002_planning_tasks_reviews_reports.sql';
