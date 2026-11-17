-- Rolls back 012: deletes the private review queue, follow-ups and scan checkpoints. Tasks already created in Task
-- Tracker stay there. Revoke the scanner credential (SLACK_REVIEW_INGEST_SECRET) and redeploy the previous build first.
drop table if exists review_scan_batches;
drop table if exists review_scan_state;
drop table if exists review_followups;
drop table if exists review_suggestions;
delete from schema_migrations where name = '012_slack_review.sql';
