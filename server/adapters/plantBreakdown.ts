// Pull adapter for the Plant Revenue Breakdown Worker's existing read API (GET /v1/reports, /v1/reports/:id/rows).
// It reads saved reports only; it never triggers exports or collection. Server side only.
//   PLANT_BREAKDOWN_API_URL        the Worker origin
//   PLANT_BREAKDOWN_REPORTING_KEY  that Worker's REPORTING_SECRET (its own revocable key, separate from the viewer key)
//
// Ownership: this integration is the source of Succulents Box product sales (by product and vendor).
// Row shape as the Worker returns it: { productId, title, vendor, productType, cur: { units, net, ... } }.
import { z } from "zod";
import { applyPulled, describe } from "./pullApply";
import { query } from "../db";
import { isExcludedBrand } from "../../shared/scope";
import { originOf, getJson } from "./reportingClient";

export const PB_SOURCE_ID = "pull.plant_breakdown";
export const PB_SUBMITTER = "pull:plant_breakdown";
const PB_WHO = { sourceId: "pull.plant_breakdown", submitter: "pull:plant_breakdown", submissionSource: "plant_breakdown" };
const ROW_PAGE = 500;
const MAX_ROWS = 20000;

export const plantBreakdownConfigured = () => !!originOf(process.env.PLANT_BREAKDOWN_API_URL) && (process.env.PLANT_BREAKDOWN_REPORTING_KEY ?? "").length >= 32;

const reportSchema = z.object({
  id: z.string().regex(/^(shopify|amazon|market):[^/?#\\]{1,120}:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}:r\d{1,6}$/),
  source: z.enum(["shopify", "amazon", "market"]), report_scope: z.string(),
  period_start: z.string(), period_end: z.string(), timezone: z.string(), revision: z.number().int(), status: z.string(),
  collected_at: z.string().nullable().optional(), completeness: z.string().nullable().optional(),
}).passthrough();
const rowSchema = z.object({
  productId: z.string().nullable().optional(), title: z.string(), vendor: z.string().nullable().optional(), productType: z.string().nullable().optional(),
  cur: z.object({ units: z.number().finite().nullable().optional(), net: z.number().finite().nullable().optional() }).passthrough(),
}).passthrough();
export type PbReport = z.infer<typeof reportSchema>;
export type PbRow = z.infer<typeof rowSchema>;

/** Maps one saved report to a submission. Channel scope states exactly what the report covers. */
export function reportToSubmission(rep: PbReport, rows: PbRow[]) {
  const channel = rep.source === "shopify" ? "channel:shopify_report" : rep.source === "amazon" ? "channel:amazon" : `channel:${rep.source}`;
  const kept = rows.filter((r) => !isExcludedBrand(r.vendor ?? ""));
  return {
    schema_version: 1,
    submission_id: `pb:${rep.id}`,                 // Worker report ids include the revision, so a new revision is a new submission
    source: "plant_breakdown", business: "sb",
    period: { start: rep.period_start, end: rep.period_end, granularity: monthOrCustom(rep.period_start, rep.period_end), timezone: rep.timezone },
    collected_at: new Date(rep.collected_at ?? Date.now()).toISOString(),
    completeness: rep.completeness === "complete" ? "complete" : "partial",
    records: {
      products: kept.map((r) => ({
        external_id: r.productId ? `pid:${r.productId}` : `tv:${r.title}|${r.vendor ?? ""}`.slice(0, 120), title: r.title, vendor: r.vendor || undefined,
        category: r.productType || undefined, channel_scope: channel, revenue: r.cur.net ?? null, units: r.cur.units ?? null,
        cost_state: "missing" as const, gross_profit: null,
      })),
    },
  };
}
function monthOrCustom(s: string, e: string) {
  const end = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return s.endsWith("-01") && e === end ? "month" : "custom";
}

export async function pullPlantBreakdown(actor = PB_SUBMITTER) {
  if (!plantBreakdownConfigured()) return { outcome: "not_configured" as const, results: [], problems: [] };
  const origin = originOf(process.env.PLANT_BREAKDOWN_API_URL)!;
  const headers = { authorization: `Bearer ${process.env.PLANT_BREAKDOWN_REPORTING_KEY}` };
  const list = z.object({ ok: z.literal(true), reports: z.array(z.unknown()) }).parse(await getJson(origin, "/v1/reports", headers, "Plant Revenue Breakdown"));
  const results: any[] = [];
  const problems: string[] = [];
  for (const item of list.reports) {
    const parsed = reportSchema.safeParse(item);
    if (!parsed.success) { results.push({ outcome: "rejected", reason: "unexpected report format" }); continue; }
    const rep = parsed.data;
    if (rep.status !== "active" || rep.report_scope !== "total_sales_by_product") continue;
    const key = rep.id.replace(/:r\d+$/, "");
    const family = `pb:${key}:r`;
    // Already the active revision of this report: no need to read its rows again.
    const active = await query<{ submission_id: string; rejected_count: number }>(
      `select submission_id, rejected_count from import_runs where source_id = $1 and submitter = $2 and business_id = 'sb' and submission_source = 'plant_breakdown'
         and status = 'active' and left(submission_id, length($3)) = $3 order by revision desc limit 1`, [PB_SOURCE_ID, PB_SUBMITTER, family]);
    if (active[0] && active[0].submission_id.replace(/:c\d+$/, "") === `pb:${rep.id}`) {
      // Already current; if it was stored with rejected rows, keep saying so.
      results.push({ report: rep.id, outcome: "unchanged", submission_id: active[0].submission_id, stored_with_rejected: Number(active[0].rejected_count) });
      continue;
    }
    const rows: PbRow[] = [];
    let complete = false;
    try {
      for (let offset = 0; offset < MAX_ROWS; offset += ROW_PAGE) {
        const page = z.object({ ok: z.literal(true), rows: z.array(rowSchema) }).parse(
          await getJson(origin, `/v1/reports/${encodeURIComponent(rep.id)}/rows?offset=${offset}&limit=${ROW_PAGE}`, headers, "Plant Revenue Breakdown"));
        rows.push(...page.rows);
        if (page.rows.length < ROW_PAGE) { complete = true; break; }
      }
    } catch (e) {
      // This report is skipped (nothing partial is stored for it); reports already imported stay, and later ones are still read.
      results.push({ report: rep.id, outcome: "failed", reason: describe(e) });
      problems.push(`Report ${rep.id}: rows could not be read (${describe(e)}); it was not imported`);
      continue;
    }
    if (!complete) { results.push({ report: rep.id, outcome: "rejected", reason: `more than ${MAX_ROWS} rows` }); problems.push(`Report ${rep.id} has more than ${MAX_ROWS} rows; it was not imported`); continue; }
    results.push({ report: rep.id, ...(await applyPulled(reportToSubmission(rep, rows), family, PB_WHO, actor)) });
  }
  return { outcome: problems.length ? "incomplete" as const : "done" as const, results, problems };
}
