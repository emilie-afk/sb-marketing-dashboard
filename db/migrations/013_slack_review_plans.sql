-- Slack Review: "Add to plan". A reviewed suggestion can become an assignment in one of the planning owner's DRAFT
-- plans instead of a task. Draft plans are private to the owner, and nothing reaches Task Tracker until the plan is
-- published, so the item stays private and is not a task. Only the approved fields are copied into the plan; the
-- Slack excerpt, links and notes stay here. Rollback: db/rollback/013_slack_review_plans.down.sql
alter table review_suggestions drop constraint review_suggestions_status_check;
alter table review_suggestions add constraint review_suggestions_status_check check (status in ('pending', 'approved', 'dismissed', 'planned'));
alter table review_suggestions
  add column plan_id uuid references marketing_plans(id) on delete set null,
  add column plan_assignment_id uuid references plan_assignments(id) on delete set null,
  add column planned_at timestamptz,
  -- A planned suggestion is never sent from here (the plan sends its assignment when it is published).
  add constraint review_suggestions_planned_not_sent check (status <> 'planned' or delivery_status = 'not_sent'),
  add constraint review_suggestions_planned_at check ((status = 'planned') = (planned_at is not null));
create unique index review_suggestions_plan_assignment on review_suggestions (plan_assignment_id) where plan_assignment_id is not null;
