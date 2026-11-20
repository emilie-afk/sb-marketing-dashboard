# Slack Review

A private queue of task suggestions found in one Slack channel. It appears as the **Slack Review** subtab under
**Marketing Planning** (`#/planning/review`), with the number waiting, e.g. "Slack Review · 4".

## Who can see it

- Only the planning owner: the account whose verified sign-in email equals `PLANNING_OWNER_EMAIL` (the same setting
  Marketing Planning uses). Without the setting, nobody has access.
- Dashboard roles grant nothing here. Admins, management, editors and viewers get **404** on every review path (list,
  count, detail, direct link, search, edit, preview, create, dismiss, refresh), exactly as if the feature did not exist,
  and the tab is not rendered for them.
- Suggestions are not part of any shared view: not the planning calendar, exports, reporting, the Marketing Tasks
  sync, or shared logs. Intake logs and answers carry counts only, never message text.

## What Task Tracker receives

Only the fields the owner approves: title, brief, Task Tracker brand, assignee and due date (sent with
`origin: "review"`, so the task carries no plan link). Slack excerpts, Slack links, scanner notes, follow-ups and review
history stay in the dashboard tables.

## The flow

1. The scanner submits suggestions (below). Each one has a stable source key `slack:<channel>:<ts>:<action_id>`, so a
   rescan, a retry or an overlapping run never duplicates it, never overwrites the owner's edits, and never reopens a
   dismissed or approved suggestion. A later message about the same action is attached as a follow-up.
2. The owner reviews a suggestion: Slack excerpt, posted time, message and thread links, follow-ups, and the suggested
   business, assignee and deadline. Fields the scanner could not support are blank and listed under "Decisions to make";
   ambiguous deadline wording is shown as Slack said it.
3. **Review and edit** uses the Task Tracker directory (brands and people) and the same validation as planning.
4. **Create task** first shows a preview of exactly what will be sent, then creates it. No plan is needed. Approval
   (review status) and delivery (Task Tracker status) are shown separately. The suggestion stays in Slack Review, with a
   link to the created task.
5. **Dismiss** keeps the record, so later scans don't bring it back.
6. **Add to plan** (instead of Create task) opens a popup where every detail is filled in: title, brief, business, the
   draft plan (or **New draft plan**: name, prep start and campaign dates, linked to the suggestion's confirmed
   occasion), assignee and due date (both optional). The item **stays in the Marketing Dashboard**: it is part of the
   plan, and when the plan is published the team sees it, but it is never sent to Task Tracker. Sending is optional:
   tick **Send to Task Tracker when the plan is published**, and the item then needs the Task Tracker brand, assignee and
   due date (checked against Task Tracker's directory) and becomes a task when the plan is published. The tick can also
   be set later on the plan (Edit plan). Only draft plans are offered; published plans are refused. The suggestion keeps
   the popup's fields, becomes **In a plan**, links to the plan, and can no longer be edited, created or dismissed here
   (change it in the plan); later scans never reopen it. If the item is removed from the plan, or the plan is deleted,
   **Return to review** puts the suggestion back in the review list. Slack text and links are never copied into the plan.

7. **Resolve** (handled, no task) takes the suggestion out of To review without creating anything; like a dismissed one,
   later scans never bring it back.

### Actions in place

On the queue, the **To review** status of each row is a button: **Resolve**, **Dismiss**, **Add to task** (a drawer to
confirm the title, brief, business, brand, assignee and due date, then send it as one task) and **Add to plan**. The
queue, its filters and its scroll position stay as they are; the row updates where it is (Sending… / Sent with **Open in
Task Tracker** / Needs retry with **Retry**) and the tab count changes at once.

A **Resolved** or **Dismissed** status (never a task) is also a button: **Back to review** returns it to To review.

### Bulk actions

Tick rows (or the header box for every row shown) to act on several at once. The bar above the table offers **Resolve**,
**Dismiss**, **Back to review** and **Add to plan…**, plus **Clear selection**. Each row follows the same rules as its
own action, one at a time: a row that can't change (for example a task already in Task Tracker, or a row changed in
another window) is reported and stays selected, and the others are done. Bulk **Add to plan** puts each selected
suggestion in one draft plan (existing or new) with its own title, brief, and assignee and due date when it is for the
chosen business; these items stay in the dashboard (tick Send to Task Tracker on the plan for any that should become
tasks).

## Occasions

- **Suggested at intake.** Each new suggestion is matched against the dated gift occasions' names and aliases (whole
  words, ignoring case and apostrophes; e.g. "BF/CM", "BFCM" → Black Friday, "Xmas" → Christmas). The business narrows
  the occasions; a year written in the message wins, otherwise an exact deadline picks the occurrence it leads into,
  otherwise the next occurrence after the message (within about six months). Broad words such as "holiday" are not
  aliases, so "holiday email" stays unclassified. One clear match is shown as **Suggested** (not confirmed); several
  possible matches, or an unclear year, are listed with none chosen. Suggestions from before matching existed are
  matched when the queue is next listed.
- **Classified in place.** The **Occasion** column shows the confirmed occasion, the suggestion (**Confirm** /
  **Change**), the possible matches (click one), or **Set occasion**. Change opens a searchable picker (name, dates,
  year) on the same page, with an optional prep date; the owner can change or clear the link at any time. Classifying
  publishes nothing, creates no task and leaves the review status alone. Scans never change a link once set.
