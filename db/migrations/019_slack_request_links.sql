-- One Slack request, one task. Task Tracker's direct Slack intake may already have turned a Slack request into a task
-- before the planning owner reviews the same request here (Slack review queue or a Corporate Gifts draft). The
-- dashboard sends each item's Slack identity (channel id, message ts, request id; never text or links) with its task,
-- and links waiting items to the task Task Tracker already has. Rollback: db/rollback/019_slack_request_links.down.sql
alter table corporate_task_drafts add column slack_sources jsonb not null default '[]'
  check (jsonb_typeof(slack_sources) = 'array' and jsonb_array_length(slack_sources) <= 10);
-- When a waiting item was linked to the task Task Tracker's Slack intake created (instead of being sent).
alter table review_suggestions add column intake_linked_at timestamptz;
alter table corporate_task_drafts add column intake_linked_at timestamptz;
-- When each waiting item was last checked against Task Tracker: the hourly check takes the least recently checked
-- items first, so every waiting item is reached however long the queue is.
alter table review_suggestions add column intake_checked_at timestamptz;
alter table corporate_task_drafts add column intake_checked_at timestamptz;
