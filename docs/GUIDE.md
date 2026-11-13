# Marketing Dashboard: architecture and operator guide

Internal app for the Succulents Box marketing team, linked from the public Toolbox. The code is public; all data, credentials and business rules live in the database and in server settings, never in the repository.

## 1. Architecture

```
Browser (React SPA, dist/)
   │  same-origin /api/*  (session cookie, Google sign-in)
   ▼
Netlify Function api.ts ──► server/app.ts ── routes ── PostgreSQL (Neon)
   ▲                                         └──────── Netlify Blobs (private attachments)
   │  Bearer automation token
Scheduled tasks ── POST /api/submissions ──► same validation and import engine

Netlify scheduled function sheet-sync.ts (every 15 min, queues due jobs only)
   └─► sync_jobs (one active job per spreadsheet) ──► signed start ──► background function sheet-sync-background.ts (up to 15 min)
          └─► registered Google spreadsheets (read-only: Apps Script reader or Drive API) ──► promotions / intake submissions
          └─► Plant Revenue Breakdown Worker (viewer key, read-only) ──► product submissions
"Refresh from spreadsheet" (editor) ──► the same job flow
```

| Folder | Purpose |
|---|---|
| `shared/` | Pure rules shared by server and browser: dates and comparisons, coverage, metrics and value states, scope and de-duplication, recurrence, listing review rules, spreadsheet parsing, sync planning, submission schema |
| `server/` | API, auth and roles, imports, sheet sync, Drive reader, blob store, adapters |
| `src/` | SPA pages: Overview, business pages, Calendar, Tasks, Reports, Toolbox, Settings |
| `db/migrations`, `db/rollback` | Numbered SQL migrations and their rollback scripts |
| `tests/` | Vitest suites on a real PostgreSQL database with synthetic fixtures |
| `scripts/` | migrate, demo seed (local only), dev server, screenshots, public-build check, toolbox sync |

Loading a page only reads saved data. Nothing on page load triggers Shopify or ShipStation exports, scraping or browser collection.

## 2. Data rules (enforced in code and tests)

