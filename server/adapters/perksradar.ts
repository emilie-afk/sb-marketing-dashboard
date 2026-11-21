// Pull adapter for the Perksradar app's read-only reporting API (GET /v1/reporting/days). Server side only.
//   PERKSRADAR_API_URL            the Perksradar app origin (https, no path)
//   PERKSRADAR_REPORTING_SECRET   that app's reporting credential (its own, revocable; at least 32 characters)
//
// The app returns daily COUNTS only (sign-ups, cards added, reminders sent, emails delivered / opened / clicked),
// never subscriber emails, card lists or any other personal data. Each pull re-reads the last ~4 months, so a missed
// or failed pull is repaired by the next one. A month is sent only when every one of its days is present, finished
// and readable (the running month: the 1st to yesterday), and only months that start inside the window, so a
// partial read never replaces a complete month. A month with a gap keeps what was stored and the gap is reported.
// One submission per calendar month: a month whose counts changed is sent as a correction of the earlier one, an
// unchanged month writes nothing.
import { createHash } from "node:crypto";
import { z } from "zod";
import { applyPulled, walkPages } from "./pullApply";
import { originOf, getJson } from "./reportingClient";
import { addDays, daysInMonth, todayIn } from "../../shared/dates";

export const PR_SOURCE_ID = "pull.perksradar";
const PR_WHO = { sourceId: PR_SOURCE_ID, submitter: "pull:perksradar", submissionSource: "perksradar" };
const MAX_PAGES = 20;
/** How far back each pull reads (about four months). */
export const PR_WINDOW_DAYS = 120;
export const PR_METRICS = ["signups", "cards_added", "reminders_sent", "emails_delivered", "emails_opened", "emails_clicked"] as const;

export const perksradarConfigured = () => !!originOf(process.env.PERKSRADAR_API_URL) && (process.env.PERKSRADAR_REPORTING_SECRET ?? "").length >= 32;

const count = z.number().int().min(0).max(10_000_000).nullable();
const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  complete: z.boolean(),
  signups: count, cards_added: count, reminders_sent: count, emails_delivered: count, emails_opened: count, emails_clicked: count,
}).strict();
const pageSchema = z.object({
  ok: z.literal(true), schema_version: z.literal(1), timezone: z.string().min(3).max(64),
  days: z.array(z.unknown()).max(400), next_cursor: z.string().max(200).nullable(),
});
type Day = z.infer<typeof daySchema>;

/** Finished days of one month → one submission of daily counts (null = known to be missing, never 0). */
export function monthToSubmission(month: string, days: Day[], timezone: string) {
  const [y, m] = month.split("-").map(Number);
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const observations = sorted.flatMap((d) => PR_METRICS.map((k) => d[k] === null
    ? { metric: k, scope: "all", period_start: d.date, period_end: d.date, granularity: "day" as const, value: null, state: "missing" as const }
    : { metric: k, scope: "all", period_start: d.date, period_end: d.date, granularity: "day" as const, value: d[k] as number }));
  const records = { observations };
  const hash = createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 16);
  return {
    schema_version: 1, submission_id: `pr:${month}:${hash}`, source: "perksradar", business: "perksradar" as const,
    period: { start: `${month}-01`, end: `${month}-${String(daysInMonth(y, m)).padStart(2, "0")}`, granularity: "month" as const, timezone },
    collected_at: new Date().toISOString(), completeness: "complete" as const, records,
    source_refs: [{ label: `Perksradar daily counts: ${month} (${sorted.length} day${sorted.length === 1 ? "" : "s"})` }],
  };
}

export async function pullPerksradar(actor = PR_WHO.submitter, today = todayIn("America/Los_Angeles")) {
  if (!perksradarConfigured()) return { outcome: "not_configured" as const, results: [], problems: [] };
  const origin = originOf(process.env.PERKSRADAR_API_URL)!;
  const headers = { "x-reporting-secret": process.env.PERKSRADAR_REPORTING_SECRET! };
  const from = addDays(today, -PR_WINDOW_DAYS), to = addDays(today, -1);
  const byDate = new Map<string, Day>();
  const bad = new Set<string>();          // dates sent twice with different counts, or a day that couldn't be read
  let unreadable = 0;                     // items with no usable date
  const results: any[] = [];
  let timezone = "America/Los_Angeles";
  const problems = await walkPages<unknown>("Perksradar", MAX_PAGES, async (cursor) => {
    const page = pageSchema.parse(await getJson(origin, `/v1/reporting/days?from=${from}&to=${to}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, headers, "Perksradar"));
    timezone = page.timezone;
    return { items: page.days, next: page.next_cursor };
  }, async (item) => {
    const parsed = daySchema.safeParse(item);
    if (!parsed.success) {
      // A malformed day: its month can't be trusted. Without a readable date, no month can.
      const date = (item as any)?.date;
      if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) bad.add(date); else unreadable++;
      return;
    }
    const d = parsed.data;
    if (d.date < from || d.date > to) return;                       // outside the window asked for
    const prev = byDate.get(d.date);
    if (prev && JSON.stringify(prev) !== JSON.stringify(d)) bad.add(d.date);
    byDate.set(d.date, d);
  });
  // A page that couldn't be read, or a day with no readable date: nothing is stored from this read.
  if (problems.length) return { outcome: "incomplete" as const, results, problems };
  if (unreadable) return { outcome: "incomplete" as const, results, problems: [`Perksradar sent ${unreadable} day(s) in an unexpected format; nothing was stored.`] };

  // A month is sent only when it is whole in this read: every one of its days in the window (all days for a past
  // month, the 1st to yesterday for the running month) is present, finished, readable and sent once. Otherwise the
  // month keeps what was stored before (a partial read never replaces a complete month) and the gap is reported.
  // A month that starts before the window was read only in part, so it is never sent.
  const months = new Set<string>();
  for (let d = from; d <= to; d = addDays(d, 1)) months.add(d.slice(0, 7));
  for (const month of [...months].sort()) {
    if (`${month}-01` < from) continue;
    const [y, m] = month.split("-").map(Number);
    const last = `${month}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
    const expected: string[] = [];
    for (let d = `${month}-01`; d <= (last < to ? last : to); d = addDays(d, 1)) expected.push(d);
    const gaps = expected.filter((d) => !byDate.has(d) || !byDate.get(d)!.complete || bad.has(d));
    if (gaps.length) {
      results.push({ month, outcome: "held", reason: `${gaps.length} day(s) missing, unfinished or unreadable (first: ${gaps[0]}); the stored month is kept` });
      continue;
    }
    results.push({ month, ...(await applyPulled(monthToSubmission(month, expected.map((d) => byDate.get(d)!), timezone), `pr:${month}:`, PR_WHO, actor)) });
  }
  const held = results.filter((r) => r.outcome === "held");
  if (held.length) problems.push(...held.map((r) => `Perksradar ${r.month}: ${r.reason}.`));
  return { outcome: results.some((r) => ["rejected", "failed", "held"].includes(r.outcome)) ? "incomplete" as const : "done" as const, results, problems };
}
