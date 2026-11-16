# Marketing Planning

Plan an occasion, assign the work, and have it show up in Task Tracker. The **dashboard owns the plan**; **Task Tracker owns the assigned tasks** (completion, reassignment and every task-level edit happen there). Plans are stored separately from the promotions imported from the spreadsheets, which keep syncing one way as before.

## Who sees what

| | Planning owner (`PLANNING_OWNER_EMAIL`) | Everyone else signed in (admins included) |
|---|---|---|
| Plans listed, opened, searched, counted on the calendar | All, including drafts and ended plans | Published plans whose **prep start** is from today through three calendar months from today, plus published plans whose prep has started and whose campaign ends today or later |
| Create, edit, publish, send tasks, update deadlines | Yes | No (view only) |

- Dates are Vietnam calendar dates. "Three calendar months" is the same day three months later (Nov 30 → Feb 28).
- The owner is matched against the signed-in account's Google-verified email. Without the setting, nobody can plan or see drafts.
- The same rule applies on the server to lists, details, search, calendar badges and counts, direct links (a hidden plan answers like a missing one) and every write.

## The workflow

1. **Marketing Calendar → Year agenda** shows January to December of the chosen year (Year selector; **Next 90 days** shortcut). Shared occasions appear once with their brands; year-round gift ideas are in their own section. Each occasion shows its plans (owner: **No plan / Draft / Published** with the assigned task count, and **Plan this occasion**).
2. **Plan this occasion** (or **Planning → New plan**) opens the form: brand, plan name, linked occasion and occurrence year, prep start, campaign start and end, objective, channels, target audience, message angle, deliverables, notes, and assignments (title, Task Tracker brand, assignee, due date, brief). Brands and people come from Task Tracker and are validated before saving and again before sending.
3. **Save draft** keeps everything in the dashboard. No Task Tracker task is created.
4. **Publish & send tasks** shows a preview of exactly what each task will contain (title, brief, brand, assignee, due date), then publishes the plan and creates the tasks. The brief contains the assignment's own brief plus the campaign name, dates, channels, audience and message angle; the objective, notes and other assignments are not sent.
5. Each assignment has a stable id used as the Task Tracker idempotency key. The send is recorded ("Sending…") under the plan's lock **before** Task Tracker is called; from then until Task Tracker's answer is recorded, and while a send got no answer ("No answer: retry to settle"), the assignment cannot be edited or removed and the plan cannot be deleted. Retry and **Check Task Tracker** settle it by its id: the assignment stays locked until Task Tracker either returns the existing task, or explicitly confirms that no task exists for that id **and** returns a fence covering every earlier attempt. Task Tracker stores that fence in its database under the assignment's lock and refuses any request sent at or before it, on any server instance, so no earlier attempt can create a task afterwards. The dashboard stores the greatest `sent_at` it has sent (before sending) and always sends later attempts with a `sent_at` after it and after the fence. A refusal such as `key_unavailable` (a task exists outside the credential's businesses) keeps it locked.
6. The plan shows the publication status and each assignment's delivery status (Created / Needs retry) separately, with the task's current status, a link to it in Task Tracker, and the task links back to the plan.
7. Task status comes from the normal Task Tracker sync (hourly). A task created moments ago keeps showing its creation status until the next snapshot.
8. Changing campaign dates lists the affected deadlines. Deadlines in Task Tracker stay as they are unless the owner chooses **Update to …** (or **Update deadline** on an assignment). If the task changed in Task Tracker since it was last read, the change is refused and the current task is shown; **Check Task Tracker** re-reads it.

## Settings (server side only)

| Variable | Purpose |
|---|---|
| `PLANNING_OWNER_EMAIL` | The planning owner's sign-in email |
| `TASK_TRACKER_API_URL` | Task Tracker's https origin (already used by the reporting pull) |
| `TASK_TRACKER_PLANNING_SECRET` | Task Tracker's planning secret (Integrations → Marketing planning) |

Task Tracker needs `MARKETING_DASHBOARD_URL` (this dashboard's origin) for its "Open the plan" links. See Task Tracker's `docs/PLANNING_API.md`.

## Database

Migration `011_marketing_plans.sql` (`marketing_plans`, `plan_assignments`). Rollback: `db/rollback/011_marketing_plans.down.sql` (deletes plans and their links; tasks already in Task Tracker stay there).
