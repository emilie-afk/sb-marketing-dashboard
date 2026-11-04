// Pull adapter for the Plant Revenue Breakdown Worker (read-only). It reads saved reports with a viewer key;
// it never triggers exports or collection. NOT verified against the live Worker yet.
//   PLANT_BREAKDOWN_API_URL   the Worker origin
//   PLANT_BREAKDOWN_VIEWER_KEY a key accepted by the Worker's 'viewer' role (server-side only)
import { checkSubmission } from "../../shared/submission";
import { applySubmission } from "../imports";
import { query } from "../db";
import { isExcludedBrand } from "../../shared/scope";

type PbReport = {
  id: string; source: "shopify" | "amazon" | "market"; report_scope: string; period_start: string; period_end: string; timezone: string;
  revision: number; status: string; collected_at: string | null; completeness: string | null; capabilities?: Record<string, unknown>;
};
type PbRow = { product_id: string | null; title: string; vendor: string; product_type: string; units: number; net: number };

let fetchImpl: typeof fetch = (u, i) => fetch(u, i);
export function _setFetchForTests(f: typeof fetch | null) { fetchImpl = f ?? ((u, i) => fetch(u, i)); }

export const plantBreakdownConfigured = () => !!(process.env.PLANT_BREAKDOWN_API_URL && (process.env.PLANT_BREAKDOWN_VIEWER_KEY ?? "").length >= 32);

async function get(path: string) {
  const r = await fetchImpl(`${process.env.PLANT_BREAKDOWN_API_URL!.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${process.env.PLANT_BREAKDOWN_VIEWER_KEY}` } });
  if (!r.ok) throw new Error(`Plant Revenue Breakdown returned ${r.status}`);
  return r.json() as Promise<any>;
}

/** Maps one saved report to a submission. Channel scope states exactly what the report covers. */
export function reportToSubmission(rep: PbReport, rows: PbRow[]) {
  const channel = rep.source === "shopify" ? "channel:shopify_report" : rep.source === "amazon" ? "channel:amazon" : `channel:${rep.source}`;
  const kept = rows.filter((r) => !isExcludedBrand(r.vendor ?? ""));
  return {
    schema_version: 1,
    submission_id: `pb:${rep.id}`,                 // Worker report ids include the revision, so a new revision is a new submission
    source: "plant_breakdown", business: "sb",
    period: { start: rep.period_start, end: rep.period_end, granularity: monthOrCustom(rep.period_start, rep.period_end), timezone: rep.timezone },
    collected_at: rep.collected_at ?? new Date().toISOString(),
    completeness: rep.completeness === "complete" ? "complete" : "partial",
    records: {
      products: kept.map((r) => ({
        external_id: r.product_id ? `pid:${r.product_id}` : `tv:${r.title}|${r.vendor}`.slice(0, 120), title: r.title, vendor: r.vendor || undefined,
        category: r.product_type || undefined, channel_scope: channel, revenue: r.net, units: r.units, cost_state: "missing" as const, gross_profit: null,
      })),
    },
  };
}
function monthOrCustom(s: string, e: string) {
  const end = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return s.endsWith("-01") && e === end ? "month" : "custom";
}

export async function pullPlantBreakdown(actor = "pull:plant_breakdown") {
  if (!plantBreakdownConfigured()) return { outcome: "not_configured" as const };
  const { reports } = await get("/v1/reports");
  const results = [];
  for (const rep of (reports as PbReport[]).filter((r) => r.status === "active" && r.report_scope === "total_sales_by_product")) {
    const done = await query("select 1 from import_runs where source_id = 'pull.plant_breakdown' and submission_id = $1 and outcome in ('accepted','unchanged')", [`pb:${rep.id}`]);
    if (done.length) continue;
    const rows: PbRow[] = [];
    for (let offset = 0; offset < 20000; offset += 500) {
      const page = await get(`/v1/reports/${encodeURIComponent(rep.id)}/rows?offset=${offset}&limit=500`);
      rows.push(...page.rows);
      if (page.rows.length < 500) break;
    }
    const body: any = reportToSubmission(rep, rows);
    // A newer Worker revision of the same report corrects the earlier one instead of duplicating it.
    const key = rep.id.replace(/:r\d+$/, "");
    const prior = await query<{ submission_id: string }>(
      "select submission_id from import_runs where source_id = 'pull.plant_breakdown' and submitter = 'pull:plant_breakdown' and business_id = 'sb' and submission_source = 'plant_breakdown' and status = 'active' and submission_id like $1", [`pb:${key}:r%`]);
    if (prior.length) body.corrects = prior[0].submission_id;
    const checked = checkSubmission(body);
    if (!checked.ok) { results.push({ report: rep.id, outcome: "rejected", errors: checked.errors }); continue; }
    results.push({ report: rep.id, ...(await applySubmission(checked.value, actor, "pull.plant_breakdown", "pull:plant_breakdown")) });
  }
  return { outcome: "done" as const, results };
}
