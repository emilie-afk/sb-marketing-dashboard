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

Netlify scheduled function sheet-sync.ts (every 15 min)
   └─► registered Google spreadsheets (read-only Drive API) ──► promotions / intake submissions
   └─► Plant Revenue Breakdown Worker (viewer key, read-only) ──► product submissions
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
- Daily data supports any range inside its coverage (gaps are listed). Weekly and monthly totals support only their own periods or exact unions; they are never split into days. Rolling 30-day checks are shown one at a time and never added.
- Comparisons: previous equivalent period, same dates last month, same dates last year. Whole months compare with whole months. Otherwise day numbers are kept and moved to the month's last day when missing (Mar 31 to Feb 28; Feb 29 to Feb 28). Partial current periods compare the same number of elapsed days.
- The all-business total comes from its own reported figure and is never rebuilt from the channel breakdown. Only channels listed in `TRACKED_CHANNELS` are itemized; the rest appears as "other channels". Corporate revenue is shown separately and never added. Brands listed in `EXCLUDED_BRANDS` are excluded from every view. Both settings are private server settings, shown read-only in Settings.
- Transaction de-duplication uses the marketplace order id plus product, so an order mirrored from a marketplace into another tool counts once; distinct sales of the same product still count.
- Rankings state their channel scope.
- Advertising: current status is stored with the time it was observed, separate from period performance. Zero-spend campaigns are hidden from performance tables unless explicitly included. No total row in campaign tables; platform cards show totals only when all campaigns share the acquisition event and attribution.
- Timezones: sales and advertising keep the source reporting timezone. Operational deadlines and "today" use Vietnam time (`Asia/Ho_Chi_Minh`).

## 3. Field ownership and editing authority

| Record | Source owns | Dashboard owns |
|---|---|---|
| Promotions, vendor offers, special collections | dates, offer, code, channels, materials, vendor cost reduction, customer discount, special (BF/CM) terms, collection link | execution status, owner, notes, tasks, files, history |
| Occasions | name, date, type, note | "selected for use" (creates a promotion) |
| Sales, profit, ads, listing checks | everything submitted | campaign inclusion, finding decisions, task links, implementation notes |
| Tasks | n/a | everything. **The dashboard is the editing authority for marketing tasks.** |

Spreadsheet sync is one-way. Precedence when two sheets describe the same promotion: seasonal program over annual calendar; the other sheet's differing values become review items.

## 4. Promotion spreadsheet sync

- Register each spreadsheet in **Settings → Planning and intake spreadsheets** (admin): role (annual calendar, seasonal program, intake), business, year, link, file type (Google Sheet or .xlsx in Drive) and interval. No code change.
- The scheduled function runs every 15 minutes and syncs only sources whose interval has elapsed. **Refresh from spreadsheet** runs one immediately (editor).
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
- Database: export first (`pg_dump --data-only`), then run the rollback scripts in reverse order: `003_reference_data.down.sql`, `002_planning_tasks_reviews_reports.down.sql`, `001_foundation.down.sql`. Each removes its own `schema_migrations` row. Attachment blobs are not deleted by SQL; delete the `private-attachments` blob store separately if required.
- Spreadsheets are never written, so no spreadsheet rollback is needed.
