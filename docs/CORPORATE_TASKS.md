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
   - **Resolve**: handled, no task. The draft leaves To review; Corporate Gifts is told `dismissed` (it has no
     "resolved" state; both mean no task will be created), and later reads never reopen it.
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

Migration `015_occasion_planning.sql` adds the `resolved` status (rollback turns resolved drafts into dismissed ones).
Migration `014_corporate_tasks.sql`; rollback `db/rollback/014_corporate_tasks.down.sql` (tasks already in Task Tracker
stay there). Requires Corporate Gifts with migration 007 (the `corporate-tasks` and `corporate-task-receipts`
reporting routes) and the existing Task Tracker planning credential.
