// Pull adapter for the Gross Profit app's read-only reporting API (GET /v1/reporting/weeks). Server side only.
//   GROSS_PROFIT_API_URL           the Gross Profit Worker origin
//   GROSS_PROFIT_REPORTING_SECRET  that Worker's REPORTING_SECRET (its own revocable credential)
//
// Ownership: this integration sends gross profit, the revenue it was calculated on, product cost and shipping
// cost only. It never sends revenue or orders (the weekly report owns those). Its scope is the Shopify store, not
// the business total, so it is never shown as, or mixed with, all-channel figures.
// Published weeks only. A later published revision of a week is sent as a correction of the earlier one.
import { z } from "zod";
import { applyPulled, walkPages } from "./pullApply";
import { originOf, getJson } from "./reportingClient";

export const GP_SOURCE_ID = "pull.gross_profit";
export const GP_SUBMITTER = "pull:gross_profit";
export const GP_SCOPE = "channel:shopify_store";
const GP_WHO = { sourceId: "pull.gross_profit", submitter: "pull:gross_profit", submissionSource: "gross_profit" };
export const GP_SCOPE_LABEL = "Shopify store (all Shopify sales channels)";
const MAX_PAGES = 20;

export const grossProfitConfigured = () => !!originOf(process.env.GROSS_PROFIT_API_URL) && (process.env.GROSS_PROFIT_REPORTING_SECRET ?? "").length >= 32;

const amount = z.number().finite().nullable();
const weekSchema = z.object({
  id: z.string(), snapshot_id: z.string().regex(/^snp_[0-9a-f]{20}$/), revision: z.number().int().min(1),
  period: z.object({ start: z.string(), end: z.string(), week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), granularity: z.enum(["week", "custom"]), timezone: z.string() }),
  completeness: z.enum(["complete", "provisional", "partial"]), completeness_reasons: z.array(z.string()),
  computed_at: z.string().nullable(), published_at: z.string().nullable(),
  totals: z.object({ gross_profit: amount, gross_profit_revenue_basis: amount, product_cost: amount, shipping_cost: amount }).passthrough(),
  // Optional: the same week by order date (the GP app's own monthly view adds orders up the same way).
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), gross_profit: amount, gross_profit_revenue_basis: amount, product_cost: amount, shipping_cost: amount,
    // Optional: product figures per store/vendor for that date (product GP before shipping; missing costs counted apart).
    vendors: z.array(z.object({ vendor: z.string().min(1).max(120), units: z.number().finite(), known_cost_revenue: z.number().finite(),
      known_product_cost: z.number().finite(), known_cost_gp: z.number().finite(), missing_cost_revenue: z.number().finite(),
      missing_cost_lines: z.number().int().min(0) }).passthrough()).max(500).optional(),
  }).passthrough()).max(7).optional(),
});
const pageSchema = z.object({ ok: z.literal(true), schema_version: z.literal(1), weeks: z.array(z.unknown()), next_cursor: z.string().nullable() });
type Week = z.infer<typeof weekSchema>;

const obs = (metric: string, v: number | null) => v === null
  ? { metric, scope: GP_SCOPE, scope_label: GP_SCOPE_LABEL, value: null, state: "missing" as const }
  : { metric, scope: GP_SCOPE, scope_label: GP_SCOPE_LABEL, value: v };

const DAY_METRICS = ["gross_profit", "gross_profit_revenue_basis", "product_cost", "shipping_cost"] as const;
/**
 * A week's days, only when they lie inside the week and all four figures agree with the week's totals (±$0.05).
 * A figure missing from the week stays missing on every day; a figure the week has must be present on every day.
 * Gross profit and its revenue basis must be known. Otherwise no days are used and only the week total is kept.
 */
export function usableDays(w: Week) {
  const days = w.days ?? [];
  if (!days.length || new Set(days.map((d) => d.date)).size !== days.length) return [];
  if (days.some((d) => d.date < w.period.start || d.date > w.period.end)) return [];
  if (w.totals.gross_profit === null || w.totals.gross_profit_revenue_basis === null) return [];
  for (const k of DAY_METRICS) {
    const total = w.totals[k];
    if (total === null) continue;
    if (days.some((d) => d[k] === null || d[k] === undefined)) return [];
    if (Math.abs(days.reduce((a, d) => a + (d[k] as number), 0) - total) > 0.05) return [];
  }
  return [...days].sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({ ...d, ...Object.fromEntries(DAY_METRICS.filter((k) => w.totals[k] === null).map((k) => [k, null])) }) as typeof d);
}

/** How a vendor name is matched between Gross Profit and the product reports: case, spacing, punctuation and a
 * trailing "(…)" are ignored ("Fern Hollow Shop" = "FernHollow shop", "North Nursery (12345)" = "North Nursery"). */
export const vendorSlug = (name: string) => name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, "").slice(0, 60);
export const GP_VENDOR_SCOPE = "gp_vendor:";
export const GP_VENDORS_COVERAGE = "gp_vendors";
export const VENDOR_METRICS = ["vendor_product_gp", "vendor_product_gp_revenue_basis", "vendor_missing_cost_revenue", "vendor_missing_cost_lines"] as const;

