// Regression tests for the review findings: integration isolation, report periods, vendor/product honesty.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, submit, q, closePool } from "./helpers";
import { envelope, weekRange, listingCheck } from "./fixtures/synthetic";

beforeAll(async () => {
  process.env.EXCLUDED_BRANDS = "";
  process.env.TRACKED_CHANNELS = "online_store:Online store";
  await freshDb();
});
afterAll(closePool);

const w = weekRange(0), w1 = weekRange(1), w2 = weekRange(2);
const rev = (v: number) => ({ observations: [{ metric: "revenue", value: v }] });
const activeRevenue = async (period: { start: string }) =>
  (await q("select value::float8 v from observations where status = 'active' and metric_key = 'revenue' and scope_key = 'all' and period_start = $1", [period.start])).map((r: any) => r.v);

describe("integrations cannot alter each other's data", () => {
  let tokenA: string, tokenB: string, tokenP2s: string;
  const post = (token: string, body: unknown) => call(null, "POST", "/submissions", body, { authorization: `Bearer ${token}` });
  beforeAll(async () => {
    const mk = async (label: string, businesses: string[]) => (await call("admin", "POST", "/settings/automation-clients", { label, sources: ["weekly_report", "etsy_listing_check"], businesses })).body.token as string;
    tokenA = await mk("Integration A", ["sb", "p2s"]);
    tokenB = await mk("Integration B", ["sb", "p2s"]);
    tokenP2s = await mk("P2S only", ["p2s"]);
    expect((await post(tokenA, { ...envelope("weekly-1", "sb", w), records: rev(1000) })).status).toBe(201);
  });

  it("another integration cannot correct a submission it did not send", async () => {
    const r = await post(tokenB, { ...envelope("weekly-1-fix", "sb", w, "week", { corrects: "weekly-1" }), records: rev(1) });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/No accepted submission weekly-1 from this integration/);
    expect(await activeRevenue(w)).toEqual([1000]);
  });

  it("reusing another integration's submission id is not treated as its duplicate and cannot replace its figures", async () => {
    const r = await post(tokenB, { ...envelope("weekly-1", "sb", w), records: rev(5) });
    expect(r.body.outcome).toBe("rejected");
    expect(r.body.message).toMatch(/cannot be replaced/);
    expect(await activeRevenue(w)).toEqual([1000]);
    // An identical resend by the owner is still recognised as its own duplicate.
    expect((await post(tokenA, { ...envelope("weekly-1", "sb", w), records: rev(1000) })).body.outcome).toBe("unchanged");
  });

  it("a correction cannot cross businesses, even for the same integration", async () => {
    const r = await post(tokenA, { ...envelope("weekly-1-p2s-fix", "p2s", w, "week", { corrects: "weekly-1" }), records: rev(2) });
    expect(r.body.outcome).toBe("rejected");
    expect(await activeRevenue(w)).toEqual([1000]);
  });

  it("a token limited to one business cannot submit for another", async () => {
    expect((await post(tokenP2s, { ...envelope("weekly-1-fix", "sb", w, "week", { corrects: "weekly-1" }), records: rev(3) })).status).toBe(403);
  });

  it("the owner can still correct its own submission", async () => {
    const r = await post(tokenA, { ...envelope("weekly-1-fix", "sb", w, "week", { corrects: "weekly-1" }), records: rev(1100) });
    expect(r.body).toMatchObject({ outcome: "accepted", revision: 2 });
    expect(await activeRevenue(w)).toEqual([1100]);
  });

  it("attachments can only be added to the token's own submissions", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const form = () => { const f = new FormData(); f.set("file", new File([png as BlobPart], "r.png", { type: "image/png" })); return f; };
    const path = "/submissions/weekly-1-fix/attachments?business=sb&source=weekly_report";
    expect((await call(null, "POST", path, form(), { authorization: `Bearer ${tokenB}` })).status).toBe(404);
    expect((await call(null, "POST", path, form(), { authorization: `Bearer ${tokenP2s}` })).status).toBe(403);
    expect((await call(null, "POST", path, form(), { authorization: `Bearer ${tokenA}` })).status).toBe(201);
  });

  it("a listing check from another integration cannot supersede findings it did not submit", async () => {
    const lrA = listingCheck("iso-check-a", "2026-10-26");
    expect((await post(tokenA, { ...envelope("listing-check:iso-check-a", "p2s", { start: lrA.window_start, end: lrA.window_end }, "rolling_30"), source: "etsy_listing_check", records: { listing_review: lrA } })).status).toBe(201);
    const lrB = { ...listingCheck("iso-check-b", "2026-11-02"), corrections: [{ supersedes_run_id: "iso-check-a", supersedes_finding_key: "f-price", reason: "hostile" }] };
    const r = await post(tokenB, { ...envelope("listing-check:iso-check-b", "p2s", { start: lrB.window_start, end: lrB.window_end }, "rolling_30"), source: "etsy_listing_check", records: { listing_review: lrB } });
    expect(r.body.outcome).toBe("rejected");
    expect((await q("select state from findings where run_id = 'iso-check-a' and finding_key = 'f-price'"))[0].state).toBe("active");
    expect((await q("select count(*)::int n from listing_review_runs where run_id = 'iso-check-b'"))[0].n).toBe(0);
  });
});

