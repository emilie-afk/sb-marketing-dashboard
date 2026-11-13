// Reporting pulls from the team's other apps, on a real database with synthetic API responses only:
// Gross Profit (published weekly totals), Corporate Gifting (monthly corporate revenue) and Plant Revenue
// Breakdown (saved product reports). Checks ownership and scope, revisions as corrections, completeness,
// pagination, credential handling (own header, no redirects, https only), failures keeping data, and the job flow.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { freshDb, call, q, closePool } from "./helpers";
import { _setReportingFetchForTests, originOf, CLIENT_LIMITS } from "../server/adapters/reportingClient";
import { pullGrossProfit, GP_SCOPE } from "../server/adapters/grossProfit";
import { pullCorporateGifting, CG_SCOPE } from "../server/adapters/corporateGifting";
import { pullPlantBreakdown } from "../server/adapters/plantBreakdown";
import { _setDispatcherForTests, enqueueScheduled, runJob } from "../server/syncJobs";

const GP_URL = "https://gp.example.test", CG_URL = "https://cg.example.test", PB_URL = "https://pb.example.test";
const GP_KEY = "g".repeat(40), CG_KEY = "c".repeat(40), PB_KEY = "p".repeat(40);
type Seen = { url: string; headers: Record<string, string>; redirect?: string };
let seen: Seen[] = [];
let routes: Record<string, () => Response> = {};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });

function serve() {
  _setReportingFetchForTests((async (u: any, init: any) => {
    const url = String(u);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), redirect: init?.redirect });
    const r = routes[url] ?? routes[url.replace(/\?.*$/, "")];
    return r ? r() : new Response("not found", { status: 404 });
  }) as any);
}

const gpWeek = (week: string, over: any = {}) => ({
  id: `gp:week:${week}`, snapshot_id: `snp_${"0".repeat(19)}${over.revision ?? 1}`, revision: 1,
  period: { start: week, end: addDays(week, 6), week_start: week, granularity: "week", timezone: "America/Los_Angeles" },
  completeness: "complete", completeness_reasons: [], computed_at: "2026-10-01T00:00:00Z", published_at: "2026-10-02T00:00:00Z",
  totals: { gross_profit: 100, gross_profit_revenue_basis: 400, product_cost: 250, shipping_cost: 50, missing_cost_lines: 0 }, ...over,
});
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cgMonth = (m: string, over: any = {}) => ({
  id: `cg:month:${m}`, revision: "a".repeat(16),
  period: { start: `${m}-01`, end: new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10), granularity: "month", timezone: "America/Los_Angeles" },
  scope: { key: "channel:corporate" }, completeness: "complete", completeness_reasons: [], currency: "USD",
  totals: { net_revenue_cents: 123456, shopify_net_revenue_cents: 123456, manual_net_revenue_cents: 0, manual_entries: 0, shopify_orders: 7, shopify_units: 90, marketplace_fees_cents: null, fees_recorded_channels: 0 },
  channels: [], ...over,
});
const obs = (source: string, metric?: string) => q(`select metric_key, scope_key, to_char(period_start,'YYYY-MM-DD') s, value::float8 v, value_state, completeness, status from observations
  where source_id = $1 ${metric ? "and metric_key = $2" : ""} order by period_start, metric_key, status`, metric ? [source, metric] : [source]);

beforeAll(async () => { await freshDb(); });
afterAll(closePool);
beforeEach(() => {
  seen = []; routes = {}; serve();
  Object.assign(process.env, { GROSS_PROFIT_API_URL: GP_URL, GROSS_PROFIT_REPORTING_SECRET: GP_KEY, CORPORATE_GIFTING_API_URL: CG_URL,
    CORPORATE_GIFTING_REPORTING_SECRET: CG_KEY, CORPORATE_GIFTING_PULL_ENABLED: "true", PLANT_BREAKDOWN_API_URL: PB_URL, PLANT_BREAKDOWN_REPORTING_KEY: PB_KEY });
});
afterEach(() => {
  _setReportingFetchForTests(null); _setDispatcherForTests(null);
  for (const k of ["GROSS_PROFIT_API_URL", "GROSS_PROFIT_REPORTING_SECRET", "CORPORATE_GIFTING_API_URL", "CORPORATE_GIFTING_REPORTING_SECRET", "CORPORATE_GIFTING_PULL_ENABLED", "PLANT_BREAKDOWN_API_URL", "PLANT_BREAKDOWN_REPORTING_KEY"]) delete process.env[k];
});

