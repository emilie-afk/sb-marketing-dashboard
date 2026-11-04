# Intake spreadsheet and submission contract

Scheduled tasks deliver structured results to the dashboard by **appending rows to a Google Sheet** (free, no new service) registered in Settings with role `intake`. The dashboard reads it one-way on its schedule. The same records can be sent to `POST /api/submissions`; both paths share validation.

Rules for every tab:
- Row 1 holds the column names below (any order; case and spaces do not matter). Append rows; never edit or delete rows that were already imported.
- A changed row under an existing id is rejected (shown in Settings → Recent imports). To fix data, append a new submission with `corrects` (generic tabs) or a new check with Corrections rows (listing checks).
- Empty cell = not provided. `N/A` or `missing` = known to be missing. `0` = zero.
- Dates `YYYY-MM-DD`; timestamps ISO 8601 with offset (`2026-11-09T09:30:00+07:00`); timezone IANA (`America/Los_Angeles`).

## A. Etsy listing checks (one run per weekly check)

| Tab | One row is | Columns |
|---|---|---|
| Checks | one scheduled run | run_id, business (`p2s`), window_start, window_end, timezone, collected_at, completeness, scope_note, excluded_listing_ids |
| Listing results | one listing in one run | run_id, listing_id, title, url, clicks, orders, spend |
| Our options | one purchasable variation | run_id, listing_id, option_key, label, format (`digital` / `printed` / `physical`), size, pages, pack_qty, addons, price |
| Keywords | one keyword for one listing | run_id, listing_id, keyword, kind (`reported` / `fallback_title_phrase`), views, clicks, orders, sample_size, sampling_scope, min_price, median_price, max_price, pct_digital |
| Competitor options | one comparable competitor variation | run_id, listing_id, keyword, competitor_listing_id, competitor_url, competitor_title, option_label, format, size, pages, pack_qty, addons, price, original_price, price_basis (`option` / `from_price`), bestseller, review_count |
| Findings | one finding or suggestion | run_id, finding_key, listing_id, category (`pricing`, `title`, `description`, `specification`, `options`, `keyword`, `other`), statement, is_suggestion, sensitive_topic (`guarantee`, `shipping_promise`, `proof`, `product_option`), depends_on (finding keys, comma separated) |
| Corrections | a correction and what it supersedes | run_id (the new run), supersedes_run_id, supersedes_finding_key, replacement_finding_key, reason |
| Action decisions | approval and implementation status | run_id, finding_key, decision (`approved` / `rejected` / `deferred`), decided_by, decided_at, note, implemented_at, implementation_note |

Rules the import enforces:
- `run_id` is stable and unique (suggested: `etsy-check-YYYY-MM-DD`). Listing ids are digits. The excluded listing must not appear in Listing results.
- A fallback title phrase has no views/clicks/orders, and is shown as "Fallback title phrase (not a reported keyword)".
- Market price statistics need `sample_size` and `sampling_scope` (for example "first results page, US"). They are always shown as a sample.
- Only `price_basis = option` rows are compared, and only like for like (same format; same pages and size when given; packs per unit). Use `from_price` for a search-result "from" price.
- Corrections supersede the earlier finding (kept for history) and mark findings that depend on it as "needs review".
- Suggestions about guarantees, shipping promises, proofs or options stay proposals until approved. Tasks are created only from approved findings.

## B. Generic submissions (weekly report figures, ads, activities, products)

| Tab | One row is | Columns |
|---|---|---|
| Submissions | one submission (envelope) | submission_id, business (`sb` / `p2s` / `perksradar`), source, period_start, period_end, granularity (`day` / `week` / `month` / `custom`), timezone, collected_at, completeness (`complete` / `partial` / `provisional` / `incomplete`), corrects |
| Metrics | one figure | submission_id, metric, scope, scope_label, value, state, attribution |
| Campaigns | one campaign's period result | submission_id, platform (`google` / `facebook` / `amazon` / `etsy` / ...), external_id, name, status, status_observed_at, spend, acquisitions, acquisition_event, conversion_value, attribution, reported_cpa, reported_roas |
| Activities | one named activity | submission_id, type (`content`, `social`, `pitching`, `vendor`, `ai_tool`, `outreach`, `listing`, `other`), name, count, count_unit, link |
| Products | one product's period sales | submission_id, external_id, title, vendor, category, genus, url, channel_scope, revenue, units, orders, gross_profit, cost_state |

Metric keys: `revenue`, `orders`, `units`, `sessions`, `sessions_added_to_cart`, `sessions_reached_checkout`, `sessions_converted`, `bot_sessions`, `human_sessions`, `ad_spend`, `ad_purchases`, `ad_purchase_value`, `gross_profit`, `product_cost`, `shipping_cost`, `gross_profit_revenue_basis` (always in the same submission as `gross_profit`, for the same scope and period: the revenue the profit was calculated on; used only for gross margin; a basis in a separate submission is ignored, and a correction must send both), `signups`, `cards_added`, `reminders_sent`, `emails_delivered`, `emails_opened`, `emails_clicked`. Send counts, not rates: the dashboard computes AOV, conversion rates, CPA, ROAS and margin from them.

Scopes: `all` (business total) or `channel:online_store`, `channel:amazon`, `channel:faire`, `channel:etsy`, `channel:kdp`, `channel:corporate`, or another `channel:<name>`. A count needs `count_unit` so it keeps its meaning ("5" with "social posts per channel").

## C. API form

```http
POST /api/submissions
Authorization: Bearer mkd_...
Content-Type: application/json

{ "schema_version": 1, "submission_id": "weekly-report-2026-11-06", "source": "weekly_report", "business": "sb",
  "period": { "start": "2026-10-31", "end": "2026-11-06", "granularity": "week", "timezone": "America/Los_Angeles" },
  "collected_at": "2026-11-09T15:50:00+07:00", "completeness": "complete",
  "records": { "observations": [ { "metric": "revenue", "value": 0 }, { "metric": "orders", "state": "missing", "value": null } ],
               "campaigns": [ { "platform": "google", "external_id": "123", "name": "Campaign", "spend": 10.5, "acquisitions": 0,
                                "conversion_value": 0, "status": "Active", "status_observed_at": "2026-11-09T15:40:00+07:00" } ],
               "activities": [ { "type": "social", "name": "Social posts", "count": 5, "count_unit": "social posts per channel" } ] },
  "source_refs": [ { "label": "Weekly report image" } ] }
```
Attachments: `POST /api/submissions/<submission_id>/attachments?business=<business>&source=<source>`, only for the token's own accepted submissions.

Ownership: a token can only correct or attach to submissions it sent itself, for the same business and source. Product and campaign ids are scoped the same way, so the same id sent by another token is a separate record. Each intake spreadsheet is its own integration in the same way, and its Action decisions apply only to its own checks.

Limits: 5 MB JSON; 5,000 observations or products, 1,000 campaigns or activities per submission; attachments 15 MB (PNG, JPEG, WebP, PDF, XLSX, CSV, ZIP); 120 requests per hour per token.

## D. Connecting a scheduled task

Add a final step to the task that appends its rows to the intake spreadsheet (or calls the API) after its existing outputs, so current outputs keep working. The task needs edit access to the intake spreadsheet only; the dashboard needs read access only.
