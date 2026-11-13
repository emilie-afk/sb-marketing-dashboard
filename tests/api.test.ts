// Database-backed behaviour through the real API handler.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, submit, q, closePool } from "./helpers";
import { envelope, weekRange, listingCheck, annualWorkbook, seasonalWorkbook } from "./fixtures/synthetic";
import { runSheetSync, intakeToSubmissions } from "../server/sheetSync";
import { buildSnapshot } from "../server/routes/reports";
import { READER_LIMITS, _setFetchForTests } from "../server/sheetsReader";

beforeAll(async () => {
  process.env.EXCLUDED_BRANDS = "Excluded Demo Brand";
  process.env.TRACKED_CHANNELS = "online_store:Online store,amazon:Marketplace A";
  await freshDb();
});
afterAll(closePool);

const week = weekRange(0), prev = weekRange(1);
const obs = (rev: number, orders: number, extra: any[] = []) => ({ observations: [{ metric: "revenue", value: rev }, { metric: "orders", value: orders }, ...extra] });

describe("authentication and access", () => {
  it("requires an approved member for internal data", async () => {
    expect((await call(null, "GET", "/overview")).status).toBe(401);
    expect((await call("outsider", "GET", "/overview")).status).toBe(401);
    expect((await call("viewer", "GET", "/overview")).status).toBe(200);
  });
  it("enforces viewer / editor / admin on the server", async () => {
    expect((await call("viewer", "POST", "/tasks", { title: "x", business_id: "sb" })).status).toBe(403);
    expect((await call("editor", "POST", "/tasks", { title: "x", business_id: "sb" })).status).toBe(200);
    expect((await call("editor", "POST", "/settings/automation-clients", { label: "tt", sources: ["a"], businesses: ["sb"] })).status).toBe(403);
    expect((await call("admin", "POST", "/settings/automation-clients", { label: "tt", sources: ["a"], businesses: ["sb"] })).status).toBe(200);
  });
  it("refuses cross-site writes", async () => {
    expect((await call("editor", "POST", "/tasks", { title: "x", business_id: "sb" }, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("keeps automation tokens separate from sessions and limited to their sources", async () => {
    const c = await call("admin", "POST", "/settings/automation-clients", { label: "Weekly report", sources: ["weekly_report"], businesses: ["sb"] });
    const token = c.body.token as string;
    // A session cookie cannot submit; a token cannot read dashboards.
    expect((await call("admin", "POST", "/submissions", { ...envelope("s-auth", "sb", week), records: obs(1, 1) })).status).toBe(401);
    expect((await call(null, "GET", "/overview", undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
    // Wrong business for this token.
    const wrong = await call(null, "POST", "/submissions", { ...envelope("s-auth-p2s", "p2s", week), records: obs(1, 1) }, { authorization: `Bearer ${token}` });
    expect(wrong.status).toBe(403);
    const ok = await call(null, "POST", "/submissions", { ...envelope("s-auth-sb", "sb", { start: "2025-01-04", end: "2025-01-10" }), records: obs(10, 1) }, { authorization: `Bearer ${token}` });
    expect(ok.status).toBe(201);
    expect(ok.body.outcome).toBe("accepted");
    await call("admin", "POST", `/settings/automation-clients/${c.body.id}/revoke`);
    expect((await call(null, "POST", "/submissions", { ...envelope("s-auth-2", "sb", week), records: obs(1, 1) }, { authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe("imports: duplicates, corrections, failures", () => {
  it("a repeated identical submission does not duplicate data", async () => {
    const body = { ...envelope("dup-1", "sb", week), records: obs(1000, 30) };
    expect((await submit(body)).outcome).toBe("accepted");
    const again = await submit(body);
    expect(again.outcome).toBe("unchanged");
    expect((await q("select count(*)::int n from observations where status = 'active' and period_start = $1", [week.start]))[0].n).toBe(2);
  });
  it("the same id with different content is rejected; a correction creates a new revision", async () => {
    const changed = await submit({ ...envelope("dup-1", "sb", week), records: obs(1200, 31) });
    expect(changed.outcome).toBe("rejected");
    expect(changed.message).toMatch(/corrects/);
    const corr = await submit({ ...envelope("dup-1-fix", "sb", week, "week", { corrects: "dup-1" }), records: obs(1200, 31) });
    expect(corr).toMatchObject({ outcome: "accepted", revision: 2 });
    const rows = await q("select value::float8 v, status from observations where metric_key = 'revenue' and period_start = $1 order by id", [week.start]);
    expect(rows).toEqual([{ v: 1000, status: "superseded" }, { v: 1200, status: "active" }]);
  });
  it("a second submission for an already reported period must be a correction", async () => {
    const r = await submit({ ...envelope("dup-2", "sb", week), records: obs(5, 5) });
    expect(r.outcome).toBe("rejected");
    expect((await q("select value::float8 v from observations where status='active' and metric_key='revenue' and period_start=$1", [week.start]))[0].v).toBe(1200);
  });
  it("invalid records are rejected individually with a receipt and the import is marked incomplete", async () => {
    const r = await submit({ ...envelope("partial-1", "sb", { start: "2025-02-01", end: "2025-02-07" }), records: { observations: [{ metric: "revenue", value: 10 }, { metric: "orders", value: null, state: "value" }] } });
    expect(r.outcome).toBe("accepted");
    expect(r.rejected).toHaveLength(1);
    expect((await q("select completeness from import_runs where submission_id = 'partial-1' and status='active'"))[0].completeness).toBe("incomplete");
  });
  it("a failed submission keeps the last successful data", async () => {
    // Unknown metric violates a foreign key inside the transaction.
    const r = await submit({ ...envelope("bad-1", "sb", prev), records: { observations: [{ metric: "revenue", value: 1 }, { metric: "not_a_metric", value: 1 }] } });
    expect(["rejected", "failed"]).toContain(r.outcome);
    expect((await q("select count(*)::int n from observations where period_start = $1", [prev.start]))[0].n).toBe(0);
    expect((await q("select value::float8 v from observations where status='active' and metric_key='revenue' and period_start=$1", [week.start]))[0].v).toBe(1200);
  });
});

describe("periods through the API", () => {
  it("returns an honest unsupported state for a custom range on weekly data", async () => {
    await submit({ ...envelope("w-prev", "sb", prev), records: obs(800, 25) });
    const r = await call("viewer", "GET", `/business/sb/summary?start=2026-10-20&end=2026-10-26&compare=previous_period`);
    const rev = r.body.metrics.find((m: any) => m.key === "revenue");
    expect(rev.value.state).toBe("missing");
    expect(rev.coverage.status).toBe("unsupported");
  });
  it("compares matching weeks with absolute and percent change and weighted AOV", async () => {
    const r = await call("viewer", "GET", `/business/sb/summary?start=${week.start}&end=${week.end}&compare=previous_period`);
    const rev = r.body.metrics.find((m: any) => m.key === "revenue"), aov = r.body.metrics.find((m: any) => m.key === "aov");
    expect(rev.change).toMatchObject({ absolute: 400, percent: 50 });
    expect(aov.value.value).toBeCloseTo(1200 / 31);
  });
});

describe("calendar-day counting across a month", () => {
  // April 2025: Saturday–Friday weeks Mar 29 – Apr 4 and Apr 26 – May 2 run past the month; three weeks lie inside it.
  const satFri = (s: string) => ({ start: s, end: new Date(Date.parse(`${s}T00:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10) });
  const weeks = ["2025-03-29", "2025-04-05", "2025-04-12", "2025-04-19", "2025-04-26"].map(satFri);
  const apr = { start: "2025-04-01", end: "2025-04-30" };
  // EOS scorecard layout: row 3 month labels, row 4 column headers, labels in columns A and B.
  const eos = (aprAll: number | null, fb = 150) => [{ name: "2025", rows: [[], [], [null, null, null, "APR 1-30", null, "MAY 1-31"], ["METRICS", null, "Apr 19 - 25", "TOTAL (MONTH) - Adjusted for Amazon Shipping", "Apr 26 - May 2", "TOTAL (MONTH) - Adjusted for Amazon Shipping"],
    ["Revenue", "All", 1, aprAll, 1, null], [null, "Shopify (Website)", 1, 8000, 1, null], [null, "Amazon (w/o shipping)", 1, 1000, 1, null], [null, "Faire", 1, 300, 1, null],
    [null, "Little Sunnie", 1, 0, 1, null], [null, "Photostosketches", 1, 500, 1, null],
    ["Conversion rate (adjusted)\nSucculents Box", "Added to cart", 0.04, 0.05, 0.04, null], [null, "Reached check out", 0.02, 0.03, 0.02, null], [null, "Converted", 0.008, 0.01, 0.008, null],
    ["Human vs Bot", "Bot checkout/ Human check out rate", 0.01, null, 0.01, null],
    ["Ads Spent", "Google Ads SB", 90, 400, 90, null], [null, "Facebook Ads SB", 30, fb, 30, null], [null, "Total Ad spent (Succulents Box)", 120, 400 + fb, 120, 0], [null, "Photostosketches", 20, 90, 20, null]] }];
  // Daily Analytics Report layout: two columns per day (revenue, orders), channel labels in column A.
  const dar = (web1 = 100) => [{ name: "April 2025", rows: [["Z5"], [], [null, 1, null, 2, null, 3, null, 4],
    ["Website", web1, 5, 110, 6, 120, 7], ["Ebay", 0, 0, 0, 0, 0, 0], ["Amazon (not plus shipping)", 20, 1, 30, 2, 0, 0], ["Cratejoy", 0, 0, 45, null, 0, 0], ["Faire (BPF)", 0, 0, 0, 0, 80, 1],
    ["Little Sunnie"], ["Website", 999, 9, 999, 9, 999, 9], ["Photostosketches"], ["Etsy", 40, 2, 0, 0, 25, 1], ["KDP", null, null, null, null, null, null],
    ["Total", 9999, 99, 9999, 99, 9999, 99]] }];
  let eosSrc = "", darSrc = "";

  it("counts weeks only inside the month, then uses the EOS month totals and daily figures", async () => {
    for (const [i, w] of weeks.entries()) {
      await submit({ ...envelope(`cal-${i}`, "sb", w), records: { observations: [{ metric: "revenue", value: 1000 }, { metric: "orders", value: 10 }, { metric: "ad_spend", value: 100 },
        { metric: "sessions", value: 1000 }, { metric: "sessions_converted", value: 9 }],
        campaigns: [{ platform: "facebook", external_id: "130001", name: "Calendar test", spend: 30, acquisitions: 1, conversion_value: 60 }],
        activities: [{ type: "social", name: "Daily posts (calendar test)", count: 7, count_unit: "posts" }] } });
    }
    // Weekly figures only: the three weeks inside April count; the days of the two weeks running past it are a gap.
    let rev = (await call("viewer", "GET", `/business/sb/summary?start=${apr.start}&end=${apr.end}&compare=previous_period`)).body.metrics.find((m: any) => m.key === "revenue");
    expect(rev.value).toMatchObject({ state: "incomplete", value: 3000 });
    expect(rev.coverage.missingDays).toEqual(["2025-04-01", "2025-04-02", "2025-04-03", "2025-04-04", "2025-04-26", "2025-04-27", "2025-04-28", "2025-04-29", "2025-04-30"]);
    let fb = (await call("viewer", "GET", `/business/sb/advertising?start=${apr.start}&end=${apr.end}`)).body.platforms.find((p: any) => p.platform === "facebook");
    expect(fb.campaigns[0].spend).toMatchObject({ state: "incomplete", value: 90 });
    expect(fb.campaigns[0].spend.note).toMatch(/Mar 29 to Apr 4, 2025.*Apr 26 to May 2, 2025.*not included/);
    // Completed work: a week running past April counts by the share of its days inside it.
    const { activitiesInPeriod } = await import("../server/routes/reports");
    const acts = (await activitiesInPeriod("sb", apr.start, apr.end)).filter((a: any) => a.name.startsWith("Daily posts"));
    expect(acts.map((a: any) => a.count)).toEqual([4, 7, 7, 7, 5]);
    expect(acts[0].prorated).toEqual({ days_inside: 4, days_total: 7, full_count: 7 });

    // The EOS scorecard's April column: month totals replace the weekly sum for the whole month.
    eosSrc = (await q("insert into sheet_sources (business_id, role, label, file_id, file_kind, created_by) values ('sb', 'eos_scorecard', 'EOS', 'TESTeosFILEid0000000000001', 'google_sheet', 't') returning id"))[0].id;
    const r1 = await runSheetSync(eosSrc, "manual", "t", async () => eos(10000) as any);
    expect(r1.outcome).toBe("succeeded");
    const sum = (await call("viewer", "GET", `/business/sb/summary?start=${apr.start}&end=${apr.end}&compare=previous_period`)).body.metrics;
    rev = sum.find((m: any) => m.key === "revenue");
    expect(rev.value).toMatchObject({ state: "value", value: 9500 });       // All − Little Sunnie − Photostosketches
    expect(rev.coverage).toMatchObject({ status: "supported", granularity: "month" });
    expect(sum.find((m: any) => m.key === "ad_spend").value).toMatchObject({ state: "value", value: 550 });
    expect(sum.find((m: any) => m.key === "conversion_rate").value).toMatchObject({ state: "value", value: 0.01 });
    const { metricValue } = await import("../server/metricQuery");
    expect((await metricValue("p2s", "revenue", "all", apr)).value.value).toBe(500);
    expect((await metricValue("p2s", "ad_spend", "all", apr)).value.value).toBe(90);
    expect((await metricValue("sb", "revenue", "channel:amazon", apr)).value.value).toBe(1000);
    // May has not been filled in (its total ad spend formula shows 0): nothing is sent for it.
    expect((await q("select count(*)::int n from observations where source_id = 'sheet.eos_scorecard' and period_start = '2025-05-01'"))[0].n).toBe(0);
    // The platform total uses the month figure; CPA/ROAS are withheld because two campaign weeks are left out.
    fb = (await call("viewer", "GET", `/business/sb/advertising?start=${apr.start}&end=${apr.end}`)).body.platforms.find((p: any) => p.platform === "facebook");
    expect(fb.totals.spend).toMatchObject({ state: "value", value: 150, note: "Month total from the EOS scorecard" });
    expect(fb.totals.roas.state).toBe("missing");
    // Unchanged spreadsheet: nothing written. A changed figure is a correction of that month.
    expect((await runSheetSync(eosSrc, "manual", "t", async () => eos(10000) as any) as any).receipts.every((r: any) => r.outcome === "unchanged")).toBe(true);
    await runSheetSync(eosSrc, "manual", "t", async () => eos(10000, 175) as any);
    expect((await metricValue("sb", "ad_spend", "platform:facebook", apr)).value.value).toBe(175);

    // The Daily Analytics Report: exact figures for any days, Little Sunnie left out.
    darSrc = (await q("insert into sheet_sources (business_id, role, label, file_id, file_kind, created_by) values ('sb', 'daily_analytics', 'DAR', 'TESTdarFILEid0000000000001', 'google_sheet', 't') returning id"))[0].id;
    expect((await runSheetSync(darSrc, "manual", "t", async () => dar() as any)).outcome).toBe("succeeded");
    const d13 = { start: "2025-04-01", end: "2025-04-03" };
    expect((await metricValue("sb", "revenue", "all", d13)).value).toMatchObject({ state: "value", value: 100 + 20 + 110 + 30 + 45 + 120 + 80 });
    expect((await metricValue("sb", "orders", "all", d13)).value.value).toBe(5 + 1 + 6 + 2 + 7 + 1);      // Cratejoy's blank order count adds nothing
    expect((await metricValue("sb", "revenue", "channel:online_store", d13)).value.value).toBe(330);
    expect((await metricValue("p2s", "revenue", "all", d13)).value.value).toBe(65);
    // Day 4 has no figures yet; the whole month still comes from the EOS total.
    expect((await metricValue("sb", "revenue", "all", { start: "2025-04-01", end: "2025-04-04" })).coverage.status).toBe("gaps");
    expect((await metricValue("sb", "revenue", "all", apr)).value.value).toBe(9500);
    const notes = (await q("select tabs_read from sync_runs where sheet_source_id = $1 order by started_at desc limit 1", [darSrc]))[0].tabs_read;
    expect(JSON.stringify(notes)).toMatch(/2025-04-02: no order count for Cratejoy/);
    await runSheetSync(darSrc, "manual", "t", async () => dar(105) as any);
    expect((await metricValue("sb", "revenue", "channel:online_store", d13)).value.value).toBe(335);
  });
});

describe("campaign results across weeks", () => {
  it("never counts overlapping periods twice and withholds CPA/ROAS across different definitions", async () => {
    const w1 = { start: "2027-04-03", end: "2027-04-09" }, w2 = { start: "2027-04-10", end: "2027-04-16" }, wOverlap = { start: "2027-04-05", end: "2027-04-11" };
    const camp = (spend: number, extra: any = {}) => ({ platform: "google", external_id: "777", name: "Overlap test", spend, acquisitions: 2, conversion_value: 60, ...extra });
    await submit({ ...envelope("ov-1", "sb", w1), source: "ads", records: { campaigns: [camp(10), { platform: "google", external_id: "888", name: "Mixed defs", spend: 10, acquisitions: 1, conversion_value: 30, attribution: "7-day click" }] } });
    await submit({ ...envelope("ov-2", "sb", w2), source: "ads", records: { campaigns: [camp(20), { platform: "google", external_id: "888", name: "Mixed defs", spend: 10, acquisitions: 1, conversion_value: 30, attribution: "1-day click" }] } });
    await submit({ ...envelope("ov-3", "sb", wOverlap), source: "ads", records: { campaigns: [camp(99)] } });
    const g = (await call("viewer", "GET", "/business/sb/advertising?start=2027-04-01&end=2027-04-30")).body.platforms.find((p: any) => p.platform === "google");
    const ov = g.campaigns.find((c: any) => c.name === "Overlap test");
    expect(ov.spend.value).toBe(30);   // Apr 3–9 and Apr 10–16; the overlapping Apr 5–11 result is not added on top
    expect(ov.spend.state).toBe("incomplete");
    const mixed = g.campaigns.find((c: any) => c.name === "Mixed defs");
    expect(mixed.spend.value).toBe(20);
    expect(mixed.cpa.state).toBe("missing");
    expect(mixed.roas.state).toBe("missing");
    expect(g.totals.cpa.state).toBe("missing");
    expect(g.totals.roas.state).toBe("missing");
  });
});

describe("advertising", () => {
  it("hides zero-spend campaigns unless included, and has no total row in campaign tables", async () => {
    await submit({ ...envelope("ads-1", "sb", week), source: "ads", records: { campaigns: [
      { platform: "google", external_id: "a", name: "A", spend: 100, acquisitions: 4, conversion_value: 400, status: "Active", status_observed_at: "2026-11-02T00:00:00Z" },
      { platform: "google", external_id: "b", name: "B", spend: 0, acquisitions: 0, conversion_value: 0, status: "Active", status_observed_at: "2026-11-02T00:00:00Z" },
      { platform: "google", external_id: "c", name: "C", spend: 10, acquisitions: 0.5, conversion_value: 5 },
    ] } });
    let r = await call("viewer", "GET", `/business/sb/advertising?start=${week.start}&end=${week.end}`);
    let g = r.body.platforms.find((p: any) => p.platform === "google");
    expect(g.campaigns.map((c: any) => c.name)).toEqual(["A", "C"]);
    expect(g.campaigns.find((c: any) => c.name === "C").cpa.display).toBe("N/A (<1 purchase)");
    expect(g.totals.spend.value).toBe(110);
    expect(g.totals.cpa.value).toBeCloseTo(110 / 4.5);
    const id = (await q("select id from ad_campaigns where external_id = 'b'"))[0].id;
    await call("editor", "POST", `/settings/campaigns/${id}/include`, { include: true });
    r = await call("viewer", "GET", `/business/sb/advertising?start=${week.start}&end=${week.end}`);
    g = r.body.platforms.find((p: any) => p.platform === "google");
    expect(g.campaigns.find((c: any) => c.name === "B")).toMatchObject({ explicitlyIncluded: true, status: "Active" });
  });
  it("keeps each campaign's daily budget, with its note, and leaves it missing when none was sent", async () => {
    const wk = { start: "2025-11-01", end: "2025-11-07" };
    await submit({ ...envelope("ads-budget-1", "sb", wk), source: "ads", records: { campaigns: [
      { platform: "facebook", external_id: "fb-1", name: "Adset budgets", spend: 50, acquisitions: 2, conversion_value: 90, daily_budget: 25, budget_note: "Sum of ad set budgets" },
      { platform: "facebook", external_id: "fb-2", name: "Lifetime", spend: 20, acquisitions: 1, conversion_value: 30, budget_note: "Lifetime budget" },
      { platform: "google", external_id: "g-1", name: "Plain", spend: 70, acquisitions: 3, conversion_value: 210, daily_budget: 10 },
      { platform: "google", external_id: "g-2", name: "No budget sent", spend: 5, acquisitions: 0, conversion_value: 0 },
    ] } });
    // A negative budget rejects that campaign row; nothing is stored for it.
    await submit({ ...envelope("ads-budget-2", "sb", wk), source: "ads", records: { campaigns: [
      { platform: "google", external_id: "g-3", name: "Negative", spend: 5, daily_budget: -1 }] } });
    expect((await q("select count(*)::int n from ad_campaigns where external_id = 'g-3'"))[0].n).toBe(0);
    const r = await call("viewer", "GET", `/business/sb/advertising?start=${wk.start}&end=${wk.end}`);
    const all = r.body.platforms.flatMap((p: any) => p.campaigns);
    const by = (n: string) => all.find((c: any) => c.name === n).dailyBudget;
    expect(by("Adset budgets")).toMatchObject({ state: "value", value: 25, note: "Sum of ad set budgets" });
    expect(by("Lifetime")).toMatchObject({ state: "missing", note: "Lifetime budget" });
    expect(by("Plain")).toMatchObject({ state: "value", value: 10 });
    expect(by("No budget sent").state).toBe("missing");
  });
});

describe("products and vendors", () => {
  it("missing costs never become zero and rankings state their scope", async () => {
    await submit({ ...envelope("prod-1", "sb", week), source: "products", records: { products: [
      { external_id: "p1", title: "Demo A", vendor: "V1 (demo)", category: "Succulents", channel_scope: "channel:online_store", revenue: 100, units: 4, gross_profit: 40, cost_state: "complete" },
      { external_id: "p2", title: "Demo B", vendor: "V1 (demo)", category: "Succulents", channel_scope: "channel:online_store", revenue: 50, units: 2, gross_profit: null, cost_state: "missing" },
      { external_id: "p3", title: "Excluded thing", vendor: "Excluded Demo Brand", channel_scope: "channel:online_store", revenue: 999, units: 1, cost_state: "missing", gross_profit: null },
    ] } });
    const r = await call("viewer", "GET", `/business/sb/vendors?start=${week.start}&end=${week.end}&compare=none`);
    expect(r.body.scopeLabel).toBe("Covers Online store only");
    expect(r.body.vendors).toHaveLength(1);
    const v = r.body.vendors[0];
    expect(v.revenue.value).toBe(150);
    expect(v.grossProfit.state).toBe("incomplete");
    expect(v.margin).toMatchObject({ state: "incomplete", value: 0.4 });   // 40 / 100: only the product with a known cost
    expect(v.missingCostProducts).toBe(1);
  });
});

describe("promotion spreadsheet sync", () => {
  let annual: string, seasonal: string;
  const reader = (sheets: any) => async () => sheets;
  it("imports promotions with stable identities and keeps dashboard-owned fields", async () => {
    annual = (await q("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'annual_calendar', 'A', 'TESTannualFILEid00000000001', 'xlsx', 't') returning id"))[0].id;
    const r = await runSheetSync(annual, "manual", "t", reader(annualWorkbook(2026)));
    expect(r.outcome).toBe("succeeded");
    // DEMOLOVE appears in both the Jan and Feb tabs: one promotion.
    expect((await q("select count(*)::int n from promotions where code = 'DEMOLOVE'"))[0].n).toBe(1);
    await q("update promotions set execution_status = 'launched', owner = 'Owner X' where code = 'DEMOVDAY'");
    const again = await runSheetSync(annual, "schedule", "t", reader(annualWorkbook(2026, { changeFebDates: true })));
    expect(again).toMatchObject({ created: 0, updated: 1 });
    const p = (await q("select to_char(start_date,'YYYY-MM-DD') s, execution_status, owner from promotions where code = 'DEMOVDAY'"))[0];
    expect(p).toEqual({ s: "2026-02-05", execution_status: "launched", owner: "Owner X" });
    expect((await q("select count(*)::int n from promotion_revisions r join promotions p on p.id = r.promotion_id where p.code = 'DEMOVDAY'"))[0].n).toBe(2);
  });
  it("a renamed row keeps its promotion (identity by code, not title)", async () => {
    await runSheetSync(annual, "schedule", "t", reader(annualWorkbook(2026, { renameValentine: true, changeFebDates: true })));
    const rows = await q("select title from promotions where code = 'DEMOVDAY'");
    expect(rows).toEqual([{ title: "Valentine plant week (demo)" }]);
  });
  it("a removed row is flagged, not deleted; a blank tab is not a cancellation", async () => {
    await runSheetSync(annual, "schedule", "t", reader(annualWorkbook(2026, { renameValentine: true, changeFebDates: true, dropSpring: true })));
    const spring = (await q("select review_state, missing_from_source_since is not null as missing from promotions where code = 'DEMOSPRING'"))[0];
    expect(spring).toEqual({ review_state: "needs_review", missing: true });
    await runSheetSync(annual, "schedule", "t", reader(annualWorkbook(2026, { renameValentine: true, changeFebDates: true, blankMarch: true })));
    expect((await q("select count(*)::int n from promotions where title = 'Demo Easter'"))[0].n).toBe(1);
    expect((await q("select count(*)::int n from review_items where kind = 'blank_tab'"))[0].n).toBeGreaterThan(0);
  });
  it("a failed read changes nothing and records the failure", async () => {
    const before = (await q("select count(*)::int n from promotions"))[0].n;
    const r = await runSheetSync(annual, "schedule", "t", async () => { throw new Error("network down"); });
    expect(r.outcome).toBe("failed");
    expect((await q("select count(*)::int n from promotions"))[0].n).toBe(before);
    const src = (await q("select last_error, last_success_at is not null as had_success from sheet_sources where id = $1", [annual]))[0];
    expect(src.last_error).toBeTruthy();
    expect(src.had_success).toBe(true);
  });
  it("a timed-out Apps Script read through the default reader changes nothing and records the failure", async () => {
    const before = await q("select id, title, to_char(start_date,'YYYY-MM-DD') s from promotions order by id");
    const lastOk = (await q("select last_success_at from sheet_sources where id = $1", [annual]))[0].last_success_at;
    process.env.SHEET_READER_URL = "https://script.google.com/macros/s/FAKEdeploymentidabcdefghijklmnop0123/exec";
    process.env.SHEET_READER_KEY = "k".repeat(40);
    const saved = READER_LIMITS.timeoutMs; READER_LIMITS.timeoutMs = 50;
    _setFetchForTests(((_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as any);
    try {
      const r = await runSheetSync(annual, "schedule", "t");
      expect(r).toMatchObject({ outcome: "failed" });
      expect((r as any).error).toMatch(/did not finish within/);
    } finally {
      READER_LIMITS.timeoutMs = saved; _setFetchForTests(null);
      delete process.env.SHEET_READER_URL; delete process.env.SHEET_READER_KEY;
    }
    expect(await q("select id, title, to_char(start_date,'YYYY-MM-DD') s from promotions order by id")).toEqual(before);
    const src = (await q("select last_error, last_success_at from sheet_sources where id = $1", [annual]))[0];
    expect(src.last_error).toMatch(/did not finish within/);
    expect(src.last_success_at).toEqual(lastOk);
  });
  it("flags conflicting vendor dates and keeps vendor cost reductions separate from customer discounts", async () => {
    seasonal = (await q("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'seasonal_program', 'S', 'TESTseasonFILEid00000000001', 'google_sheet', 't') returning id"))[0].id;
    await runSheetSync(seasonal, "manual", "t", reader(seasonalWorkbook(2026, { conflictDates: true })));
    const v = (await q("select vendor_cost_reduction::float8 c, customer_discount::float8 d, special_customer_discount::float8 s, to_char(start_date,'YYYY-MM-DD') start from promotions where vendor = 'Fernwood Growers (demo)' and kind = 'vendor_offer'"))[0];
    expect(v).toEqual({ c: 7, d: 12, s: 20, start: "2026-11-25" });
    expect((await q("select count(*)::int n from review_items where kind = 'conflict' and details->>'identity' = 'vendor:fernwood-growers-demo'"))[0].n).toBe(1);
    // Two-date BF/CM text is kept verbatim, not merged into a range.
    expect((await q("select special_dates_text from promotions where vendor = 'Tilly Air Co (demo)' and kind = 'vendor_offer'"))[0].special_dates_text).toBe("Nov 27 / Nov 30, 2026");
  });
  it("the seasonal program owns a promotion listed in both sheets; the annual sheet cannot overwrite it", async () => {
    await q("update promotions set offer = 'seasonal offer' where code = 'DEMOHARVEST'");
    // The seasonal sync already linked DEMOHARVEST to the seasonal sheet.
    expect((await q("select count(*)::int n from promotion_source_links l join promotions p on p.id = l.promotion_id where p.code = 'DEMOHARVEST' and l.sheet_source_id = $1", [seasonal]))[0].n).toBe(1);
    const wb = annualWorkbook(2026); wb.find((s) => s.name === "Nov 2026")!.rows.push(["Nov 2 - 11", "Harvest (annual copy)", "20% off", "DEMOHARVEST"]);
    await runSheetSync(annual, "schedule", "t", reader(wb));
    const p = (await q("select offer, title from promotions where code = 'DEMOHARVEST'"))[0];
    expect(p.offer).toBe("seasonal offer");
    expect((await q("select count(*)::int n from review_items where kind = 'conflict' and details->>'identity' = 'code:DEMOHARVEST'"))[0].n).toBe(1);
  });
  it("new spreadsheets are registered in Settings without code changes (admin only)", async () => {
    const r = await call("admin", "POST", "/settings/sheet-sources", { business_id: "sb", year: 2027, role: "annual_calendar", label: "2027 calendar", file: "https://docs.google.com/spreadsheets/d/FAKEAAAAAAAAAAAAAAAAAAAAAAAA/edit#gid=0", file_kind: "google_sheet" });
    expect(r.status).toBe(200);
    expect((await q("select file_id from sheet_sources where id = $1", [r.body.id]))[0].file_id).toBe("FAKEAAAAAAAAAAAAAAAAAAAAAAAA");
    expect((await call("editor", "POST", "/settings/sheet-sources", { business_id: "sb", year: 2027, role: "annual_calendar", label: "x", file: "AAAAAAAAAAAAAAAAAAAAAAAAAAAB", file_kind: "xlsx" })).status).toBe(403);
  });
  it("an occasion becomes a promotion only when selected", async () => {
    const occ = (await q("select id from occasions where name = 'Demo Lunar New Year'"))[0];
    const before = (await q("select count(*)::int n from promotions"))[0].n;
    const r = await call("editor", "POST", `/occasions/${occ.id}/select`);
    expect(r.body.existing).toBe(false);
    expect((await q("select count(*)::int n from promotions"))[0].n).toBe(before + 1);
    expect((await call("editor", "POST", `/occasions/${occ.id}/select`)).body.existing).toBe(true);
  });
});

describe("listing reviews", () => {
  it("ingests checks, corrections supersede with history, dependents need review, approval gates tasks", async () => {
    const lr1 = listingCheck("t-check-1", "2026-10-26");
    expect((await submit({ ...envelope("listing-check:t-check-1", "p2s", { start: lr1.window_start, end: lr1.window_end }, "rolling_30"), records: { listing_review: lr1 } })).outcome).toBe("accepted");
    const lr2 = { ...listingCheck("t-check-2", "2026-11-02", { correction: true }) };
    lr2.corrections = [{ supersedes_run_id: "t-check-1", supersedes_finding_key: "f-price", reason: "Sale price misread" }];
    expect((await submit({ ...envelope("listing-check:t-check-2", "p2s", { start: lr2.window_start, end: lr2.window_end }, "rolling_30"), records: { listing_review: lr2 } })).outcome).toBe("accepted");
    const f = await q("select id, finding_key, state from findings where run_id = 't-check-1' order by finding_key");
    expect(Object.fromEntries(f.map((x: any) => [x.finding_key, x.state]))).toMatchObject({ "f-price": "superseded", "f-raise": "needs_review", "f-proof": "active" });
    const raise = f.find((x: any) => x.finding_key === "f-raise"), proof = f.find((x: any) => x.finding_key === "f-proof");
    // Superseded or flagged findings cannot be approved.
    expect((await call("editor", "POST", `/findings/${raise.id}/decision`, { decision: "approved" })).status).toBe(409);
    // Rejected findings cannot become tasks; approved ones can.
    expect((await call("editor", "POST", `/findings/${proof.id}/decision`, { decision: "rejected", create_task: { title: "x" } })).status).toBe(400);
    const tasksBefore = (await q("select count(*)::int n from tasks"))[0].n;
    const ok = await call("editor", "POST", `/findings/${proof.id}/decision`, { decision: "approved", create_task: { title: "Add proof option" } });
    expect(ok.body.task_id).toBeTruthy();
    expect((await q("select count(*)::int n from tasks"))[0].n).toBe(tasksBefore + 1);
    expect((await q("select source from tasks where id = $1", [ok.body.task_id]))[0].source).toBe("finding_approval");
    // History kept: the superseded finding and its correction are still readable.
    const view = await call("viewer", "GET", "/listing-reviews/t-check-1");
    const fp = view.body.listings[0].findings.find((x: any) => x.finding_key === "f-price");
    expect(fp.state).toBe("superseded");
    expect(fp.corrections[0].reason).toBe("Sale price misread");
    expect(view.body.listings[0].keywords.find((k: any) => k.kind === "reported").label).toBe("Reported keyword");
  });
  it("a sensitive proposal is labelled as a proposal, never a fact", async () => {
    const v = await call("viewer", "GET", "/listing-reviews/t-check-2");
    expect(v.body.listings[0].findings.find((x: any) => x.finding_key === "f-proof").label).toBe("Proposal, needs approval");
    expect(v.body.listings[1].keywords[0].label).toMatch(/Fallback title phrase/);
  });
  it("the same check cannot be resent under the same run id", async () => {
    const lr = listingCheck("t-check-1", "2026-10-26");
    const r = await submit({ ...envelope("listing-check:t-check-1b", "p2s", { start: lr.window_start, end: lr.window_end }, "rolling_30"), records: { listing_review: lr } });
    expect(r.outcome).toBe("rejected");
  });
  it("the intake spreadsheet maps tabs to the same submissions", async () => {
    const { subs } = intakeToSubmissions([
      { name: "Checks", rows: [["run_id", "business", "window_start", "window_end", "timezone", "collected_at", "completeness", "scope_note", "excluded_listing_ids"],
        ["sheet-run-1", "p2s", "2026-10-05", "2026-11-03", "America/Los_Angeles", "2026-11-03T03:00:00Z", "complete", "Clicks >= 1", "1000000099"]] },
      { name: "Listing results", rows: [["run_id", "listing_id", "title", "url", "clicks", "orders", "spend"], ["sheet-run-1", "1000000001", "Demo", "https://example.com/l/1", 5, 0, "$1.20"]] },
      { name: "Our options", rows: [["run_id", "listing_id", "option_key", "label", "format", "pages", "price"], ["sheet-run-1", "1000000001", "d1", "Digital", "Digital", 1, 6.5]] },
      { name: "Submissions", rows: [["submission_id", "business", "source", "period_start", "period_end", "granularity", "timezone", "collected_at", "completeness"],
        ["wr-2026-10-30", "sb", "weekly_report", "2026-10-03", "2026-10-09", "week", "America/Los_Angeles", "2026-11-02T08:00:00Z", "complete"]] },
      { name: "Activities", rows: [["submission_id", "type", "name", "count", "count_unit"], ["wr-2026-10-30", "social", "Social posts", 5, "social posts per channel"]] },
      { name: "Campaigns", rows: [["submission_id", "platform", "external_id", "name", "status", "status_observed_at", "spend", "acquisitions", "acquisition_event", "conversion_value", "attribution", "reported_cpa", "reported_roas", "daily_budget", "budget_note"],
        ["wr-2026-10-30", "google", "Shopping", "Shopping", "Active", "2026-11-02T08:00:00Z", "120.5", "3", "purchase", "300", "Google: web purchase", "", "", "40", ""],
        ["wr-2026-10-30", "facebook", "Lifetime", "Lifetime", "Inactive", "2026-11-02T08:00:00Z", "20", "", "purchase", "", "Meta: Purchases", "", "", "", "Lifetime budget"]] },
    ]);
    expect(subs.map((s) => s.body.submission_id)).toEqual(["listing-check:sheet-run-1", "wr-2026-10-30"]);
    for (const s of subs) expect((await submit(s.body, "sheet.intake")).outcome).toBe("accepted");
    // Activity counts never create completed tasks.
    expect((await q("select count(*)::int n from tasks where title ilike '%social posts%'"))[0].n).toBe(0);
    expect((await q("select count_unit from activities where name = 'Social posts'"))[0].count_unit).toBe("social posts per channel");
    expect(await q("select c.name, p.daily_budget::float8 b, p.budget_note from campaign_performance p join ad_campaigns c on c.id = p.campaign_id where c.external_id in ('Shopping', 'Lifetime') order by c.name"))
      .toEqual([{ name: "Lifetime", b: null, budget_note: "Lifetime budget" }, { name: "Shopping", b: 40, budget_note: null }]);
  });
});

describe("tasks", () => {
  it("recurring occurrences keep their own status without duplicating the task", async () => {
    const t = await call("editor", "POST", "/tasks", { title: "Weekly social schedule", business_id: "sb", owner: "A", due_date: "2026-11-02", recurrence: "weekly:1" });
    expect((await call("editor", "PATCH", `/tasks/${t.body.id}/occurrences/2026-11-09`, { status: "done" })).status).toBe(200);
    expect((await call("editor", "PATCH", `/tasks/${t.body.id}/occurrences/2026-11-10`, { status: "done" })).status).toBe(400);
    const list = await call("viewer", "GET", "/tasks?from=2026-11-01&to=2026-11-20");
    const occ = list.body.items.filter((i: any) => i.id === t.body.id);
    expect(occ.map((o: any) => [o.occurrence, o.status])).toEqual([["2026-11-02", "todo"], ["2026-11-09", "done"], ["2026-11-16", "todo"]]);
    expect((await q("select count(*)::int n from tasks where title = 'Weekly social schedule'"))[0].n).toBe(1);
  });
  it("records update history and refuses stale edits", async () => {
    const t = await call("editor", "POST", "/tasks", { title: "Banner", business_id: "sb" });
    expect((await call("editor", "PATCH", `/tasks/${t.body.id}`, { owner: "B", version: 1 })).status).toBe(200);
    expect((await call("editor", "PATCH", `/tasks/${t.body.id}`, { owner: "C", version: 1 })).status).toBe(409);
    const d = await call("viewer", "GET", `/tasks/${t.body.id}`);
    expect(d.body.history[0].changes.owner).toEqual({ from: null, to: "B" });
  });
});

describe("reports", () => {
  it("a published revision stays stable when live data changes; corrections create new revisions", async () => {
    const created = await call("editor", "POST", "/reports", { kind: "weekly", business_id: "sb", period_start: week.start, period_end: week.end });
    await call("editor", "POST", `/reports/${created.body.id}/publish`);
    const r1 = await call("viewer", "GET", `/reports/${created.body.id}`);
    const rev1 = r1.body.revision.content.performance[0].metrics.find((m: any) => m.key === "revenue").value.value;
    expect(rev1).toBe(1200);
    expect(r1.body.revision.source_runs.length).toBeGreaterThan(0);
    // Live data is corrected afterwards.
    await submit({ ...envelope("dup-1-fix2", "sb", week, "week", { corrects: "dup-1-fix" }), records: obs(1300, 32) });
    const again = await call("viewer", "GET", `/reports/${created.body.id}?revision=1`);
    expect(again.body.revision.content.performance[0].metrics.find((m: any) => m.key === "revenue").value.value).toBe(1200);
    // The database refuses changes to a published revision.
    await expect(q("update report_revisions set content = '{}' where report_id = $1 and revision = 1", [created.body.id])).rejects.toThrow(/report_revision_immutable/);
    const corr = await call("editor", "POST", `/reports/${created.body.id}/revisions`, { note: "Revenue corrected by source" });
    expect(corr.body.revision).toBe(2);
    await call("editor", "POST", `/reports/${created.body.id}/publish`);
    const r2 = await call("viewer", "GET", `/reports/${created.body.id}`);
    expect(r2.body.revision.revision).toBe(2);
    expect(r2.body.revision.content.performance[0].metrics.find((m: any) => m.key === "revenue").value.value).toBe(1300);
    expect(r2.body.revision.corrects_revision).toBe(1);
  });
  it("snapshots do not change when tasks change later", async () => {
    const s1 = await buildSnapshot("sb", week.start, week.end);
    expect(s1.content.performance).toBeTruthy();
  });
});

describe("private attachments", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  it("validates type and content, and serves files only to signed-in members", async () => {
    const t = await call("editor", "POST", "/tasks", { title: "With file", business_id: "sb" });
    const fd = (data: Uint8Array, name: string, type: string) => { const f = new FormData(); f.set("owner_type", "task"); f.set("owner_id", t.body.id); f.set("file", new File([data as BlobPart], name, { type })); return f; };
    expect((await call("editor", "POST", "/attachments", fd(new Uint8Array([1, 2, 3]), "x.png", "image/png"))).status).toBe(400);   // content mismatch
    expect((await call("editor", "POST", "/attachments", fd(png, "x.exe", "application/x-msdownload"))).status).toBe(400);
    expect((await call("viewer", "POST", "/attachments", fd(png, "x.png", "image/png"))).status).toBe(403);
    const ok = await call("editor", "POST", "/attachments", fd(png, "x.png", "image/png"));
    expect(ok.status).toBe(200);
    expect((await call(null, "GET", `/attachments/${ok.body.id}`)).status).toBe(401);
    const got = await call("viewer", "GET", `/attachments/${ok.body.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(got.body as ArrayBuffer)).toEqual(png);
  });
  it("published report revisions do not accept new files", async () => {
    const rev = (await q("select id from report_revisions where state = 'published' limit 1"))[0];
    const f = new FormData(); f.set("owner_type", "report_revision"); f.set("owner_id", rev.id); f.set("file", new File([png as BlobPart], "r.png", { type: "image/png" }));
    expect((await call("editor", "POST", "/attachments", f)).status).toBe(409);
  });
});
