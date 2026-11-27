// Vendor profit from Gross Profit days (synthetic API responses and data only): exact Saturday–Friday ranges built
// from two Monday–Sunday GP weeks, gaps, missing costs, provisional weeks, name matching and the Vendors table.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, q, closePool } from "./helpers";
import { query, one } from "../server/db";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { pullGrossProfit, weekToSubmission, vendorSlug, vendorDayObservations } from "../server/adapters/grossProfit";
import { vendorProfitFrom, VendorProfitRow } from "../server/vendorProfit";
import { productsAndVendors } from "../server/routes/dashboard";

const GP_URL = "https://gp.example.test";
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const v = (vendor: string, gp: number, basis: number, missingRev = 0) =>
  ({ vendor, units: 1, known_cost_revenue: basis, known_product_cost: basis - gp, known_cost_gp: gp, missing_cost_revenue: missingRev, missing_cost_lines: missingRev ? 1 : 0 });
// A GP week whose seven days each carry the given vendors (days add up to the week, as the pull requires).
function gpWeek(week: string, vendorsFor: (date: string) => any[] | undefined, over: any = {}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i)).map((date) => {
    const vs = vendorsFor(date);
    return { date, gross_profit: 10, gross_profit_revenue_basis: 40, product_cost: 20, shipping_cost: 10, ...(vs ? { vendors: vs } : {}) };
  });
  return {
    id: `gp:week:${week}`, snapshot_id: `snp_${"0".repeat(19)}${over.revision ?? 1}`, revision: 1,
    period: { start: week, end: addDays(week, 6), week_start: week, granularity: "week", timezone: "America/Los_Angeles" },
    completeness: "complete", completeness_reasons: [], computed_at: "2026-11-24T00:00:00Z", published_at: "2026-11-24T01:00:00Z",
    totals: { gross_profit: 70, gross_profit_revenue_basis: 280, product_cost: 140, shipping_cost: 70 }, days, ...over,
  };
}
const lines = (d: string, n: number, slug = "storea") => ({ metric_key: "vendor_missing_cost_lines", scope_key: `gp_vendor:${slug}`, scope_label: null, d, value: n, completeness: "complete" });
const row = (metric_key: string, scope_key: string, d: string, value: number, completeness = "complete", scope_label: string | null = null): VendorProfitRow =>
  ({ metric_key, scope_key, scope_label, d, value, completeness });

describe("vendor names", () => {
  it("match across spacing, case, punctuation and a trailing (…)", () => {
    expect(vendorSlug("Fern Hollow Shop")).toBe(vendorSlug("FernHollow shop"));
    expect(vendorSlug("North Nursery (12345)")).toBe(vendorSlug("North Nursery"));
    expect(vendorSlug("Bloom and Co")).toBe(vendorSlug("Bloom And Co"));
    expect(vendorSlug("Store A")).not.toBe(vendorSlug("Store B"));
  });
});