/**
 * A usable day's product figures per vendor, as observations scoped gp_vendor:<slug> (label = the vendor name).
 * Names that match the same slug are added together. Product GP is before shipping and covers known-cost lines
 * only; the revenue whose cost is missing is sent alongside so the dashboard can label the figure incomplete.
 */
export function vendorDayObservations(d: { date: string; vendors?: { vendor: string; known_cost_revenue: number; known_cost_gp: number; missing_cost_revenue: number; missing_cost_lines: number }[] }) {
  const by = new Map<string, { label: string; gp: number; basis: number; missing: number; lines: number }>();
  for (const v of d.vendors ?? []) {
    const slug = vendorSlug(v.vendor);
    if (!slug) continue;
    const b = by.get(slug) ?? by.set(slug, { label: v.vendor.trim(), gp: 0, basis: 0, missing: 0, lines: 0 }).get(slug)!;
    b.gp += v.known_cost_gp; b.basis += v.known_cost_revenue; b.missing += v.missing_cost_revenue; b.lines += v.missing_cost_lines;
  }
  const c2 = (x: number) => Math.round(x * 100) / 100;
  // One coverage marker per day: the day has a vendor breakdown (a vendor absent from it sold nothing that day).
  const marker = { metric: "vendor_breakdown_vendors", scope: GP_VENDORS_COVERAGE, scope_label: "Gross Profit vendor breakdown", value: by.size,
    period_start: d.date, period_end: d.date, granularity: "day" as const };
  return [marker, ...[...by.entries()].flatMap(([slug, b]) => ([
    ["vendor_product_gp", b.gp], ["vendor_product_gp_revenue_basis", b.basis], ["vendor_missing_cost_revenue", b.missing], ["vendor_missing_cost_lines", b.lines],
  ] as const).map(([metric, v]) => ({ metric, scope: `${GP_VENDOR_SCOPE}${slug}`, scope_label: b.label.slice(0, 120), value: c2(v),
    period_start: d.date, period_end: d.date, granularity: "day" as const })))];
}

/** One published week → one submission (week totals, plus the same figures by day when the app sends them). */
export function weekToSubmission(w: Week) {
  const days = usableDays(w);
  // Vendor figures only when every usable day carries them (a week is all or nothing, so a date range is never half covered).
  const withVendors = days.length > 0 && days.every((d) => Array.isArray((d as any).vendors));
  const dayObs = days.flatMap((d) => [...DAY_METRICS
    .map((k) => ({ ...obs(k, d[k] ?? null), period_start: d.date, period_end: d.date, granularity: "day" as const })),
    ...(withVendors ? vendorDayObservations(d as any) : [])]);
  return {
    schema_version: 1,
    submission_id: `gp:${w.period.week_start}:r${w.revision}${days.length ? "d" : ""}${withVendors ? "v" : ""}`,
    source: "gross_profit", business: "sb" as const,
    period: { start: w.period.start, end: w.period.end, granularity: w.period.granularity, timezone: w.period.timezone },
    collected_at: new Date(w.published_at ?? w.computed_at ?? Date.now()).toISOString(),
    completeness: w.completeness,
    records: {
      observations: [
        obs("gross_profit", w.totals.gross_profit),
        obs("gross_profit_revenue_basis", w.totals.gross_profit_revenue_basis),
        obs("product_cost", w.totals.product_cost),
        obs("shipping_cost", w.totals.shipping_cost),
        ...dayObs,
      ],
    },
    source_refs: [{ label: `Gross Profit week of ${w.period.week_start}, published revision ${w.revision}${w.completeness_reasons.length ? ` (${w.completeness_reasons.join(", ").replace(/_/g, " ")})` : ""}` }],
  };
}

export async function pullGrossProfit(actor = GP_SUBMITTER) {
  if (!grossProfitConfigured()) return { outcome: "not_configured" as const, results: [], problems: [] };
  const origin = originOf(process.env.GROSS_PROFIT_API_URL)!;
  const headers = { "x-reporting-secret": process.env.GROSS_PROFIT_REPORTING_SECRET! };
  const results: any[] = [];
  const problems = await walkPages<unknown>("Gross Profit", MAX_PAGES, async (cursor) => {
    const page = pageSchema.parse(await getJson(origin, `/v1/reporting/weeks?limit=52${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, headers, "Gross Profit"));
    return { items: page.weeks, next: page.next_cursor };
  }, async (item) => {
    const parsed = weekSchema.safeParse(item);
    if (!parsed.success) { results.push({ outcome: "rejected", reason: "unexpected week format" }); return; }
    const w = parsed.data;
    results.push({ week: w.period.week_start, ...(await applyPulled(weekToSubmission(w), `gp:${w.period.week_start}:`, GP_WHO, actor)) });
  });
  return { outcome: problems.length ? "incomplete" as const : "done" as const, results, problems };
}
