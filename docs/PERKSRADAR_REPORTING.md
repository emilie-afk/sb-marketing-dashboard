# Perksradar reporting API (contract for the Perksradar app)

The dashboard pulls Perksradar's daily counts hourly from a read-only endpoint in the Perksradar app, the same way it
reads the Gross Profit and Corporate Gifting apps. Counts only: no subscriber emails, names, card lists or any other
personal data ever leave the app.

## Endpoint

```http
GET /v1/reporting/days?from=YYYY-MM-DD&to=YYYY-MM-DD[&cursor=<next_cursor>]
x-reporting-secret: <PERKSRADAR_REPORTING_SECRET>
```

- **Auth:** compare the header with the app's own `REPORTING_SECRET` setting (at least 32 random characters) in
  constant time. Wrong or missing: `401`. Reporting switched off (no secret set): `503`. Never accept the secret in
  the address.
- **Range:** inclusive dates in the app's reporting timezone; at most 400 days. The dashboard asks for the last ~120
  days every hour.
- **Paging:** up to 100 days per page, oldest first; `next_cursor` is `null` on the last page.
- **No redirects**, JSON only, https only.

## Response

```json
{ "ok": true, "schema_version": 1, "timezone": "America/Los_Angeles",
  "days": [ { "date": "2026-11-13", "complete": true, "signups": 4, "cards_added": 11, "reminders_sent": 230,
              "emails_delivered": 228, "emails_opened": 101, "emails_clicked": 17 } ],
  "next_cursor": null }
```

| Field | Meaning |
|---|---|
| `complete` | `false` for a day still running (today); the dashboard skips it until it is `true` |
| `signups` | new subscribers created that day |
| `cards_added` | cards added to subscribers' lists that day |
| `reminders_sent` | reminder emails sent that day |
| `emails_delivered`, `emails_opened`, `emails_clicked` | email events that day, from the email provider |

Send every day of the range, once. The dashboard stores a month only when all its days are present, finished,
readable and sent once (the running month: the 1st to yesterday). A month with a gap keeps what was stored before and
the gap shows in the pull's result; a day with no readable date stops the whole read.

Each count is a whole number ≥ 0, or `null` when it is not known (for example the email provider was unreachable).
`null` is shown as missing, never as zero. Unknown fields are refused, so add new counts only with a schema change.

## Dashboard settings

`PERKSRADAR_API_URL` (the app's https origin, no path) and `PERKSRADAR_REPORTING_SECRET` (the same value as the app's
`REPORTING_SECRET`), set in the dashboard's Netlify environment. Until both are set the source shows "not configured".
Rotating: set a new secret in both places; the old one stops working at once.