- **Unclassified** filter: suggestions without a confirmed occasion.
- **Timeline.** Confirmed suggestions (to review, in a plan, or approved) appear under their occasion on the owner's
  **Next two quarters** timeline, with the task due date or the manual prep date shown apart from the occasion date,
  or **Prep date needed**; those with prep before the window are under **Start preparing now**. Nobody else receives
  any of this.
- **Add to plan** lists draft plans for the same occasion first and warns when the chosen plan is for another occasion.
- **Add to task** creates one task; in Marketing Tasks it shows under its assignee with the occasion (e.g. "Black
  Friday 2026"). Occasion names are public reference data; the Slack text, title of the suggestion and notes stay here.

## Delivery

Creation reuses the planning delivery engine (`server/trackerDelivery.ts`): the send is recorded as "sending" under a
row lock before Task Tracker is called, the suggestion's id is the idempotency key, and at most one task can exist per
suggestion. If the answer is lost, the row stays locked ("No answer: retry to settle") until a retry or **Check Task
Tracker** finds the task by its key and links it, or Task Tracker confirms none exists and fences off earlier attempts.
While a task exists or may exist, the suggestion can't be edited or dismissed.

## Scanner intake API

Separate from sessions. Requires `SLACK_REVIEW_INGEST_SECRET` (≥ 32 characters) and `SLACK_REVIEW_CHANNEL_ID`; if either
is missing the endpoints answer 503. The credential can only submit batches and read its own checkpoint: it cannot list
or read the queue, review, create tasks, or reach the planning credential. Revoke it by changing or removing the env var.

Header: `x-review-ingest-key: <secret>`. Rate limit: 120 requests per hour.

`GET /api/review-intake/checkpoint` → `{ channel_id, checkpoint_ts | null, updated_at }`. `null` means no batch has been
accepted yet; the scanner then starts from its configured start point.

`POST /api/review-intake/batches`

```json
{
  "batch_id": "scan-2026-11-17T09:00Z",
  "channel_id": "C0SYNTHETIC",
  "range": { "from_ts": "1763370000.000100", "to_ts": "1763373600.000200" },
  "checkpoint_ts": "1763373600.000200",
  "skipped_count": 3,
  "suggestions": [{
    "message_ts": "1763371000.000300",
    "action_id": "a1",
    "thread_ts": null,
    "posted_at": "2026-11-17T09:16:40Z",
    "message_url": "https://example.slack.com/archives/C0SYNTHETIC/p1763371000000300",
    "thread_url": null,
    "excerpt": "Can someone draft the holiday email for the plant gift sets?",
    "title": "Draft the holiday email for plant gift sets",
    "brief": "Holiday email featuring the plant gift sets.",
    "business": "sb",
    "assignee_hint": null,
    "due_date": null,
    "deadline_text": "before the holiday sale",
    "scanner_note": "Deadline wording is relative; left blank.",
    "flags": ["deadline_ambiguous"],
    "followup_of": null
  }]
}
```

- `batch_id` makes the batch idempotent: resubmitting the same id returns `already_accepted` with the original counts.
- The checkpoint advances in the same transaction that accepts the batch, and never moves backwards.
- **No gaps:** once a checkpoint exists, `range.from_ts` is required and must be at or before it (overlapping is fine;
  rescanned messages are never duplicated). A batch starting after the checkpoint is refused with
  `409 checkpoint_gap`, stores nothing, and leaves the checkpoint unchanged. Before the first accepted batch,
  `from_ts` may be the configured start point or null.
- `followup_of` names an earlier source key; the message is attached to that suggestion instead of creating a new one.
- Answer (201, or 200 for a replay): `{ outcome, created_count, followup_count, unchanged_count, skipped_count, checkpoint_ts }`.
- Errors: 401 bad credential, 403 wrong channel, 409 checkpoint_gap, 422 invalid batch (field names only, no text echoed), 503 not configured.

## Setup and rollback

- Migration `db/migrations/012_slack_review.sql`; rollback `db/rollback/012_slack_review.down.sql` (drops the four
  review tables; any tasks already created in Task Tracker stay there).
- Migration `db/migrations/013_slack_review_plans.sql` (Add to plan); rollback `db/rollback/013_slack_review_plans.down.sql`
  (deploy the previous build first). It does not reopen suggestions that are in a plan, because the plan keeps the item
  and reopening could make the same work a second task: they become "dismissed", tagged `in_plan_before_rollback`.
- Migration `db/migrations/015_occasion_planning.sql` (occasion links, prep date, the `resolved` status, occasion aliases
  and Black Friday / Cyber Monday); rollback `db/rollback/015_occasion_planning.down.sql` (resolved suggestions become
  dismissed, tagged `resolved_before_rollback`; links are dropped).
- Migration `db/migrations/017_plan_items_optional_send.sql` (plan items kept in the dashboard: `send_to_tracker`, and
  brand, assignee and due date optional for those items; existing items keep sending); rollback
  `db/rollback/017_plan_items_optional_send.down.sql` (deploy the previous build first; it removes items kept in the
  dashboard, whose suggestions then show "Removed from its plan" and can be returned to review).
- Requires Task Tracker migration `004_task_origin.sql` and the matching deploy (accepts `origin: "review"`) before the
  first task is created.
- Scanner instructions: [SLACK_REVIEW_SCANNER.md](SLACK_REVIEW_SCANNER.md). The scanner stays unscheduled until the queue
  is deployed and verified.