- Every observation stores source, business, period start and end, granularity, source timezone, scope, completeness, collection time and import run.
- Missing, zero, not applicable and incomplete are different states. Zero is a value. Missing costs are never zero.
- Gross margin = gross profit / `gross_profit_revenue_basis`, the revenue the profit was calculated on. Both must arrive in the same submission (import run) and also match on integration, business, period, granularity, timezone and accounting scope. A basis sent separately never pairs, even from the same integration. A correction that carries either one must carry both, for the same scope and period. If the basis is missing, mismatched or zero, or profit for the period comes from more than one integration, margin is shown as unavailable with the reason. It never falls back to business revenue. The basis is its own metric: it is never part of business revenue, channel revenue or revenue trends.
- Provisional or still-running source periods are labelled on every figure built from them (for example "25.00% (provisional)"); data the source marked incomplete is shown as incomplete.
- The same figure for the same period from more than one source is never added together; it is shown as unavailable.
- Gross profit is a plain figure only when every cost is known. Partial costs are labelled incomplete; vendor margins with any cost gap are calculated over products with known costs only and labelled incomplete. Profit leaders rank complete figures only.
- When the comparison period has data, products that sold then but not now count as falling to zero and appear in the declining list and in their vendor's change. Without comparison data nothing is reported as dropped.
- Ratios (AOV, conversion rates, CPA, ROAS, margin) are computed from summed numerators and denominators. Reported ratios are kept at their original scope and period only.
- Purchase CPA below one reported purchase shows `N/A (<1 purchase)`.
- Rates change in percentage points; other figures show absolute and percentage change. Percentage change uses `|prior|`. A rise in CPA or bot traffic is shown as bad.
- Every figure counts toward the calendar days it covers. For a range, the dashboard uses, in order: month totals that exactly make up the range (the EOS scorecard's month columns, which include month-end adjustments), daily figures for every day (the Daily Analytics Report), then weekly totals lying wholly inside the range. A week running past the range is never split into days: its days are listed as gaps and the total is marked incomplete. Campaign results follow the same rule: daily results first, then weeks wholly inside the range for days no daily result covers, never counting a day twice (added up per campaign, with the latest daily budget); a campaign with a week left out is marked incomplete and names that week. A platform's ad spend for a whole month comes from the EOS month column when it has one; CPA and ROAS are then withheld if campaign weeks were left out, so spend and purchases always cover the same days. Month funnel rates come from the EOS month column. Gross profit uses the days a Gross Profit week sends (by order date, as that app's monthly view does) when they add up to the week's totals; otherwise the week total. Completed work (activities) for a period running past the range is divided by the share of its days inside it (6 of 7 days → 6/7 of the count). Rolling 30-day checks are shown one at a time and never added.
- A campaign's identity is its platform and the platform's campaign ID. Campaigns that share a name stay separate; an ongoing campaign is the same campaign across weeks.
- Comparisons: previous equivalent period, same dates last month, same dates last year. Whole months compare with whole months. Otherwise day numbers are kept and moved to the month's last day when missing (Mar 31 to Feb 28; Feb 29 to Feb 28). Partial current periods compare the same number of elapsed days.
- The all-business total comes from its own reported figure and is never rebuilt from the channel breakdown. Only channels listed in `TRACKED_CHANNELS` are itemized; the rest appears as "other channels". Corporate revenue is shown separately and never added. Brands listed in `EXCLUDED_BRANDS` are excluded from every view. Both settings are private server settings, shown read-only in Settings.
- Transaction de-duplication uses the marketplace order id plus product, so an order mirrored from a marketplace into another tool counts once; distinct sales of the same product still count.
- Rankings state their channel scope.
- Advertising: current status is stored with the time it was observed, separate from period performance. Zero-spend campaigns are hidden from performance tables unless explicitly included. No total row in campaign tables; platform cards show totals only when all campaigns share the acquisition event and attribution.
- Timezones: sales and advertising keep the source reporting timezone. Operational deadlines and "today" use Vietnam time (`Asia/Ho_Chi_Minh`).

## 3. Field ownership and editing authority

| Record | Source owns | Dashboard owns |
|---|---|---|
| Promotions, vendor offers, special collections (from a spreadsheet) | dates, offer, code, channels, materials, vendor cost reduction, customer discount, special (BF/CM) terms, collection link | execution status, owner, notes, gift occasion link, tasks, files, history |
| Promotions created in the dashboard (no spreadsheet row) | n/a | everything: name, offer, dates, status, owner, gift occasion link. If a spreadsheet row later matches one, the spreadsheet takes over its source fields. |
| Gift occasions (recurring U.S. gift calendar) | `shared/giftCalendar.ts`, seeded by `npm run db:migrate` | per-year date overrides (`gift_occasion_overrides`) |
| Occasions | name, date, type, note | "selected for use" (creates a promotion) |
| Sales, profit, ads, listing checks | everything submitted | campaign inclusion, finding decisions, task links, implementation notes |
| Tasks created in the dashboard | n/a | everything. **The dashboard is the editing authority for its own marketing tasks.** |
| Task Tracker tasks | everything (title, brand, owner, dates, status, recurrence). **The Task Tracker is their editing authority.** | nothing: read-only copies, shown with an "Open in Task Tracker" link |

Task Tracker tasks arrive through a one-way pull (see "Task Tracker pull" below) into separate source-owned tables (`tracker_task_records`), never into `tasks`. Every dashboard task mutation (status, comments, occurrences, attachments) answers `403` for them, for every role. Dashboard-created tasks keep their current editing behavior.

Spreadsheet sync is one-way. Precedence when two sheets describe the same promotion: seasonal program over annual calendar; the other sheet's differing values become review items.

### Task Tracker pull

- Settings: `TASK_TRACKER_API_URL` (https origin), `TASK_TRACKER_REPORTING_SECRET` (created on the tracker's Integrations screen; server-only), optional `TASK_TRACKER_INSTANCE_ID` (must match the tracker's) and `TASK_TRACKER_BUSINESSES` (default `sb`). Without them the source shows "not configured" and nothing is read.
- Runs hourly with the other pulls and from Settings → Data sources → Refresh now (background job).
- Contract: the tracker's `docs/REPORTING_API.md`. One-time tasks and individual occurrences of recurring tasks are reported; a series is never counted as completed work.
- Only a complete, validated snapshot is published, in one transaction. A failed, partial, oversized or malformed read, or one where the tracker changed while it was paged (after bounded retries), publishes nothing and keeps the last good copy; the source is marked failing with the reason.
- One overall deadline (2 minutes) covers every page request, body read and retry, and publication. Every publication statement and lock wait runs with a database timeout equal to the time left, and the deadline is checked again after the last write, immediately before COMMIT; on timeout the whole publication is rolled back. Anything that arrives late is discarded; a late read is recorded as failed, never as success.
- Reconciliation (contract `schema_version: 2`): the tracker's last page lists every task currently in scope, whatever its dates. Copies of tasks not on that list are hidden, however long ago they were synced (so a dashboard reconnecting after a long gap still drops deleted, unassigned or out-of-scope tasks); occurrences outside their task's date span are hidden; one-time tasks and occurrences inside the snapshot window that are missing are hidden. Other older occurrences stay as history. Removal markers only add the reason. Archived brands that remain mapped stay visible, labelled archived.
- Ownership: each record carries the person who owned the task on that record's date, so completed work stays credited to its original owner after reassignment or archival.
- Access: tracker membership grants nothing here (only `TEAM_MEMBERS` does), and a Management role in the tracker does not change dashboard roles.

### Gift calendar

- Occasions live in `shared/giftCalendar.ts` (stable ids, date rules, gift themes, lead-ins, applicable brands) and are seeded into `gift_occasions` after every `db:migrate`. The seed is safe to rerun: occasions are updated in place by id, so promotion links survive; per-year overrides are only inserted when missing.
- Dated occasions are placed for the years being viewed as all-day dates (no clock time), so they show on the same day in Vietnam and U.S. time zones. Seasonal windows (multi-week) can be hidden on the Calendar; a lead-in month is shown in the details, never as the window itself. Teacher Appreciation Day is listed inside Teacher Appreciation Week. An occasion with organizer-set dates and no override for a year shows "<Month>, dates to be confirmed".
- Year-round occasions appear only in the promotion picker; their promotions place them on the Calendar.
- A promotion's link stores the occasion and, for dated occasions, the occurrence year (so a December campaign can lead into next year's occasion). Year-round links have no year. The link is a dashboard field: spreadsheet sync never writes it, and linking or clearing it leaves the rest of the promotion unchanged.
- Permissions follow the existing roles: viewers see everything permitted; editors and admins create dashboard promotions and change links (the server answers `403` to viewers).
- To add a confirmed date for a year (e.g. National Volunteer Week), add it to `GIFT_OVERRIDES` and run `db:migrate`, or insert a row into `gift_occasion_overrides`.

## 4. Promotion spreadsheet sync

- Reading access (choose one; server settings only):
  1. **Apps Script reader (preferred).** Create a script project from a team Google account that can already view the spreadsheets, paste `scripts/apps-script/sheet-reader.gs` and `appsscript.json`, and set the script properties `READER_KEY` (a random value of at least 32 characters) and `ALLOWED_FILE_IDS` (the registered file ids, comma separated). Run `checkAccess` once to approve read-only Drive access, then deploy as a web app (execute as me, anyone can call). Set `SHEET_READER_URL` to the web app address and `SHEET_READER_KEY` to the same key. It runs as that account, so it is not affected by the 7-day refresh-token limit that applies to Google sign-in apps in Testing mode. It still depends on that account keeping its authorization of the script and its access to the files, and on Apps Script quotas; if any of these lapse, the sync shows the failure in Settings and keeps the last successful data. The dashboard waits at most 60 seconds per read, refuses responses over the size limit while downloading, and follows only plain redirects to Google's script result host (never resending the key). Add new file ids to `ALLOWED_FILE_IDS` when registering a new spreadsheet.
  2. **Drive API refresh token**: `GOOGLE_SYNC_REFRESH_TOKEN` with the scope `drive.readonly`. If the Google sign-in app is in Testing mode, Google expires this token after 7 days.
- Register each spreadsheet in **Settings → Planning and intake spreadsheets** (admin): role (annual calendar, seasonal program, intake, Daily Analytics Report, EOS scorecard), business, year, link, file type (Google Sheet or .xlsx in Drive) and interval. No code change.
- **Daily Analytics Report** (role "Daily Analytics Report"): month tabs from 2025 on ("October  2026"). Each reported day (Website revenue filled in) becomes daily revenue and orders: Succulents Box total (every channel row above "Little Sunnie"), Website, Amazon (not plus shipping) and Faire (BPF); P2S from the rows under "Photostosketches" (Etsy + KDP). Little Sunnie is left out. Blank cells on a reported day count as 0; revenue with no order count is listed on the sync run. Today is never read.
- **EOS scorecard** (role "EOS scorecard"): year tabs from 2025 on, the "TOTAL (MONTH)" column of each month that has ended and has an "All" revenue figure. Sent: revenue (Succulents Box = All − Little Sunnie − Photostosketches; Website, Amazon, Faire; P2S), the US website funnel rates, and ad spend (Succulents Box total, Google, Facebook; P2S). Blank and error cells are skipped, never sent as 0.
- Each month is one submission per business. A month whose figures change in the spreadsheet is sent as a correction; an unchanged month writes nothing. Add both file ids to the Apps Script `ALLOWED_FILE_IDS` before registering them.
- Syncs run as background jobs. Netlify stops scheduled functions after 30 seconds, so the scheduled function (every 15 minutes) only queues the spreadsheets whose interval has elapsed and starts the background function for each; **Refresh from spreadsheet** (editor) queues one the same way and the page follows the job until it finishes. The background function runs for up to 15 minutes.
- Start requests to the background function are signed with a key derived from `SESSION_SECRET` and must be less than 5 minutes old; a job runs only while it is still queued, so a repeated request does nothing.
- One queued or running job per spreadsheet (and one Plant Revenue Breakdown pull): a second refresh reports that a sync is already running. A job that has not finished within its 16-minute lease is marked abandoned and a new one may start. Failed, timed-out and abandoned jobs never change promotions or figures; the last successful data stays.
- Jobs are per spreadsheet, but applying a calendar is serialized per business: a transaction-scoped database lock is taken before existing promotions are read, so an annual and a seasonal sync running at the same time never both create the same promotion, and each sees the other's ownership (seasonal precedence holds in either order).
- Identity: discount code, then Shopify discount id, then vendor (for vendor offers), collection path (special collections), otherwise title plus start date. Identities are stored in `promotion_source_links`; the row number is informational only. A row whose code changed but whose dates match exactly one unseen promotion is linked to it and flagged for confirmation.
- The same promotion in two monthly tabs is one record; disagreeing values become a conflict review item.
- A missing row is flagged `removed_from_source`, never deleted. A blank tab (for example a month owned by the seasonal sheet) is not a cancellation. A failed read changes nothing; the last successful data stays and Settings shows the failure.
- Every source change writes a `promotion_revisions` row. Published reports are frozen and do not change.

## 5. Scheduled submissions

Two equivalent paths, same validation, idempotency and corrections:
1. **Intake spreadsheet (free, preferred)**: the task appends rows to a Google Sheet registered with role `intake`. See `docs/INTAKE_SHEET.md`.
2. **API**: `POST /api/submissions` with `Authorization: Bearer <token>`. Tokens are created per task in Settings (admin), stored hashed, limited to sources and businesses, and revocable.

Receipts: `accepted` (201), `unchanged` (200, identical resend), `rejected` (409 or 422, with reasons), `failed` (500, previous data untouched, last successful time returned). A different payload under an accepted `submission_id` is rejected; send a new id with `"corrects": "<old id>"`. Attachments: `POST /api/submissions/<submission_id>/attachments?business=<business>&source=<source>` (multipart `file`).

Ownership: every import run records which integration sent it (the automation client, the intake spreadsheet, or a pull adapter), its business and its envelope `source`. Duplicate detection, corrections, listing-finding corrections and attachments only match runs inside that same scope (integration, business and source). Product and campaign identities are owned the same way: the same external id from another integration, business or source is a separate record, so no integration can rename or re-vendor another's products or campaigns. Decisions in an intake spreadsheet apply only to checks that same spreadsheet submitted. One integration can never correct, replace, rename or attach to another integration's data. Figures already reported for the same period and scope by another integration are rejected rather than replaced.

## 6. Reports

A report revision freezes its figures and the import runs they came from. Its content is limited to its own period: performance, advertising and products for exactly that period, activities whose period lies inside it, and promotions whose dates overlap it. Published revisions are immutable (database trigger). Corrections create a new revision with a note. Files (PNG, JPEG, WebP, PDF, XLSX, CSV, ZIP up to 15 MB, checked by content) are stored privately and served only to signed-in members; published revisions do not accept new files. Images are never auto-extracted into figures.

## 7. Security

- Google sign-in. Members and roles come only from the private `TEAM_MEMBERS` setting, re-read on every request. Viewer reads; editor changes tasks, promotions' execution fields, findings, reports, uploads and refreshes; admin also registers spreadsheets and manages automation tokens.
- Automation tokens are separate from sessions and cannot read dashboards.
- State-changing requests check origin and are rate limited.
- Secrets live only in Netlify environment variables. `npm run check:public` blocks builds that contain sheet links, real store admin links, emails, tokens, keys or private terms.
- Tests and demos use synthetic data only (`tests/fixtures/synthetic.ts`). The dev server shows a "Synthetic demo data" banner.
- Public repository rules: code, synthetic fixtures and generic docs only. No real figures, vendor terms, promotion plans, sheet or Drive links, report files, team emails, credentials, or notes about how other internal apps are secured. Integration notes and source-change requests are kept in the team's private notes. Set `PRIVATE_TERMS_FILE` locally to a git-ignored list of confidential words so `npm run check:public` also blocks them.
- Source sharing settings are never changed.

## 8. Local development

```bash
npm install
createdb mkt && createdb mkt_test                 # any PostgreSQL 14+
# No local PostgreSQL? docker run -d --name mkd-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
#   then: docker exec mkd-pg createdb -U postgres mkt_test
#   and:  TEST_DATABASE_URL="postgresql://localhost:5432/mkt_test?user=postgres" npm test
export DATABASE_URL=postgresql://localhost/mkt
npm run db:demo                                   # migrations + SYNTHETIC demo data (refused if the database has data)
TEST_DATABASE_URL=postgresql://localhost/mkt_test npm test   # drops and rebuilds that schema
npm run build && LOCAL_DEV_LOGIN=1 npm run dev    # http://localhost:8888/dev/login?role=editor
npm run check:public
```
`LOCAL_DEV_LOGIN` and `/dev/login` exist only in `scripts/dev-server.ts`, which refuses to start on Netlify or in production.

## 9. Deploy and migrate (operator, after review)

Not done in this delivery. When approved:
1. Create the GitHub repository (public) and the Netlify site; create a Neon database (free plan). Run `npm run check:public` with `PRIVATE_TERMS_FILE` set before every push.
2. Set environment variables (`.env.example` lists names), including `TEAM_MEMBERS`, `EXCLUDED_BRANDS` and `TRACKED_CHANNELS`. Add the dashboard callback `https://<site>/api/auth/callback` to the Google OAuth client.
3. Run migrations once from a trusted machine: `DATABASE_URL=<neon url> npm run db:migrate`. Never run `db:demo` against it.
4. Deploy. Sign in as an admin, register the spreadsheets, refresh each once and review the "Needs review" list.
5. Add the dashboard card to the toolbox repository (prepared separately).

## 10. Rollback

- App: redeploy the previous Netlify deploy (instant rollback in Netlify).
- Daily and month figures only: deactivate the two spreadsheet sources in Settings (the last figures stay), or run `010_calendar_day_sources.down.sql` to remove them; weekly figures are untouched.
- Gift calendar only: run `009_gift_calendar.down.sql`. It removes the gift occasions and every promotion's occasion link; promotions themselves (including ones created in the dashboard) are kept.
- Task Tracker pull only: unset `TASK_TRACKER_API_URL` (stops reading; the last copy stays visible), or run `006_task_tracker.down.sql` to remove the copies (the tracker keeps every task).
- Database: export first (`pg_dump --data-only`), then run the rollback scripts in reverse order: `010_calendar_day_sources.down.sql`, `009_gift_calendar.down.sql`, `008_retire_task_tracker_placeholder.down.sql`, `007_campaign_daily_budget.down.sql`, `006_task_tracker.down.sql`, `005_reporting_pulls.down.sql`, `004_sync_jobs.down.sql`, `003_reference_data.down.sql`, `002_planning_tasks_reviews_reports.down.sql`, `001_foundation.down.sql`. Each removes its own `schema_migrations` row. Attachment blobs are not deleted by SQL; delete the `private-attachments` blob store separately if required.
- Spreadsheets are never written, so no spreadsheet rollback is needed.
