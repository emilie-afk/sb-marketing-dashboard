# Rollout: occasion planning (year at a glance, next two quarters, in-place review actions, occasion links)

Branch `feature/occasion-planning`. One migration, no new settings, no change needed in Task Tracker or Corporate Gifts.

## What changes

- **Marketing Calendar**: **Year at a glance** is the default view (four quarters × three months, every month shown,
  Show all per busy month, details in the occasion drawer). **Agenda** keeps the previous year agenda.
- **Marketing Planning → Plans**: **Next two quarters** timeline above the plan list (Jan–Jun 2027 as of Nov 18, 2026),
  with **Start preparing now**; plans can have **product categories** (column, filter, form), so a category-only plan
  works without an occasion.
- **Slack Review** and **Corporate Gifts**: the **To review** badge is a button with **Resolve**, **Dismiss**, **Add to
  task** (and **Add to plan** in Slack Review), all in place. New status **Resolved** (handled, no task), shared with
  the Corporate Gifts app for its requests.
- **Slack Review occasions**: occasion suggested at intake, **Occasion** column with Confirm / Change / Set occasion,
  **Unclassified** filter, confirmed suggestions on the owner's timeline, Add to plan prefers plans for the same
  occasion. Tasks show their occasion in Marketing Tasks.
- New occasions **Black Friday** and **Cyber Monday**; occasion aliases (e.g. BF/CM, Xmas).

## Shared "Resolved" with Corporate Gifts (before merging #20)

Resolved is one status in both apps, on the same Corporate Gifts request id. The Corporate Gifts side is a separate
change (`sb-corporate-gifts`, branch `feature/shared-resolved`: migration 008, feed capability, `resolved` receipts,
Resolve in its Tasks view; its `docs/SHARED_RESOLVED.md`).

Deployment order, so neither app sends `resolved` before the other can read it:

1. **Dashboard first** (this branch, migration 015). It reads `resolved` in the Corporate Gifts feed and closes those
   drafts, but holds its own `resolved` receipts until the feed advertises `capabilities: ["resolved"]`. Drafts
   resolved here in the meantime stay "In review" in Corporate Gifts.
2. **Corporate Gifts second**: apply its migration 008, then deploy. Its feed then advertises the capability; the
   dashboard's next sync (hourly, or Refresh) sends the held resolutions.

(Corporate Gifts first is also safe: the current dashboard build skips feed rows with a status it does not know and
never reopens them; they close here once this branch is deployed.)

Verify after both are live:

- Resolve one request in Corporate Gifts and another in the dashboard. After a dashboard Refresh, both show Resolved in
  both apps (the dashboard shows "Resolved in Corporate Gifts" for the first), both To review counts drop by two, and
  no Task Tracker task exists for either.
- Stale update: resolving from a form opened before the other app resolved it is refused (version check).
- Race: a request whose task is being created can't be resolved until the send settles; if the task exists, both apps
  show it as in Task Tracker with its link.

Rollback order is the reverse: Corporate Gifts first (its rollback turns resolved requests into dismissed ones), then
the dashboard.

## Order

1. Apply `db/migrations/015_occasion_planning.sql` to production (one transaction; adds columns with defaults and
   widens two status checks, so the current build keeps working). Then record it in `schema_migrations` if applied by
   hand: `insert into schema_migrations (name) values ('015_occasion_planning.sql');`
2. Merge and deploy right after (the new build reads the new columns). Between the two steps the current build shows
   Black Friday and Cyber Monday on Thanksgiving's date, because it does not know the new day offset.
3. Verify, signed in as the planning owner and as a management account (below).

## Verify

- Owner, Marketing Calendar: Year at a glance shows January–December, with Black Friday Nov 27 and Cyber Monday Nov 30
  in 2026; an occasion opens its drawer with plans and **Plan this occasion**.
- Owner, Planning: the timeline shows Jan–Jun 2027; Valentine's Day shows a suggested prep date and is listed under
  Start preparing now; drafts show **Draft**.
- Owner, Slack Review: existing suggestions get an occasion suggestion on first load (e.g. a BF/CM message shows
  "Suggested: Black Friday 2026"). Confirm one, then see it under its occasion on the timeline. **Resolve** one: the
  tab count drops at once and the row stays where it is, marked Resolved.
- Management account: the timeline shows public occasions and published plans only; no Slack Review tab, no drafts,
  no suggestions.

## Rollback

Deploy the previous build first, then run `db/rollback/015_occasion_planning.down.sql`: resolved items become
dismissed (Slack suggestions tagged `resolved_before_rollback`), occasion links, prep dates and plan categories are
dropped, Black Friday and Cyber Monday are deactivated (not deleted: plans or promotions may link to them). Tasks
already in Task Tracker stay there.

## Decisions to know

- Resolved is shared with Corporate Gifts (see above); a task that already exists in Task Tracker always wins over a
  resolution, and completion belongs to that task.
- "BF/CM", "BFCM" and "Black Friday Cyber Monday" map to Black Friday; a message naming both Black Friday and Cyber
  Monday separately lists both for the owner to choose.
- A suggested prep start is seven weeks before the occasion (the plan form's default). Occasions with unconfirmed
  dates get no suggested day.
- Classifying never publishes or creates a task, and scans never change a link once set (rescans insert nothing new
  for a known message).
