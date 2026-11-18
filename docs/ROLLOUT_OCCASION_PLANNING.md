# Rollout: occasion planning (year at a glance, next two quarters, in-place review actions, occasion links)

Branch `feature/occasion-planning`. One migration, no new settings, no change needed in Task Tracker or Corporate Gifts.

## What changes

- **Marketing Calendar**: **Year at a glance** is the default view (four quarters × three months, every month shown,
  Show all per busy month, details in the occasion drawer). **Agenda** keeps the previous year agenda.
- **Marketing Planning → Plans**: **Next two quarters** timeline above the plan list (Jan–Jun 2027 as of Nov 18, 2026),
  with **Start preparing now**; plans can have **product categories** (column, filter, form), so a category-only plan
  works without an occasion.
- **Slack Review** and **Corporate Gifts**: the **To review** badge is a button with **Resolve**, **Dismiss**, **Add to
  task** (and **Add to plan** in Slack Review), all in place. New status **Resolved** (handled, no task).
- **Slack Review occasions**: occasion suggested at intake, **Occasion** column with Confirm / Change / Set occasion,
  **Unclassified** filter, confirmed suggestions on the owner's timeline, Add to plan prefers plans for the same
  occasion. Tasks show their occasion in Marketing Tasks.
- New occasions **Black Friday** and **Cyber Monday**; occasion aliases (e.g. BF/CM, Xmas).

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

- Corporate Gifts has no "resolved" receipt state, so a resolved draft is reported as `dismissed` (no task will be
  created).
- "BF/CM", "BFCM" and "Black Friday Cyber Monday" map to Black Friday; a message naming both Black Friday and Cyber
  Monday separately lists both for the owner to choose.
- A suggested prep start is seven weeks before the occasion (the plan form's default). Occasions with unconfirmed
  dates get no suggested day.
- Classifying never publishes or creates a task, and scans never change a link once set (rescans insert nothing new
  for a known message).