describe("vendorProfitFrom (pure)", () => {
  const week = { start: "2026-11-14", end: "2026-11-20" };          // Saturday–Friday
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.start, i));
  const covered = (ds: string[], completeness = "complete") => ds.map((d) => row("vendor_breakdown_vendors", "gp_vendors", d, 1, completeness));
  const store = (d: string, gp: number, basis: number, miss = 0, slug = "storea") => [
    row("vendor_product_gp", `gp_vendor:${slug}`, d, gp), row("vendor_product_gp_revenue_basis", `gp_vendor:${slug}`, d, basis),
    row("vendor_missing_cost_revenue", `gp_vendor:${slug}`, d, miss)];

  it("adds up every day of a Saturday–Friday range; margin on Gross Profit's own revenue basis", () => {
    const rows = [...covered(days), ...days.flatMap((d) => store(d, 10, 40))];
    const r = vendorProfitFrom(week, rows);
    expect(r.covered).toBe(true);
    const p = r.profitFor("Store A");
    expect(p.grossProfit).toMatchObject({ state: "value", value: 70 });
    expect(p.margin.value).toBeCloseTo(0.25, 9);
    expect(p.note).toMatch(/before shipping/);
  });
  it("a day without a published vendor breakdown: Missing for every vendor, naming the dates; nothing prorated", () => {
    const rows = [...covered(days.slice(2)), ...days.flatMap((d) => store(d, 10, 40))];
    const r = vendorProfitFrom(week, rows);
    expect(r.covered).toBe(false);
    expect(r.gaps).toEqual(["2026-11-14", "2026-11-15"]);
    expect(r.note).toMatch(/Nov 14 to 15, 2026/);
    const p = r.profitFor("Store A");
    expect(p.grossProfit.state).toBe("missing");
    expect(p.grossProfit.value).toBeNull();
  });
  it("missing costs or a provisional week make it incomplete, with the reason", () => {
    const miss = vendorProfitFrom(week, [...covered(days), ...days.flatMap((d) => store(d, 10, 40, d === "2026-11-16" ? 25 : 0))]).profitFor("Store A");
    expect(miss.grossProfit).toMatchObject({ state: "incomplete", value: 70 });
    expect(miss.grossProfit.note).toMatch(/cost missing on 0 lines \(\$25\.00/);
    expect(miss.margin.state).toBe("incomplete");
    const prov = vendorProfitFrom(week, [...covered(days, "provisional"), ...days.flatMap((d) => store(d, 10, 40))]).profitFor("Store A");
    expect(prov.grossProfit.state).toBe("incomplete");
    expect(prov.grossProfit.note).toMatch(/provisional/);
  });
  it("a missing-cost line keeps profit and margin incomplete even when its revenue is $0 or negative", () => {
    const zero = vendorProfitFrom(week, [...covered(days), ...days.flatMap((d) => store(d, 10, 40)), lines("2026-11-17", 1)]).profitFor("Store A");
    expect(zero.grossProfit).toMatchObject({ state: "incomplete", value: 70 });
    expect(zero.grossProfit.note).toMatch(/cost missing on 1 line \(\$0\.00/);
    expect(zero.margin.state).toBe("incomplete");
    expect(zero.margin.value).toBeCloseTo(0.25, 9);
    const neg = vendorProfitFrom(week, [...covered(days), ...days.flatMap((d) => store(d, 10, 40, d === "2026-11-18" ? -12 : 0)), lines("2026-11-18", 2)]).profitFor("Store A");
    expect(neg.grossProfit.state).toBe("incomplete");
    expect(neg.grossProfit.note).toMatch(/2 lines \(-\$12\.00 of product revenue/);
    expect(neg.margin.state).toBe("incomplete");
    const none = vendorProfitFrom(week, [...covered(days), ...days.flatMap((d) => store(d, 10, 40)), lines("2026-11-18", 0)]).profitFor("Store A");
    expect(none.grossProfit.state).toBe("value");
    expect(none.margin.state).toBe("value");
  });
  it("a vendor absent from Gross Profit is Missing, not zero; days outside the range are ignored", () => {
    const rows = [...covered(days), ...days.flatMap((d) => store(d, 10, 40)), ...store("2026-11-21", 999, 999)];
    const r = vendorProfitFrom(week, rows);
    expect(r.profitFor("Store A").grossProfit.value).toBe(70);
    const other = r.profitFor("Another Vendor");
    expect(other.grossProfit.state).toBe("missing");
    expect(other.note).toMatch(/no product sales under this vendor name/);
  });
  it("a reported $0 profit is a value, not missing", () => {
    const p = vendorProfitFrom(week, [...covered(days), ...days.flatMap((d) => store(d, 0, 10))]).profitFor("Store A");
    expect(p.grossProfit).toMatchObject({ state: "value", value: 0 });
    expect(p.margin).toMatchObject({ state: "value", value: 0 });
  });
});

describe("Gross Profit submission", () => {
  it("adds one coverage marker per day and the vendors' figures, merging names with the same slug", () => {
    const obs = vendorDayObservations({ date: "2026-11-16", vendors: [v("Bloom and Co", 5, 20, 3), v("Bloom And Co", 1, 4), v("Store B", 2, 8)] });
    const get = (m: string, s: string) => obs.find((o) => o.metric === m && o.scope === s)?.value;
    expect(get("vendor_breakdown_vendors", "gp_vendors")).toBe(2);
    expect(get("vendor_product_gp", "gp_vendor:bloomandco")).toBe(6);
    expect(get("vendor_product_gp_revenue_basis", "gp_vendor:bloomandco")).toBe(24);
    expect(get("vendor_missing_cost_revenue", "gp_vendor:bloomandco")).toBe(3);
    expect(get("vendor_missing_cost_lines", "gp_vendor:bloomandco")).toBe(1);
    const zeroRev = vendorDayObservations({ date: "2026-11-16", vendors: [{ ...v("Store A", 5, 20), missing_cost_lines: 2, missing_cost_revenue: 0 }] });
    expect(zeroRev.find((o) => o.metric === "vendor_missing_cost_lines")?.value).toBe(2);
    expect(obs.every((o) => o.granularity === "day" && o.period_start === "2026-11-16")).toBe(true);
  });
  it("vendor figures only when every usable day carries them; the submission id marks it", () => {
    const all = weekToSubmission(gpWeek("2026-11-16", () => [v("Store A", 10, 40)]) as any);
    expect(all.submission_id).toBe("gp:2026-11-16:r1dv");
    expect(all.records.observations.filter((o: any) => o.metric === "vendor_breakdown_vendors")).toHaveLength(7);
    const some = weekToSubmission(gpWeek("2026-11-16", (d) => (d === "2026-11-18" ? undefined : [v("Store A", 10, 40)])) as any);
    expect(some.submission_id).toBe("gp:2026-11-16:r1d");
    expect(some.records.observations.some((o: any) => o.metric.startsWith("vendor_"))).toBe(false);
    const empty = weekToSubmission(gpWeek("2026-11-16", () => []) as any);   // no product sales: covered, zero vendors
    expect(empty.records.observations.filter((o: any) => o.metric === "vendor_breakdown_vendors").map((o: any) => o.value)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("Vendors table on a real database", () => {
  let weeks: any[] = [];
  beforeAll(async () => {
    await freshDb();
    process.env.GROSS_PROFIT_API_URL = GP_URL;
    process.env.GROSS_PROFIT_REPORTING_SECRET = "g".repeat(40);
    _setReportingFetchForTests((async (u: any) => String(u).startsWith(`${GP_URL}/v1/reporting/weeks`)
      ? new Response(JSON.stringify({ ok: true, schema_version: 1, weeks, next_cursor: null }), { status: 200 })
      : new Response("not found", { status: 404 })) as any);
    // Product report for Saturday–Friday Nov 14–20 (no costs, as the Plant Breakdown reports send).
    const run = await one<any>(`insert into import_runs (source_id, business_id, submission_id, submitter, submission_source, schema_version, content_hash, outcome, period_start, period_end, actor)
      values ('pull.plant_breakdown', 'sb', 'test:w', 'pull:test', 'test', 1, 'h', 'accepted', '2026-11-14', '2026-11-20', 'test') returning id`);
    for (const [name, title, rev] of [["Store A", "Plant one", 300], ["FernHollow shop", "Fern plant", 120], ["Unmatched Vendor", "Other plant", 50]] as const) {
      const vd = await one<any>(`insert into vendors (business_id, name) values ('sb', $1) returning id`, [name]);
      const p = await one<any>(`insert into products (business_id, title, vendor_id, category) values ('sb', $1, $2, 'Plant') returning id`, [title, vd.id]);
      await query(`insert into product_observations (import_run_id, product_id, business_id, channel_scope, period_start, period_end, granularity, timezone, revenue, units, orders, cost_state, completeness)
        values ($1, $2, 'sb', 'channel:shopify_report', '2026-11-14', '2026-11-20', 'custom', 'America/Los_Angeles', $3, 3, null, 'missing', 'complete')`, [run.id, p.id, rev]);
    }
  });
  afterAll(async () => { _setReportingFetchForTests(null as any); await closePool(); });

  const vendorsFor = (date: string) => [v("Store A", 10, 40, date === "2026-11-19" ? 6 : 0), v("Fern Hollow Shop", 3, 12)];
  it("only the second GP week published: the Saturday and Sunday are missing, so profit is withheld", async () => {
    weeks = [gpWeek("2026-11-16", vendorsFor)];
    await pullGrossProfit();
    const r: any = await productsAndVendors("sb", { start: "2026-11-14", end: "2026-11-20" }, null);
    expect(r.vendorProfit.covered).toBe(false);
    expect(r.vendorProfit.note).toMatch(/Nov 14 to 15, 2026/);
    expect(r.vendors.every((x: any) => x.grossProfit.value === null)).toBe(true);
  });
  it("both GP weeks published: Saturday–Friday adds the right days from each week", async () => {
    weeks = [gpWeek("2026-11-09", vendorsFor), gpWeek("2026-11-16", vendorsFor)];
    await pullGrossProfit();
    const r: any = await productsAndVendors("sb", { start: "2026-11-14", end: "2026-11-20" }, null);
    expect(r.vendorProfit.covered).toBe(true);
    const by = Object.fromEntries(r.vendors.map((x: any) => [x.name, x]));
    expect(by["Store A"].grossProfit).toMatchObject({ state: "incomplete", value: 70 });       // 7 days × 10; Nov 19 has a missing cost
    expect(by["Store A"].grossProfit.note).toMatch(/cost missing on 1 line \(\$6\.00/);
    expect(by["Store A"].margin.state).toBe("incomplete");
    expect(by["Store A"].profitSource).toBe("gross_profit");
    expect(by["FernHollow shop"].grossProfit).toMatchObject({ state: "value", value: 21 });        // matched to "Fern Hollow Shop"
    expect(by["FernHollow shop"].margin.value).toBeCloseTo(21 / 84, 9);
    expect(by["Unmatched Vendor"].grossProfit.state).toBe("missing");
    expect(by["Unmatched Vendor"].profitNote).toMatch(/no product sales under this vendor name/);
    // Revenue still comes from the product report; GP's basis never replaces it.
    expect(by["Store A"].revenue).toMatchObject({ state: "value", value: 300 });
    // Week totals are unchanged by the vendor figures.
    const n = (await q("select count(*)::int n from observations where source_id = 'pull.gross_profit' and metric_key = 'gross_profit' and granularity = 'day' and status = 'active'"))[0].n;
    expect(n).toBe(14);
  });
  it("a vendor whose only missing-cost line has $0 revenue is incomplete (the line count is kept)", async () => {
    weeks = [gpWeek("2026-11-09", vendorsFor), gpWeek("2026-11-16", (d) => d === "2026-11-17"
      ? [v("Store A", 10, 40), { ...v("Fern Hollow Shop", 3, 12), missing_cost_lines: 1, missing_cost_revenue: 0 }] : vendorsFor(d), { revision: 2 })];
    await pullGrossProfit();
    const r: any = await productsAndVendors("sb", { start: "2026-11-14", end: "2026-11-20" }, null);
    const air = r.vendors.find((x: any) => x.name === "FernHollow shop");
    expect(air.grossProfit).toMatchObject({ state: "incomplete", value: 21 });
    expect(air.margin.state).toBe("incomplete");
    expect(air.grossProfit.note).toMatch(/1 line \(\$0\.00/);
  });
  it("channel and category filters withhold profit and margin with the reason; a vendor filter keeps them", async () => {
    const range = { start: "2026-11-14", end: "2026-11-20" };
    for (const f of [{ channel: "channel:shopify_report" }, { category: "Plant" }]) {
      const r: any = await productsAndVendors("sb", range, null, f);
      expect(r.vendorProfit.withheld).toBe(true);
      expect(r.vendorProfit.note).toMatch(f.channel ? /by channel/ : /by category/);
      expect(r.vendors.length).toBeGreaterThan(0);
      expect(r.vendors.every((x: any) => x.grossProfit.value === null && x.margin.value === null && x.profitSource === null)).toBe(true);
    }
    const vid = (await q("select id from vendors where name = 'Store A'"))[0].id;
    const one: any = await productsAndVendors("sb", range, null, { vendor: String(vid) });
    expect(one.vendorProfit.withheld).toBe(false);
    expect(one.vendors[0].grossProfit.value).toBe(70);
  });
  it("profit is always for the SELECTED dates; with a nearest sales report both ranges are stated", async () => {
    // Mon–Sun Nov 16–22 has no sales report: sales fall back to Nov 14–20, profit stays Nov 16–22 (GP week of Nov 16).
    const r: any = await productsAndVendors("sb", { start: "2026-11-16", end: "2026-11-22" }, null);
    expect(r.exact).toBe(false);
    expect(r.period).toEqual({ start: "2026-11-14", end: "2026-11-20" });
    expect(r.vendorProfit.range).toEqual({ start: "2026-11-16", end: "2026-11-22" });
    expect(r.vendorProfit.salesRange).toEqual({ start: "2026-11-14", end: "2026-11-20" });
    expect(r.vendorProfit.datesNote).toMatch(/selected dates, Nov 16 to 22, 2026.*nearest saved sales report, Nov 14 to 20, 2026/);
    const a = r.vendors.find((x: any) => x.name === "Store A");
    expect(a.grossProfit.value).toBe(70);                        // Nov 16–22 from the GP week of Nov 16 (7 × 10)
    expect(a.profitNote).toMatch(/Gross Profit \(Nov 16 to 22, 2026\)/);
    // Selected dates with an exact sales report: no dates note.
    expect((await productsAndVendors("sb", { start: "2026-11-14", end: "2026-11-20" }, null) as any).vendorProfit.datesNote).toBeNull();
  });
});

// Sales reports WITH known product costs: the vendor columns must still never fall back to them.
describe("vendor GP columns never fall back to the sales reports' product costs", () => {
  let weeks: any[] = [];
  const W = { start: "2026-11-14", end: "2026-11-20" };
  beforeAll(async () => {
    await freshDb();
    process.env.GROSS_PROFIT_API_URL = GP_URL;
    process.env.GROSS_PROFIT_REPORTING_SECRET = "g".repeat(40);
    _setReportingFetchForTests((async (u: any) => String(u).startsWith(`${GP_URL}/v1/reporting/weeks`)
      ? new Response(JSON.stringify({ ok: true, schema_version: 1, weeks, next_cursor: null }), { status: 200 })
      : new Response("not found", { status: 404 })) as any);
    const run = await one<any>(`insert into import_runs (source_id, business_id, submission_id, submitter, submission_source, schema_version, content_hash, outcome, period_start, period_end, actor)
      values ('submission.api', 'sb', 'test:costs', 'test:a', 'test', 1, 'h', 'accepted', '2026-11-14', '2026-11-20', 'test') returning id`);
    const vd = await one<any>(`insert into vendors (business_id, name) values ('sb', 'Store A') returning id`);
    const p = await one<any>(`insert into products (business_id, title, vendor_id, category) values ('sb', 'Plant one', $1, 'Plant') returning id`, [vd.id]);
    // Known cost: product GP $120 on $300 (40%). Gross Profit's own figure for the week is $70 on $280.
    await query(`insert into product_observations (import_run_id, product_id, business_id, channel_scope, period_start, period_end, granularity, timezone, revenue, units, orders, gross_profit, cost_state, completeness)
      values ($1, $2, 'sb', 'channel:shopify_report', '2026-11-14', '2026-11-20', 'custom', 'America/Los_Angeles', 300, 3, 2, 120, 'complete', 'complete')`, [run.id, p.id]);
  });
  afterAll(async () => { _setReportingFetchForTests(null as any); await closePool(); });
  const storeA = (r: any) => r.vendors.find((x: any) => x.name === "Store A");
  const expectWithheld = (x: any) => {
    expect(x.grossProfit.value).toBeNull();
    expect(x.grossProfit.state).toBe("missing");
    expect(x.margin.value).toBeNull();
    expect(x.profitSource).toBeNull();
  };

  it("missing GP days: Missing, not the sales report's $120 / 40%", async () => {
    weeks = [gpWeek("2026-11-16", () => [v("Store A", 10, 40)])];               // Nov 14–15 not published
    await pullGrossProfit();
    const r: any = await productsAndVendors("sb", W, null);
    expect(r.vendorProfit.covered).toBe(false);
    expectWithheld(storeA(r));
    expect(storeA(r).profitNote).toMatch(/Nov 14 to 15, 2026/);
    // The product rows keep their own known cost (a product column, not the vendor GP column).
    expect(r.products.find((x: any) => x.title === "Plant one").grossProfit).toMatchObject({ state: "value", value: 120 });
  });
  it("covered: Gross Profit's $70, never the sales report's $120", async () => {
    weeks = [gpWeek("2026-11-09", () => [v("Store A", 10, 40)]), gpWeek("2026-11-16", () => [v("Store A", 10, 40)])];
    await pullGrossProfit();
    const a = storeA(await productsAndVendors("sb", W, null));
    expect(a.grossProfit).toMatchObject({ state: "value", value: 70 });
    expect(a.margin.value).toBeCloseTo(0.25, 9);
  });
  it("unsupported filters: Missing with the reason, not the sales report's figure", async () => {
    for (const f of [{ channel: "channel:shopify_report" }, { category: "Plant" }]) {
      const r: any = await productsAndVendors("sb", W, null, f);
      expect(r.vendorProfit.withheld).toBe(true);
      expectWithheld(storeA(r));
      expect(storeA(r).profitNote).toMatch(f.channel ? /by channel/ : /by category/);
    }
  });
  it("nearest-report fallback: profit for the selected dates from Gross Profit, or Missing; never the nearest report's costs", async () => {
    // Nov 16–22: no sales report, nearest is Nov 14–20 (with costs); GP week of Nov 16 covers every selected day.
    const covered: any = await productsAndVendors("sb", { start: "2026-11-16", end: "2026-11-22" }, null);
    expect(covered.exact).toBe(false);
    expect(storeA(covered).grossProfit).toMatchObject({ state: "value", value: 70 });
    // Nov 17–23: nearest is again Nov 14–20, but Nov 23 has no published GP day.
    const gap: any = await productsAndVendors("sb", { start: "2026-11-17", end: "2026-11-23" }, null);
    expect(gap.exact).toBe(false);
    expect(gap.vendorProfit.covered).toBe(false);
    expect(gap.vendorProfit.note).toMatch(/Nov 23, 2026/);
    expectWithheld(storeA(gap));
  });
});
