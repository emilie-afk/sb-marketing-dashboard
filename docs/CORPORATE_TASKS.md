# Corporate Gifts tasks

Explicit, open Corporate Gifts actions found by the Corporate Gifts app (from Slack, or added there by hand) become
Task Tracker tasks, so they appear in **Marketing Tasks** with a **Corporate Gifts** tag.

1. **Read.** The hourly Task Tracker sync (and **Refresh from Corporate Gifts**) reads pending requests over the
   existing Corporate Gifting reporting connection (`CORPORATE_GIFTING_API_URL`, `CORPORATE_GIFTING_REPORTING_SECRET`).
   One draft per request; its id is the request id, so re-reading never duplicates.
2. **Review.** Marketing Planning → **Corporate Gifts** (planning owner only; everyone else gets 404). Drafts arrive
   with the Succulents Box brand and the default assignee (`CORPORATE_TASK_DEFAULT_ASSIGNEE`: the first Task Tracker
   person whose name starts with it; unset means no default). Edit one, or select several and **Apply to selected** (assignee
   and/or due date), then **Send selected to Task Tracker**. A due date is required.
   The **To review** status on each row is a button with three actions that happen in place (the queue, its filter and
   scroll position stay; the row updates where it is and the tab count changes at once):
   - **Resolve**: handled, no task. A status shared with Corporate Gifts on the same request id (see below).
   - **Dismiss**: no action needed (as before).
   - **Add to task**: a drawer to confirm the title, note, assignee and due date (business: Succulents Box), then it is
     sent as one task. The row shows Sending… / Sent (with **Open in Task Tracker**) / Needs retry (**Retry**).
3. **Deliver.** Same idempotent, fenced delivery as plan assignments and Slack Review (`server/trackerDelivery.ts`,
   `origin: "review"`). Task Tracker receives only the title, a note (details, marketplace names and their Corporate
   Gifts links, the Slack owner's name), brand, assignee and due date. Sending again never creates a duplicate.
4. **After delivery** Task Tracker owns the task. A newer due date from Corporate Gifts is applied with the version
   check (never to a completed task); nothing else is changed.
5. **Receipts.** Each state change is reported back to Corporate Gifts (`in_review`, `delivered` with the Task
   Tracker task id, `failed`, `dismissed`); a failed report is sent again on the next sync. Work marked done in Slack
   (or dismissed in Corporate Gifts) before it was sent is dismissed here.

6. **Routing.** Corporate Gifts routes each request by its owner. Only Marketing tasks become drafts here. Work owned
   outside Marketing is a **check-off item**, and an item without a clear owner shows under **Needs routing** with
   **Assign as Marketing task** / **Track as check-off**. Both lists are in the same Corporate Gifts view, and every
   action is applied in Corporate Gifts. A draft whose request is routed away disappears from the queue, and comes back
   if it is routed to Marketing again. The check-off list follows the Corporate Gifts change feed; each row is applied
   only if it is not older than the stored one, so overlapping refreshes can't remove or bring back an item out of order.
   Before a draft is sent it is claimed in Corporate Gifts at the version it was built from; a refused claim sends
   nothing. If Corporate Gifts doesn't answer, nothing is sent to Task Tracker and the claim is released there (right
   away, or on the next sync), before the draft can be sent again; a Resolve that waited for it then closes it.
7. **Resolve: one status, shared with Corporate Gifts** (on the same request id; nothing reopens it: repeated clicks,
   stale forms, rescans and stale receipts are ignored).
   - A draft not sent yet is **Resolved** (handled, no task; status `resolved` with where it was resolved) and can
     never be sent. Resolved here is reported as `resolved`; resolved in Corporate Gifts closes the draft here.
   - A task already in Task Tracker is completed there through its own completion rules
     (`POST /api/planning/v1/tasks/<key>/complete`) and reads as Resolved once Task Tracker confirms. A failure is
     shown and retried on the next sync. A request resolved in Corporate Gifts while its send was in flight becomes
     such a completion (the task that exists wins and is completed).
   - Resolve takes the same per-draft lock as sending. A send in progress or without an answer is checked in Task
     Tracker first; an unsettled send is refused until **Retry** settles it.
   - Check-off items have **Resolve** and bulk **Mark done**; failed items stay selected for a retry.
   Repeating any of these never completes anything twice. The dashboard sends `resolved` only once the feed
   advertises `resolved`, and the completion details and claims only once it advertises `routing` (Corporate Gifts
   migration 009); before that it reads the earlier feed and holds those back.
8. **Weekly report.** Corporate Gifts → Completed lists each check-off item (and each request resolved without a task,
   in either app) once, in the week of its completion date, from the Corporate Gifts feed. Marketing tasks are still
   counted through Task Tracker.

Migration `015_occasion_planning.sql` adds the `resolved` status (rollback turns resolved drafts into dismissed ones).
Migration `016_corporate_resolution.sql` (rollback `db/rollback/016_corporate_resolution.down.sql`) adds routing, resolve
requests and the `corporate_checkoffs` copy, on top of 015's `resolved` status (no second status column). It requires
Corporate Gifts with migration 009 (the `corporate-checkoffs` and `corporate-task-actions` routes) and Task Tracker with
the planning `complete` route.
Migration `014_corporate_tasks.sql`; rollback `db/rollback/014_corporate_tasks.down.sql` (tasks already in Task Tracker
stay there). Requires Corporate Gifts with migration 007 (the `corporate-tasks` and `corporate-task-receipts`
reporting routes) and the existing Task Tracker planning credential.