describe("Gross Profit", () => {
  it("imports published weeks across pages as profit, its basis and costs, at the Shopify-store scope, never as revenue", async () => {
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-09-07")], next_cursor: "2026-09-07" });
    routes[`${GP_URL}/v1/reporting/weeks?limit=52&cursor=2026-09-07`] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-09-14", { completeness: "provisional", completeness_reasons: ["missing_product_costs"], totals: { gross_profit: 80, gross_profit_revenue_basis: 300, product_cost: 190, shipping_cost: null } })], next_cursor: null });
    const r = await pullGrossProfit();
    expect(r.outcome).toBe("done");
    expect(seen.map((s) => s.url)).toEqual([`${GP_URL}/v1/reporting/weeks?limit=52`, `${GP_URL}/v1/reporting/weeks?limit=52&cursor=2026-09-07`]);
    expect(seen.every((s) => s.headers["x-reporting-secret"] === GP_KEY && !s.url.includes(GP_KEY) && s.redirect === "manual")).toBe(true);
    const rows = await obs("pull.gross_profit");
    expect(new Set(rows.map((x: any) => x.metric_key))).toEqual(new Set(["gross_profit", "gross_profit_revenue_basis", "product_cost", "shipping_cost"]));
    expect(rows.every((x: any) => x.scope_key === GP_SCOPE)).toBe(true);
    expect(rows.find((x: any) => x.s === "2026-09-14" && x.metric_key === "shipping_cost")).toMatchObject({ value_state: "missing", completeness: "provisional" });
    // Margin pairs profit with its own basis: 100 / 400 for the first week.
    const p = await call("viewer", "GET", "/business/sb/profitability?start=2026-09-07&end=2026-09-13&compare=none");
    expect(p.status).toBe(200);
    const m = Object.fromEntries(p.body.metrics.map((x: any) => [x.key, x]));
    expect(m.gross_profit.value.value).toBe(100);
    expect(m.margin.value.value).toBeCloseTo(0.25, 9);
    expect(p.body.source.status).toBe("ok");
  });
  it("uses the days a week sends, so a month counts each order date once; days that don't add up are ignored", async () => {
    const day = (date: string, gp: number) => ({ date, gross_profit: gp, gross_profit_revenue_basis: gp * 4, product_cost: gp * 2, shipping_cost: gp });
    const wk = (start: string, gps: number[], over: any = {}) => gpWeek(start, { totals: { gross_profit: gps.reduce((a, b) => a + b, 0), gross_profit_revenue_basis: gps.reduce((a, b) => a + b, 0) * 4, product_cost: 0, shipping_cost: 0 },
      days: gps.map((g, i) => day(addDays(start, i), g)), ...over });
    // Mon Sep 28 – Sun Oct 4 runs into October; Oct 5 – 11 sends days that don't add up to its totals.
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ ok: true, schema_version: 1, weeks: [wk("2025-09-29", [1, 2, 10, 20, 30, 40, 50]),
      { ...wk("2025-10-06", [5, 5, 5, 5, 5, 5, 5]), days: [day("2025-10-06", 999)] }], next_cursor: null });
    await pullGrossProfit();
    const { metricValue } = await import("../server/metricQuery");
    // Oct 1–5: Wed–Sun of the first week from its days (10+20+30+40+50).
    const oct = await metricValue("sb", "gross_profit", GP_SCOPE, { start: "2025-10-01", end: "2025-10-05" });
    expect(oct.value).toMatchObject({ state: "value", value: 150 });
    expect(oct.coverage).toMatchObject({ status: "supported", granularity: "day" });
    expect((await metricValue("sb", "margin", GP_SCOPE, { start: "2025-10-01", end: "2025-10-05" })).value.value).toBeCloseTo(0.25, 9);
    // The second week's days were ignored: only its week total is stored.
    expect((await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and granularity = 'day' and period_start >= '2025-10-06' and status = 'active'"))[0].n).toBe(0);
    const both = await metricValue("sb", "gross_profit", GP_SCOPE, { start: "2025-10-01", end: "2025-10-12" });
    expect(both.value.state).toBe("incomplete");     // Oct 6–12 has no days, its week runs past the range
  });
  it("a re-read changes nothing; a new published revision corrects the earlier one", async () => {
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-09-07"), gpWeek("2026-09-14", { completeness: "provisional", completeness_reasons: ["missing_product_costs"], totals: { gross_profit: 80, gross_profit_revenue_basis: 300, product_cost: 190, shipping_cost: null } })], next_cursor: null });
    const before = (await q("select count(*)::int n from import_runs where source_id = 'pull.gross_profit'"))[0].n;
    const again = await pullGrossProfit();
    expect(again.results!.every((x: any) => x.outcome === "unchanged")).toBe(true);
    expect((await q("select count(*)::int n from import_runs where source_id = 'pull.gross_profit'"))[0].n).toBe(before);
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-09-07", { revision: 2, totals: { gross_profit: 120, gross_profit_revenue_basis: 400, product_cost: 230, shipping_cost: 50 } })], next_cursor: null });
    await pullGrossProfit();
    const active = (await obs("pull.gross_profit", "gross_profit")).filter((x: any) => x.s === "2026-09-07");
    expect(active.find((x: any) => x.status === "active").v).toBe(120);
    expect(active.some((x: any) => x.status === "superseded" && x.v === 100)).toBe(true);
    expect((await q("select corrects_submission_id from import_runs where submission_id = 'gp:2026-09-07:r2'"))[0].corrects_submission_id).toBe("gp:2026-09-07:r1");
  });
  it("a refused credential or a redirect marks the source failing and keeps the data; redirects are never followed", async () => {
    const n = (await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and status = 'active'"))[0].n;
    for (const route of [reply({ error: "reporting_auth" }, 401), () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/x" } })]) {
      seen = [];
      routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = route;
      const r = await pullGrossProfit();
      expect(r.outcome).toBe("incomplete");
      expect(r.results).toEqual([]);
      expect(r.problems[0]).toMatch(/page 1 could not be read \((Gross Profit refused the reporting credential|Gross Profit answered with a redirect, which is not followed)\)/);
      expect(seen).toHaveLength(1);
    }
    expect((await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and status = 'active'"))[0].n).toBe(n);
  });
  it("a stalled source times out", async () => {
    const saved = CLIENT_LIMITS.timeoutMs; CLIENT_LIMITS.timeoutMs = 50;
    _setReportingFetchForTests(((_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as any);
    try { expect((await pullGrossProfit()).problems[0]).toMatch(/did not answer in time/); } finally { CLIENT_LIMITS.timeoutMs = saved; }
  });
  it("an unexpected record is rejected, not imported", async () => {
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ ok: true, schema_version: 1, weeks: [{ id: "x", revision: "one" }], next_cursor: null });
    const r = await pullGrossProfit();
    expect(r.results).toEqual([{ outcome: "rejected", reason: "unexpected week format" }]);
  });
});

describe("Corporate Gifting", () => {
  it("imports monthly corporate revenue; orders and units are incomplete for a month with manual sales", async () => {
    routes[`${CG_URL}/api/reporting/v1/months?limit=24`] = reply({ ok: true, schema_version: 1, as_of: "2026-10-05T08:00:00Z", next_cursor: null, months: [
      cgMonth("2026-08"), cgMonth("2026-09", { revision: "b".repeat(16), completeness: "partial", completeness_reasons: ["manual_records_need_review"],
        totals: { net_revenue_cents: 78000, shopify_net_revenue_cents: 28000, manual_net_revenue_cents: 50000, manual_entries: 1, shopify_orders: 2, shopify_units: 20, marketplace_fees_cents: 3500, fees_recorded_channels: 1 } })] });
    await pullCorporateGifting();
    expect(seen[0].headers.authorization).toBe(`Bearer ${CG_KEY}`);
    const rows = await obs("pull.corporate_gifting");
    expect(rows.every((x: any) => x.scope_key === CG_SCOPE)).toBe(true);
    expect(rows.find((x: any) => x.s === "2026-08-01" && x.metric_key === "revenue").v).toBe(1234.56);
    expect(rows.find((x: any) => x.s === "2026-08-01" && x.metric_key === "orders").v).toBe(7);
    expect(rows.find((x: any) => x.s === "2026-09-01" && x.metric_key === "orders")).toMatchObject({ value_state: "incomplete", completeness: "partial" });
    expect(rows.find((x: any) => x.s === "2026-09-01" && x.metric_key === "revenue").v).toBe(780);
    // Never at the business-total scope, so it is never added to business revenue.
    expect((await q("select count(*)::int n from observations where source_id = 'pull.corporate_gifting' and scope_key = 'all'"))[0].n).toBe(0);
    const c = await call("viewer", "GET", "/business/sb/corporate?start=2026-08-01&end=2026-08-31&compare=none");
    expect(c.body.metrics.find((m: any) => m.key === "revenue").value.value).toBe(1234.56);
  });
  it("a changed revision corrects that month", async () => {
    routes[`${CG_URL}/api/reporting/v1/months?limit=24`] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [cgMonth("2026-08", { revision: "c".repeat(16), totals: { ...cgMonth("2026-08").totals, net_revenue_cents: 100000 } })] });
    await pullCorporateGifting();
    const rev = (await obs("pull.corporate_gifting", "revenue")).filter((x: any) => x.s === "2026-08-01");
    expect(rev.find((x: any) => x.status === "active").v).toBe(1000);
    expect((await q(`select corrects_submission_id from import_runs where submission_id = 'cg:2026-08:${"c".repeat(16)}'`))[0].corrects_submission_id).toBe(`cg:2026-08:${"a".repeat(16)}`);
  });
});

describe("Plant Revenue Breakdown", () => {
  const id = "shopify:total_sales_by_product:2026-09-01:2026-09-30:r1";
  it("reads the Worker's real row shape across pages with its own reporting key", async () => {
    const row = (i: number) => ({ seq: i, productId: String(1000 + i), title: `Demo plant ${i}`, vendor: "Demo vendor", productType: "Succulent", cur: { units: 2, gross: 20, disc: 0, ret: 0, net: 20, tax: 0, total: 20 }, prior: null });
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [{ id, source: "shopify", report_scope: "total_sales_by_product", period_start: "2026-09-01", period_end: "2026-09-30",
      timezone: "America/Los_Angeles", revision: 1, status: "active", collected_at: "2026-10-01T10:00:00Z", completeness: "complete" }] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(id)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: Array.from({ length: 500 }, (_, i) => row(i)) });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(id)}/rows?offset=500&limit=500`] = reply({ ok: true, rows: [row(500)] });
    const r = await pullPlantBreakdown();
    expect(r.outcome).toBe("done");
    expect(seen.every((s) => s.headers.authorization === `Bearer ${PB_KEY}`)).toBe(true);
    const sold = await q("select count(*)::int n, sum(revenue)::float8 rev, sum(units)::float8 units from product_observations where import_run_id in (select id from import_runs where source_id = 'pull.plant_breakdown')");
    expect(sold[0]).toEqual({ n: 501, rev: 501 * 20, units: 501 * 2 });
  });

  it("sums a product listed on several rows (e.g. one per sales channel) into one record instead of refusing the report", async () => {
    const dupId = "shopify:total_sales_by_product:2025-02-01:2025-02-28:r1";
    const line = (pid: string | null, title: string, type: string, units: number, net: number) =>
      ({ productId: pid, title, vendor: "Demo vendor", productType: type, cur: { units, gross: net, disc: 0, ret: 0, net, tax: 0, total: net }, prior: null });
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [{ id: dupId, source: "shopify", report_scope: "total_sales_by_product", period_start: "2025-02-01", period_end: "2025-02-28",
      timezone: "America/Los_Angeles", revision: 1, status: "active", collected_at: "2025-03-01T10:00:00Z", completeness: "complete" }] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(dupId)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: [
      line("777", "Echeveria", "Succulent", 2, 20),       // online store
      line("777", "Echeveria", "Succulent", 1, 12.5),     // another channel, same product
      line(null, "Gift card", "Gift", 1, 25),             // no product id: title + vendor + type
      line(null, "Gift card", "Gift", 2, 50),
      line(null, "Gift card", "Card", 1, 5),              // same title and vendor, different type: a different product
    ] });
    const r = await pullPlantBreakdown();
    expect(r.outcome).toBe("done");
    expect(r.results.find((x: any) => x.report === dupId).outcome).toBe("accepted");
    const rows = await q(`select p.title, po.revenue::float8 rev, po.units::float8 units, po.channel_scope from product_observations po join products p on p.id = po.product_id
      where po.status = 'active' and po.period_start = '2025-02-01' and po.import_run_id in (select id from import_runs where source_id = 'pull.plant_breakdown') order by p.title, po.revenue`);
    expect(rows).toEqual([
      { title: "Echeveria", rev: 32.5, units: 3, channel_scope: "channel:shopify_report" },
      { title: "Gift card", rev: 5, units: 1, channel_scope: "channel:shopify_report" },
      { title: "Gift card", rev: 75, units: 3, channel_scope: "channel:shopify_report" },
    ]);
  });
});

describe("credentials and settings", () => {
  it("accepts only https origins without paths or credentials", () => {
    expect(originOf("https://gp.example.test")).toBe("https://gp.example.test");
    expect(originOf("https://gp.example.test/")).toBe("https://gp.example.test");
    for (const bad of ["http://gp.example.test", ["https://u:p", "gp.example.test"].join("@"), "https://gp.example.test/v1", "https://gp.example.test?x=1", "not a url", ""]) expect(originOf(bad)).toBeNull();
  });
  it("a short or missing credential counts as not configured", async () => {
    process.env.GROSS_PROFIT_REPORTING_SECRET = "short";
    expect((await pullGrossProfit()).outcome).toBe("not_configured");
    expect(seen).toHaveLength(0);
  });
});

describe("job flow", () => {
  it("the schedule queues each configured pull hourly, never reads itself, and a second tick adds none", async () => {
    await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')");
    delete process.env.PLANT_BREAKDOWN_REPORTING_KEY;                 // not configured: not queued
    const started: string[] = [];
    _setDispatcherForTests(async (jid) => { started.push(jid); });
    await enqueueScheduled(new Date("2026-11-05T10:05:00Z"));
    expect(seen).toHaveLength(0);
    const kinds = (await q("select kind from sync_jobs where status = 'queued' order by kind")).map((r: any) => r.kind);
    expect(kinds).toEqual(["corporate_gifting", "gross_profit"]);
    await enqueueScheduled(new Date("2026-11-05T10:06:00Z"));
    expect(started).toHaveLength(2);
    await enqueueScheduled(new Date("2026-11-05T10:20:00Z"));            // not the start of an hour: nothing
    expect(started).toHaveLength(2);
  });
  it("Refresh now queues the same job flow; viewers cannot; a failing source records the error and keeps data", async () => {
    await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')");
    const started: string[] = [];
    _setDispatcherForTests(async (jid) => { started.push(jid); });
    expect((await call("viewer", "POST", "/settings/sources/pull.gross_profit/refresh")).status).toBe(403);
    expect((await call("editor", "POST", "/settings/sources/blocked.content_intelligence/refresh")).status).toBe(404);
    const r = await call("editor", "POST", "/settings/sources/pull.gross_profit/refresh");
    expect(r.status).toBe(202);
    expect((await call("editor", "POST", "/settings/sources/pull.gross_profit/refresh")).body.outcome).toBe("already_running");
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ error: "x" }, 401);
    const before = (await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and status = 'active'"))[0].n;
    await runJob(r.body.job_id);
    const job = (await call("viewer", "GET", `/settings/sync-jobs/${r.body.job_id}`)).body;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/refused the reporting credential/);
    const src = (await q("select status, last_error from source_connections where id = 'pull.gross_profit'"))[0];
    expect(src).toMatchObject({ status: "failing" });
    expect((await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and status = 'active'"))[0].n).toBe(before);
    delete process.env.GROSS_PROFIT_REPORTING_SECRET;
    expect((await call("editor", "POST", "/settings/sources/pull.gross_profit/refresh")).status).toBe(409);
  });
  it("Content Intelligence stays inactive", async () => {
    expect((await q("select status from source_connections where id = 'blocked.content_intelligence'"))[0].status).toBe("blocked");
    const s = (await call("viewer", "GET", "/settings")).body;
    expect(s.pulls.map((p: any) => p.kind).sort()).toEqual(["corporate_gifting", "gross_profit", "plant_breakdown", "task_tracker"]);
    expect(s.sources.some((x: any) => x.id === "blocked.gross_profit" || x.id === "blocked.corporate_gifting")).toBe(false);
  });
});

// ---------------------------------------------------------------- regressions from review (2026-11-05)
describe("review regressions", () => {
  const CG_PAGE = `${CG_URL}/api/reporting/v1/months?limit=24`;
  const month = (rev: string, cents: number) => cgMonth("2026-03", { revision: rev, totals: { ...cgMonth("2026-03").totals, net_revenue_cents: cents } });
  const activeRevenue = async () => (await q("select value::float8 v from observations where source_id = 'pull.corporate_gifting' and metric_key = 'revenue' and period_start = '2026-03-01' and status = 'active'"))[0]?.v;

  it("1. content A → B → A ends on A (compared with the active revision, not any earlier one)", async () => {
    for (const [rev, cents] of [["1".repeat(16), 10000], ["2".repeat(16), 20000], ["1".repeat(16), 10000]] as const) {
      routes[CG_PAGE] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [month(rev, cents)] });
      const r = await pullCorporateGifting();
      expect(r.results![0].outcome).toBe("accepted");
      expect(await activeRevenue()).toBe(cents / 100);
    }
    const runs = await q("select submission_id, corrects_submission_id, status from import_runs where source_id = 'pull.corporate_gifting' and submission_id like 'cg:2026-03:%' order by received_at");
    expect(runs.map((r: any) => r.submission_id)).toEqual([`cg:2026-03:${"1".repeat(16)}`, `cg:2026-03:${"2".repeat(16)}`, `cg:2026-03:${"1".repeat(16)}:c2`]);
    expect(runs[2].corrects_submission_id).toBe(`cg:2026-03:${"2".repeat(16)}`);
    expect(runs.filter((r: any) => r.status === "active")).toHaveLength(1);
    // Reading A again now changes nothing.
    const again = await pullCorporateGifting();
    expect(again.results![0].outcome).toBe("unchanged");
  });

  it("1b. the same holds for a Gross Profit week rolled back to an earlier published revision", async () => {
    const page = `${GP_URL}/v1/reporting/weeks?limit=52`;
    const w = (rev: number, gp: number) => gpWeek("2026-06-01", { revision: rev, totals: { gross_profit: gp, gross_profit_revenue_basis: 500, product_cost: 300, shipping_cost: 50 } });
    for (const [rev, gp] of [[1, 100], [2, 150], [1, 100]]) {
      routes[page] = reply({ ok: true, schema_version: 1, weeks: [w(rev, gp)], next_cursor: null });
      await pullGrossProfit();
      expect((await q("select value::float8 v from observations where source_id = 'pull.gross_profit' and metric_key = 'gross_profit' and period_start = '2026-06-01' and status = 'active'"))[0].v).toBe(gp);
    }
  });

  it("2. a failed import makes the job and source fail, with the reason in Settings; mixed results are partial", async () => {
    await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')");
    _setDispatcherForTests(async () => {});
    // A database trigger makes one record's write fail inside applySubmission (outcome "failed").
    await q(`create or replace function test_fail_obs() returns trigger language plpgsql as $$ begin
      if new.metric_key = 'revenue' and new.value = 666 then raise exception 'simulated write failure'; end if; return new; end $$`);
    await q("create trigger test_fail_obs before insert on observations for each row execute function test_fail_obs()");
    try {
      routes[CG_PAGE] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [cgMonth("2026-04", { revision: "4".repeat(16), totals: { ...cgMonth("2026-04").totals, net_revenue_cents: 66600 } })] });
      let job = (await call("editor", "POST", "/settings/sources/pull.corporate_gifting/refresh")).body.job_id;
      await runJob(job);
      let j = (await call("viewer", "GET", `/settings/sync-jobs/${job}`)).body;
      expect(j.status).toBe("failed");
      expect(j.error).toMatch(/1 record\(s\) not imported \(failed\)/);
      expect((await q("select status, last_error from source_connections where id = 'pull.corporate_gifting'"))[0]).toMatchObject({ status: "failing" });
      // One good month and one failing month: partial, never success.
      routes[CG_PAGE] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [
        cgMonth("2026-05", { revision: "5".repeat(16) }), cgMonth("2026-04", { revision: "4".repeat(16), totals: { ...cgMonth("2026-04").totals, net_revenue_cents: 66600 } })] });
      job = (await call("editor", "POST", "/settings/sources/pull.corporate_gifting/refresh")).body.job_id;
      await runJob(job);
      j = (await call("viewer", "GET", `/settings/sync-jobs/${job}`)).body;
      expect(j.status).toBe("partial");
      expect(j.result.outcome).toBe("partial");
      expect(j.error).toMatch(/not imported/);
      expect((await q("select status from source_connections where id = 'pull.corporate_gifting'"))[0].status).toBe("failing");
    } finally {
      await q("drop trigger if exists test_fail_obs on observations"); await q("drop function if exists test_fail_obs()");
    }
    // A clean read afterwards restores the source.
    routes[CG_PAGE] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [cgMonth("2026-04", { revision: "6".repeat(16) })] });
    const job = (await call("editor", "POST", "/settings/sources/pull.corporate_gifting/refresh")).body.job_id;
    await runJob(job);
    expect((await call("viewer", "GET", `/settings/sync-jobs/${job}`)).body.status).toBe("succeeded");
    expect((await q("select status, last_error from source_connections where id = 'pull.corporate_gifting'"))[0]).toEqual({ status: "ok", last_error: null });
  });

  it("2b. rejected records also make the job partial or failed", async () => {
    await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')");
    _setDispatcherForTests(async () => {});
    routes[`${GP_URL}/v1/reporting/weeks?limit=52`] = reply({ ok: true, schema_version: 1, weeks: [{ id: "x" }], next_cursor: null });
    const job = (await call("editor", "POST", "/settings/sources/pull.gross_profit/refresh")).body.job_id;
    await runJob(job);
    const j = (await call("viewer", "GET", `/settings/sync-jobs/${job}`)).body;
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/not imported \(rejected\)/);
  });

  it("3 (dashboard side). manual entries are read from the source's count: a sale and refund cancelling out still mark counts incomplete", async () => {
    routes[CG_PAGE] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [cgMonth("2026-02", { revision: "7".repeat(16),
      totals: { net_revenue_cents: 30000, shopify_net_revenue_cents: 30000, manual_net_revenue_cents: 0, manual_entries: 2, shopify_orders: 3, shopify_units: 30 } })] });
    await pullCorporateGifting();
    const rows = await q("select metric_key, value_state from observations where source_id = 'pull.corporate_gifting' and period_start = '2026-02-01' and status = 'active' order by metric_key");
    expect(rows).toEqual([{ metric_key: "orders", value_state: "incomplete" }, { metric_key: "revenue", value_state: "value" }, { metric_key: "units", value_state: "incomplete" }]);
    // A month without the count is refused rather than guessed.
    routes[CG_PAGE] = reply({ ok: true, schema_version: 1, as_of: null, next_cursor: null, months: [cgMonth("2026-01", { totals: { net_revenue_cents: 1, shopify_net_revenue_cents: 1, manual_net_revenue_cents: 0, shopify_orders: 1, shopify_units: 1 } })] });
    expect((await pullCorporateGifting()).results).toEqual([{ outcome: "rejected", reason: "unexpected month format" }]);
  });

  it("5. a repeated cursor or unfinished paging is reported, never 'done', and the job is partial", async () => {
    const base = `${GP_URL}/v1/reporting/weeks?limit=52`;
    routes[base] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-07-06")], next_cursor: "2026-07-06" });
    routes[`${base}&cursor=2026-07-06`] = reply({ ok: true, schema_version: 1, weeks: [], next_cursor: "2026-07-06" });   // loops
    const loop = await pullGrossProfit();
    expect(loop.outcome).toBe("incomplete");
    expect(loop.problems).toEqual(["Gross Profit repeated a page cursor; reading stopped"]);
    // Twenty-one pages with distinct cursors: stops at the limit and says so.
    seen = [];
    let n = 0;
    _setReportingFetchForTests((async (u: any) => { seen.push({ url: String(u), headers: {} }); n++;
      return new Response(JSON.stringify({ ok: true, schema_version: 1, weeks: [], next_cursor: `2027-01-${String(n).padStart(2, "0")}` }), { status: 200 }); }) as any);
    const long = await pullGrossProfit();
    expect(long.outcome).toBe("incomplete");
    expect(long.problems[0]).toMatch(/more than 20 pages/);
    expect(seen).toHaveLength(20);
    serve();
    // Through the job: partial with the reason (the first page's week was imported).
    await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')");
    _setDispatcherForTests(async () => {});
    routes[base] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-07-13")], next_cursor: "2026-07-13" });
    routes[`${base}&cursor=2026-07-13`] = reply({ ok: true, schema_version: 1, weeks: [], next_cursor: "2026-07-13" });
    const job = (await call("editor", "POST", "/settings/sources/pull.gross_profit/refresh")).body.job_id;
    await runJob(job);
    const j = (await call("viewer", "GET", `/settings/sync-jobs/${job}`)).body;
    expect(j.status).toBe("partial");
    expect(j.error).toMatch(/repeated a page cursor/);
  });

  it("corporate stays disconnected until enabled: credentials alone do not connect it", async () => {
    delete process.env.CORPORATE_GIFTING_PULL_ENABLED;
    expect((await pullCorporateGifting()).outcome).toBe("not_configured");
    expect(seen).toHaveLength(0);
    expect((await call("editor", "POST", "/settings/sources/pull.corporate_gifting/refresh")).status).toBe(409);
    await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')");
    _setDispatcherForTests(async () => {});
    await enqueueScheduled(new Date("2026-11-05T11:05:00Z"));
    expect((await q("select kind from sync_jobs where status = 'queued'")).map((r: any) => r.kind)).not.toContain("corporate_gifting");
    const s = (await call("viewer", "GET", "/settings")).body;
    const cg = s.pulls.find((p: any) => p.kind === "corporate_gifting");
    expect(cg.configured).toBe(false);
    expect(cg.held).toMatch(/ownership change/);
  });
});

// ---------------------------------------------------------------- regressions from review round 3 (2026-11-05)
describe("review regressions, round 3", () => {
  const pbId = "shopify:total_sales_by_product:2026-08-01:2026-08-31:r1";
  const pbReport = (id = pbId) => ({ id, source: "shopify", report_scope: "total_sales_by_product", period_start: id.split(":")[2], period_end: id.split(":")[3],
    timezone: "America/Los_Angeles", revision: 1, status: "active", collected_at: "2026-09-01T10:00:00Z", completeness: "complete" });
  // Passes the adapter's row check, then fails submission validation (channel scope with a space): 0 accepted, 1 rejected.
  const goodRow = { productId: "2001", title: "Demo plant", vendor: "Demo vendor", productType: "Succulent", cur: { units: 1, net: 10 } };
  const badRow = { productId: "2002", title: "   ", vendor: "Demo vendor", productType: "Succulent", cur: { units: 1, net: 10 } };
  const clearJobs = async () => { await q("update sync_jobs set status = 'abandoned' where status in ('queued','running')"); _setDispatcherForTests(async () => {}); };
  const refresh = async (source: string) => {
    const job = (await call("editor", "POST", `/settings/sources/${source}/refresh`)).body.job_id;
    await runJob(job);
    return (await call("viewer", "GET", `/settings/sync-jobs/${job}`)).body;
  };

  it("B. a record saved with rejected rows is a problem, now and on every later read of the same revision", async () => {
    await clearJobs();
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [pbReport()] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(pbId)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: [goodRow, badRow] });
    const first = await refresh("pull.plant_breakdown");
    expect(first.status).toBe("partial");
    expect(first.error).toMatch(/1 record\(s\) saved with some of their rows rejected/);
    expect((await q("select rejected_count from import_runs where submission_id = $1", [`pb:${pbId}`]))[0].rejected_count).toBe(1);
    // Retrying the same revision: unchanged, but never healthy.
    const again = await refresh("pull.plant_breakdown");
    expect(again.result.results[0]).toMatchObject({ outcome: "unchanged", stored_with_rejected: 1 });
    expect(again.status).toBe("partial");
    expect((await q("select status from source_connections where id = 'pull.plant_breakdown'"))[0].status).toBe("failing");
  });

  it("net units below zero (returns exceeding sales) are kept, like negative revenue", async () => {
    await clearJobs();
    const id3 = "shopify:total_sales_by_product:2025-05-01:2025-05-31:r1";
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [pbReport(id3)] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(id3)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: [
      goodRow, { productId: "2003", title: "Returned plant", vendor: "Demo vendor", productType: "Succulent", cur: { units: -2, net: -18.5 } }] });
    const j = await refresh("pull.plant_breakdown");
    expect(j.status).toBe("succeeded");
    const back = await q(`select po.units::float8 units, po.revenue::float8 rev from product_observations po join products p on p.id = po.product_id
      where p.title = 'Returned plant' and po.status = 'active'`);
    expect(back).toEqual([{ units: -2, rev: -18.5 }]);
  });

  it("a revision stored with rejected rows is re-imported once the rules accept more of it, and never loops", async () => {
    await clearJobs();
    const id4 = "shopify:total_sales_by_product:2025-04-01:2025-04-30:r1";
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [pbReport(id4)] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(id4)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: [goodRow, badRow] });
    expect((await refresh("pull.plant_breakdown")).status).toBe("partial");                  // 1 row rejected (blank title)
    // Pretend an older rule had rejected one more row than today's rules do.
    await q("update import_runs set rejected_count = 2 where submission_id = $1 and status = 'active'", [`pb:${id4}`]);
    const fixed = await refresh("pull.plant_breakdown");
    expect(fixed.result.results[0].outcome).toBe("accepted");                                    // re-imported as a correction
    const active = await q("select submission_id, rejected_count, corrects_submission_id from import_runs where submission_id like $1 and status = 'active'", [`pb:${id4}%`]);
    expect(active).toEqual([{ submission_id: `pb:${id4}:c2`, rejected_count: 1, corrects_submission_id: `pb:${id4}` }]);
    // Same rules again: nothing written, still reported as incomplete, never healthy.
    const again = await refresh("pull.plant_breakdown");
    expect(again.result.results[0]).toMatchObject({ outcome: "unchanged", stored_with_rejected: 1 });
    expect(again.status).toBe("partial");
    expect((await q("select count(*)::int n from import_runs where submission_id like $1 and outcome = 'accepted'", [`pb:${id4}%`]))[0].n).toBe(2);
  });

  it("B2. a record with every row rejected (0 accepted, 1 rejected) is not counted as success", async () => {
    await clearJobs();
    const id2 = "shopify:total_sales_by_product:2026-07-01:2026-07-31:r1";
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [pbReport(id2)] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(id2)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: [badRow] });
    const j = await refresh("pull.plant_breakdown");
    expect(j.status).not.toBe("succeeded");
    expect(j.error).toMatch(/rejected/);
  });

  it("C. a later page that fails keeps the earlier saved pages, reports partial, and a retry is safe", async () => {
    await clearJobs();
    const base = `${GP_URL}/v1/reporting/weeks?limit=52`;
    routes[base] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-05-04"), gpWeek("2026-05-11")], next_cursor: "2026-05-11" });
    routes[`${base}&cursor=2026-05-11`] = reply({ error: "boom" }, 500);
    const j = await refresh("pull.gross_profit");
    expect(j.status).toBe("partial");
    expect(j.result.results.filter((x: any) => x.outcome === "accepted")).toHaveLength(2);
    expect(j.error).toMatch(/page 2 could not be read \(Gross Profit returned 500\)/);
    expect(j.error).toMatch(/2 record\(s\) were saved or already current and are kept; reading again is safe/);
    expect(j.error).not.toMatch(/Previous data is unchanged/);
    const saved = await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and status = 'active' and period_start in ('2026-05-04','2026-05-11')");
    expect(saved[0].n).toBe(8);
    // Retry once the source is healthy again: earlier weeks unchanged, the rest imported, success.
    routes[`${base}&cursor=2026-05-11`] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-05-18")], next_cursor: null });
    const retry = await refresh("pull.gross_profit");
    expect(retry.status).toBe("succeeded");
    expect(retry.result.results.map((x: any) => x.outcome)).toEqual(expect.arrayContaining(["unchanged", "accepted"]));
    expect((await q("select count(*)::int n from import_runs where source_id = 'pull.gross_profit' and submission_id like 'gp:2026-05-%'"))[0].n).toBe(3);
  });

  it("C2. a page that cannot be parsed after earlier progress is partial too; a first page that fails saves nothing", async () => {
    await clearJobs();
    const base = `${GP_URL}/v1/reporting/weeks?limit=52`;
    routes[base] = reply({ ok: true, schema_version: 1, weeks: [gpWeek("2026-04-06")], next_cursor: "2026-04-06" });
    routes[`${base}&cursor=2026-04-06`] = reply({ ok: true, weeks: "not a list" });
    const j = await refresh("pull.gross_profit");
    expect(j.status).toBe("partial");
    expect(j.error).toMatch(/page 2 could not be read \(unexpected response format\)/);
    routes[base] = reply({ error: "x" }, 401);
    const f = await refresh("pull.gross_profit");
    expect(f.status).toBe("failed");
    expect(f.error).toMatch(/refused the reporting credential.*Previous data is unchanged/);
  });

  it("C3. a Plant report whose rows fail to load is skipped; reports already imported and later ones are kept", async () => {
    await clearJobs();
    const a = "shopify:total_sales_by_product:2026-05-01:2026-05-31:r1", b = "shopify:total_sales_by_product:2026-06-01:2026-06-30:r1";
    routes[`${PB_URL}/v1/reports`] = reply({ ok: true, reports: [pbReport(a), pbReport(b)] });
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(a)}/rows?offset=0&limit=500`] = reply({ error: "x" }, 500);
    routes[`${PB_URL}/v1/reports/${encodeURIComponent(b)}/rows?offset=0&limit=500`] = reply({ ok: true, rows: [goodRow] });
    const j = await refresh("pull.plant_breakdown");
    expect(j.status).toBe("partial");
    expect(j.result.results.find((x: any) => x.report === a)).toMatchObject({ outcome: "failed" });
    expect(j.result.results.find((x: any) => x.report === b)).toMatchObject({ outcome: "accepted" });
    expect(j.error).toMatch(/Report .*2026-05-01.*rows could not be read/);
  });
});