describe("reports contain only their own period", () => {
  let weekly: any, monthly: any;
  beforeAll(async () => {
    // Activities before, inside and after the historical week w1.
    for (const [id, p, name] of [["act-early", w2, "Early activity"], ["act-in", w1, "In-period activity"], ["act-late", w, "Later activity"]] as const)
      expect((await submit({ ...envelope(id, "sb", p), source: "activities", records: { activities: [{ type: "social", name, count: 1, count_unit: "posts" }] } })).outcome).toBe("accepted");
    const promo = async (title: string, s: string, e: string) => q("insert into promotions (business_id, year, kind, title, start_date, end_date, created_by) values ('sb', 2026, 'promotion', $1, $2, $3, 't')", [title, s, e]);
    await promo("Ended before", "2026-09-01", "2026-10-10");
    await promo("Overlaps week start", "2026-10-10", "2026-10-18");
    await promo("Inside week", "2026-10-19", "2026-10-20");
    await promo("Starts after week", "2026-10-24", "2026-11-05");
    await promo("Far future", "2026-12-20", "2026-12-31");
    weekly = await call("editor", "POST", "/reports", { kind: "weekly", business_id: "sb", period_start: w1.start, period_end: w1.end });
    monthly = await call("editor", "POST", "/reports", { kind: "monthly", business_id: "sb", period_start: "2026-09-01", period_end: "2026-09-30" });
  });

  it("a historical weekly report excludes earlier and later activities and promotions", async () => {
    const c = (await call("viewer", "GET", `/reports/${weekly.body.id}`)).body.revision.content;
    expect(c.activities.map((a: any) => a.name)).toEqual(["In-period activity"]);
    expect(c.promotions.current.map((p: any) => p.title).sort()).toEqual(["Inside week", "Overlaps week start"]);
    expect(c.promotions.upcoming).toEqual([]);
  });

  it("a historical monthly report uses its month only", async () => {
    const c = (await call("viewer", "GET", `/reports/${monthly.body.id}`)).body.revision.content;
    expect(c.activities).toEqual([]);   // all test activities are in October
    expect(c.promotions.current.map((p: any) => p.title)).toEqual(["Ended before"]);
  });
});

