# Rollout: Corporate Gifts check-off items, routing and Mark done (on top of the shared Resolved status)

Three changes, built on the shared **Resolved** status already live (dashboard migration 015, Corporate Gifts 008):

| App | Branch | Migration |
|---|---|---|
| Task Tracker | `feature/planning-complete` | none (planning route `POST /api/planning/v1/tasks/<key>/complete`) |
| Corporate Gifts | `feature/links-and-resolution` | `009_links_and_resolution.sql` (runs on the production deploy) |
| Marketing Dashboard | `feature/corporate-resolution` | `016_corporate_resolution.sql` (apply by hand, record it in `schema_migrations`) |

## One status model in both apps

- **Resolved** (`delivery_status` / draft `status` = `resolved`): closed without a Task Tracker task. Any route: a
  Marketing draft not sent, a check-off item, an item waiting for routing. Set by Resolve in either app, by a Slack
  completion, by a failed send or a released claim whose Resolve was waiting. Never reopened.
- **Mark done**: a task already in Task Tracker is completed there through Task Tracker's own rules (the dashboard
  calls the planning `complete` route) and shows done once Task Tracker confirms. It does not become "Resolved".
- **Completed record** (`resolution_state`, `completed_on`, evidence): every resolved item and every task done in
  Task Tracker, for the weekly report. Migrations 009 and 016 backfill items already resolved through 008 / 015.
- A task that turns out to exist after a resolution wins: the resolution is withdrawn (kept as history) and the task
  is shown with its status and link. If a send was unanswered, Resolve checks Task Tracker first and refuses to close
  an item whose task exists (Mark done is a separate, explicit action).

## Order

1. **Task Tracker**: merge and deploy `feature/planning-complete`.
2. **Corporate Gifts**: Neon backup branch, then merge `feature/links-and-resolution` (migration 009 runs on deploy).
3. **Marketing Dashboard, right after step 2**: Neon backup branch, apply `016_corporate_resolution.sql`, record it,
   then merge `feature/corporate-resolution`. Don't import Slack scans or apply routing between steps 2 and 3: the
   current dashboard build doesn't know routes, and could take an item routed away from Marketing as a draft.
4. Corporate Gifts → Owners and routing: add the owners, Preview routing → Apply routing.
5. Slack scans → import the backfill files (Preview, check, Save).
6. Dashboard → Marketing Planning → Corporate Gifts → Refresh.

## Verify

- Resolve one Marketing draft in the dashboard and one check-off item in Corporate Gifts: both show Resolved in both
  apps after a Refresh, no Task Tracker task exists, and each appears once in the weekly report's Completed list.
- Mark done on a task already in Task Tracker: it is completed there, and shows done in both apps.
- Resolve on a draft whose send got no answer and whose task exists: refused, with the task's status and link.

## Rollback

Reverse order: dashboard (deploy the previous build, then `db/rollback/016_corporate_resolution.down.sql`), then
Corporate Gifts (`db/rollback/009_links_and_resolution.down.sql`), then Task Tracker. Both rollbacks keep the
shared Resolved status (015 / 008) and its resolved items.
