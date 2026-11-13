// Pull adapter for the Corporate Gifting app's read-only reporting API (GET /api/reporting/v1/months).
//   CORPORATE_GIFTING_API_URL           the Corporate Gifting site origin
//   CORPORATE_GIFTING_REPORTING_SECRET  that app's CORPORATE_REPORTING_SECRET (its own revocable credential)
//
// Ownership: this integration is the source of corporate channel figures (scope channel:corporate): monthly
// revenue, and Shopify order and unit counts. Corporate revenue is shown separately and never added to business
// totals. Orders and units count Shopify orders only, so for a month that also has manual revenue they are sent
// as incomplete (never as a figure that would understate them).
// A month whose content revision changed is sent as a correction of the earlier submission.
import { z } from "zod";
import { applyPulled, walkPages } from "./pullApply";
import { originOf, getJson } from "./reportingClient";

export const CG_SOURCE_ID = "pull.corporate_gifting";
export const CG_SUBMITTER = "pull:corporate_gifting";
export const CG_SCOPE = "channel:corporate";
const CG_WHO = { sourceId: "pull.corporate_gifting", submitter: "pull:corporate_gifting", submissionSource: "corporate_gifting" };
const MAX_PAGES = 20;

export const corporateGiftingCredentials = () => !!originOf(process.env.CORPORATE_GIFTING_API_URL) && (process.env.CORPORATE_GIFTING_REPORTING_SECRET ?? "").length >= 32;
/**
 * Off until the ownership change is confirmed: corporate channel figures move from the weekly report task to this
 * pull, and the weekly report's existing channel:corporate rows must be reconciled first. Credentials alone do not
 * connect it; CORPORATE_GIFTING_PULL_ENABLED=true does, deliberately.
 */
export const corporateGiftingConfigured = () => corporateGiftingCredentials() && process.env.CORPORATE_GIFTING_PULL_ENABLED === "true";
export const corporateGiftingHeld = () => corporateGiftingCredentials() && process.env.CORPORATE_GIFTING_PULL_ENABLED !== "true"
  ? "Credentials are set, but the pull stays off until the ownership change for corporate figures is confirmed (CORPORATE_GIFTING_PULL_ENABLED)." : null;

const cents = z.number().int();
const monthSchema = z.object({
  id: z.string().regex(/^cg:month:\d{4}-\d{2}$/), revision: z.string().regex(/^[0-9a-f]{16}$/),
  period: z.object({ start: z.string(), end: z.string(), granularity: z.literal("month"), timezone: z.string() }),
  completeness: z.enum(["complete", "provisional", "partial"]), completeness_reasons: z.array(z.string()),
  totals: z.object({ net_revenue_cents: cents, shopify_net_revenue_cents: cents, manual_net_revenue_cents: cents, manual_entries: cents.min(0), shopify_orders: cents.min(0), shopify_units: cents.min(0) }).passthrough(),
});
const pageSchema = z.object({ ok: z.literal(true), schema_version: z.literal(1), as_of: z.string().nullable(), months: z.array(z.unknown()), next_cursor: z.string().nullable() });
type Month = z.infer<typeof monthSchema>;

export function monthToSubmission(m: Month, asOf: string | null) {
  const month = m.period.start.slice(0, 7);
  // The source's count of manual entries, not their net amount: a sale and its refund cancel out to zero but are still manual.
  const manual = m.totals.manual_entries > 0;
  const count = (metric: string, v: number) => manual
    ? { metric, scope: CG_SCOPE, value: null, state: "incomplete" as const }      // manual revenue has no order counts
    : { metric, scope: CG_SCOPE, value: v };
  return {
    schema_version: 1,
    submission_id: `cg:${month}:${m.revision}`,
    source: "corporate_gifting", business: "sb" as const,
    period: { start: m.period.start, end: m.period.end, granularity: "month" as const, timezone: m.period.timezone },
    collected_at: new Date(asOf ?? Date.now()).toISOString(),
    completeness: m.completeness,
    records: {
      observations: [
        { metric: "revenue", scope: CG_SCOPE, scope_label: "Corporate gifting", value: m.totals.net_revenue_cents / 100 },
        count("orders", m.totals.shopify_orders),
        count("units", m.totals.shopify_units),
      ],
    },
    source_refs: [{ label: `Corporate Gifting ${month}${m.completeness_reasons.length ? ` (${m.completeness_reasons.join(", ").replace(/_/g, " ")})` : ""}` }],
  };
}

export async function pullCorporateGifting(actor = CG_SUBMITTER) {
  if (!corporateGiftingConfigured()) return { outcome: "not_configured" as const, results: [], problems: [] };
  const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
  const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
  const results: any[] = [];
  let asOf: string | null = null;
  const problems = await walkPages<unknown>("Corporate Gifting", MAX_PAGES, async (cursor) => {
    const page = pageSchema.parse(await getJson(origin, `/api/reporting/v1/months?limit=24${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, headers, "Corporate Gifting"));
    asOf = page.as_of;
    return { items: page.months, next: page.next_cursor };
  }, async (item) => {
    const parsed = monthSchema.safeParse(item);
    if (!parsed.success) { results.push({ outcome: "rejected", reason: "unexpected month format" }); return; }
    const m = parsed.data, month = m.period.start.slice(0, 7);
    results.push({ month, ...(await applyPulled(monthToSubmission(m, asOf), `cg:${month}:`, CG_WHO, actor)) });
  });
  return { outcome: problems.length ? "incomplete" as const : "done" as const, results, problems };
}

const sampleSignupsSchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal(1),
  count: z.number().int().nonnegative(),
});

export async function corporateSampleSignups() {
  if (!corporateGiftingCredentials()) return { count: null };
  try {
    const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
    const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
    const report = await getJson(origin, "/api/reporting/v1/sample-signups", headers, "Corporate Gifting sample signups");
    return { count: sampleSignupsSchema.parse(report).count };
  } catch {
    return { count: null };
  }
}