describe("vendor and product results do not mislead", () => {
  let d: any;
  beforeAll(async () => {
    const prod = (id: string, title: string, vendor: string, revenue: number, cost_state: string, gross_profit: number | null) =>
      ({ external_id: id, title, vendor, category: "Demo", channel_scope: "channel:online_store", revenue, units: 1, gross_profit, cost_state });
    expect((await submit({ ...envelope("vp-prior", "sb", w2), source: "products", records: { products: [
      prod("a", "Steady A", "Vendor One (demo)", 100, "complete", 50), prod("b", "Stopped B", "Vendor One (demo)", 80, "complete", 30),
      prod("c", "Only seller C", "Vendor Two (demo)", 60, "complete", 20),
    ] } })).outcome).toBe("accepted");
    expect((await submit({ ...envelope("vp-cur", "sb", w1), source: "products", records: { products: [
      prod("a", "Steady A", "Vendor One (demo)", 120, "complete", 60), prod("p", "Partial P", "Vendor One (demo)", 200, "partial", 150),
    ] } })).outcome).toBe("accepted");
    d = (await call("viewer", "GET", `/business/sb/vendors?start=${w1.start}&end=${w1.end}&compare=previous_period`)).body;
  });

  it("partial costs are labelled incomplete and are not ranked as profit leaders", () => {
    const p = d.products.find((x: any) => x.title === "Partial P");
    expect(p.grossProfit.state).toBe("incomplete");
    expect(p.margin.state).toBe("incomplete");
    expect(d.profitLeaders.map((x: any) => x.title)).toEqual(["Steady A"]);
    expect(d.costCoverage).toMatchObject({ partialCost: 1, missingCost: 0 });
    const v1 = d.vendors.find((v: any) => v.name === "Vendor One (demo)");
    expect(v1.grossProfit.state).toBe("incomplete");
    expect(v1.margin).toMatchObject({ state: "incomplete", note: "Covers products with known costs only" });
    expect(v1.missingCostProducts).toBe(1);
  });

  it("products whose sales fell to zero appear in the declining list", () => {
    expect(d.declining.map((x: any) => [x.title, x.change.absolute, x.dropped])).toEqual([["Stopped B", -80, true], ["Only seller C", -60, true]]);
    expect(d.revenueLeaders.map((x: any) => x.title)).not.toContain("Stopped B");
  });

  it("a vendor with no sales now still shows its decline", () => {
    const v2 = d.vendors.find((v: any) => v.name === "Vendor Two (demo)");
    expect(v2.revenue.value).toBe(0);
    expect(v2.change).toMatchObject({ absolute: -60, percent: -100 });
    expect(v2.droppedProducts).toBe(1);
    expect(v2.margin.state).toBe("not_applicable");
  });

  it("without comparison data, nothing is reported as dropped", async () => {
    const r = (await call("viewer", "GET", `/business/sb/vendors?start=${w2.start}&end=${w2.end}&compare=previous_period`)).body;
    expect(r.declining).toEqual([]);
    expect(r.products.some((x: any) => x.dropped)).toBe(false);
  });
});

describe("record identities are owned by the integration that reported them", () => {
  const prod = (title: string, vendor: string) => ({ products: [{ external_id: "shared-ext-1", title, vendor, category: "Cat " + title, url: "https://example.com/" + encodeURIComponent(title),
    channel_scope: "channel:online_store", revenue: 10, units: 1, gross_profit: null, cost_state: "missing" }] });
  const products = async () => (await q(
    `select p.title, p.business_id, p.category, p.url, v.name as vendor, s.submitter, s.submission_source from product_source_ids s
       join products p on p.id = s.product_id left join vendors v on v.id = p.vendor_id where s.external_id = 'shared-ext-1' order by p.title`));
  const camp = (name: string) => ({ campaigns: [{ platform: "google", external_id: "shared-camp-1", name, spend: 5, acquisitions: 1, conversion_value: 9, status: "Active", status_observed_at: "2026-10-30T00:00:00Z" }] });
  const dates = [weekRange(5), weekRange(6), weekRange(7), weekRange(8)];

  it("the same product id from another integration, business or source never changes the original product", async () => {
    expect((await submit({ ...envelope("own-p-a", "sb", dates[0]), source: "products", records: prod("Original A", "Vendor A (demo)") }, "submission.api", "client:A")).outcome).toBe("accepted");
    expect((await submit({ ...envelope("own-p-b", "sb", dates[1]), source: "products", records: prod("Hostile B", "Vendor B (demo)") }, "submission.api", "client:B")).outcome).toBe("accepted");
    expect((await submit({ ...envelope("own-p-c", "p2s", dates[2]), source: "products", records: prod("Other business", "Vendor C (demo)") }, "submission.api", "client:A")).outcome).toBe("accepted");
    expect((await submit({ ...envelope("own-p-d", "sb", dates[3]), source: "products_v2", records: prod("Other source", "Vendor D (demo)") }, "submission.api", "client:A")).outcome).toBe("accepted");
    const rows = await products();
    expect(rows).toHaveLength(4);
    const a = rows.find((r: any) => r.submitter === "client:A" && r.business_id === "sb" && r.submission_source === "products");
    expect(a).toMatchObject({ title: "Original A", vendor: "Vendor A (demo)", category: "Cat Original A", url: "https://example.com/Original%20A" });
  });

  it("the owner can still update its own product", async () => {
    expect((await submit({ ...envelope("own-p-a2", "sb", weekRange(9)), source: "products", records: prod("Renamed A", "Vendor A (demo)") }, "submission.api", "client:A")).outcome).toBe("accepted");
    const a = (await products()).find((r: any) => r.submitter === "client:A" && r.business_id === "sb" && r.submission_source === "products");
    expect(a.title).toBe("Renamed A");
    expect((await products())).toHaveLength(4);
  });

  it("the same campaign id from another integration does not rename the original campaign", async () => {
    expect((await submit({ ...envelope("own-c-a", "sb", dates[0]), source: "ads", records: camp("Original campaign") }, "submission.api", "client:A")).outcome).toBe("accepted");
    expect((await submit({ ...envelope("own-c-b", "sb", dates[1]), source: "ads", records: camp("Hostile rename") }, "submission.api", "client:B")).outcome).toBe("accepted");
    const rows = await q("select name, submitter from ad_campaigns where external_id = 'shared-camp-1' order by submitter");
    expect(rows).toEqual([{ name: "Original campaign", submitter: "client:A" }, { name: "Hostile rename", submitter: "client:B" }]);
  });

  it("listing-finding corrections require the same source, even from the same integration", async () => {
    const env = (id: string, lr: any, source: string) => ({ ...envelope(id, "p2s", { start: lr.window_start, end: lr.window_end }, "rolling_30"), source, records: { listing_review: lr } });
    const lr1 = listingCheck("own-check-1", "2026-10-26");
    expect((await submit(env("listing-check:own-check-1", lr1, "etsy_listing_check"), "submission.api", "client:A")).outcome).toBe("accepted");
    const other = { ...listingCheck("own-check-2", "2026-11-02"), corrections: [{ supersedes_run_id: "own-check-1", supersedes_finding_key: "f-price", reason: "different source" }] };
    const r = await submit(env("listing-check:own-check-2", other, "another_check"), "submission.api", "client:A");
    expect(r.outcome).toBe("rejected");
    expect((await q("select state from findings where run_id = 'own-check-1' and finding_key = 'f-price'"))[0].state).toBe("active");
    const same = { ...listingCheck("own-check-3", "2026-11-02"), corrections: [{ supersedes_run_id: "own-check-1", supersedes_finding_key: "f-price", reason: "same source" }] };
    expect((await submit(env("listing-check:own-check-3", same, "etsy_listing_check"), "submission.api", "client:A")).outcome).toBe("accepted");
    expect((await q("select state from findings where run_id = 'own-check-1' and finding_key = 'f-price'"))[0].state).toBe("superseded");
  });

  it("decisions in an intake spreadsheet only apply to that spreadsheet's own checks", async () => {
    const { runSheetSync } = await import("../server/sheetSync");
    const sheet = (await q("insert into sheet_sources (business_id, role, label, file_id, file_kind, created_by) values ('p2s', 'intake', 'Intake demo', 'FAKEintakeFILEid000000000001', 'google_sheet', 't') returning id"))[0].id;
    const res = await runSheetSync(sheet, "manual", "t", async () => [
      { name: "Action decisions", rows: [["run_id", "finding_key", "decision", "decided_by"], ["own-check-1", "f-proof", "approved", "sheet user"]] },
    ]);
    expect(res.outcome).toBe("succeeded");
    expect((await q("select count(*)::int n from action_decisions d join findings f on f.id = d.finding_id where f.run_id = 'own-check-1' and f.finding_key = 'f-proof'"))[0].n).toBe(0);
  });
});
