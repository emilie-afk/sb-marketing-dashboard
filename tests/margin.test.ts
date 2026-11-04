// Gross margin uses only the revenue basis sent with the gross profit, never business revenue.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, submit, q, closePool } from "./helpers";
import { envelope, weekRange } from "./fixtures/synthetic";
import { formatFig } from "../shared/metrics";

beforeAll(async () => {
  process.env.EXCLUDED_BRANDS = "";
  process.env.TRACKED_CHANNELS = "online_store:Online store";
  await freshDb();
});
afterAll(closePool);

const WEEKLY = "client:weekly-report", GP = "client:gross-profit", OTHER = "client:other";
const wk = (i: number) => weekRange(20 + i);
const revenue = (id: string, i: number, total: number, channel: number) => submit({ ...envelope(id, "sb", wk(i)), records: { observations: [
  { metric: "revenue", value: total }, { metric: "orders", value: 10 }, { metric: "revenue", scope: "channel:online_store", value: channel }] } }, "submission.api", WEEKLY);
const gp = (id: string, i: number, obs: any[], extra: Record<string, unknown> = {}, submitter = GP, source = "submission.api") =>
  submit({ ...envelope(id, "sb", wk(i), "week", extra), source: "gross_profit", records: { observations: obs } }, source, submitter);
const margin = async (i: number) => (await call("viewer", "GET", `/business/sb/profitability?start=${wk(i).start}&end=${wk(i).end}&compare=none`)).body.metrics.find((m: any) => m.key === "margin");
const metric = async (i: number, key: string, scope = "all") => {
  const r = await call("viewer", "GET", `/business/sb/summary?start=${wk(i).start}&end=${wk(i).end}&compare=none`);
  return key === "revenue" && scope === "all" ? r.body.metrics.find((m: any) => m.key === key) : null;
};

describe("gross margin uses the revenue basis sent with the gross profit", () => {
  beforeAll(async () => {
    for (let i = 0; i <= 13; i++) expect((await revenue(`rev-${i}`, i, 1000, 700)).outcome).toBe("accepted");
    const ok = (r: any) => expect(r.outcome).toBe("accepted");
    ok(await gp("gp-0", 0, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 800 }]));
    ok(await gp("gp-1", 1, [{ metric: "gross_profit", value: 200 }]));                                                  // no basis
    ok(await gp("gp-2", 2, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 0 }]));
    ok(await gp("gp-3", 3, [{ metric: "gross_profit", value: 200 }]));
    ok(await gp("gp-3-basis", 3, [{ metric: "gross_profit_revenue_basis", value: 800 }], {}, OTHER));                 // basis from another integration
    ok(await gp("gp-4", 4, [{ metric: "gross_profit", value: 200 }]));
    ok(await submit({ ...envelope("gp-4-basis", "sb", wk(4)), period: { ...wk(4), granularity: "week", timezone: "UTC" }, source: "gross_profit",
      records: { observations: [{ metric: "gross_profit_revenue_basis", value: 800 }] } }, "submission.api", GP));                // different timezone
    ok(await gp("gp-5", 5, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", scope: "channel:online_store", value: 800 }])); // other accounting scope
    ok(await gp("gp-6", 6, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 800 }], { completeness: "provisional" }));
    ok(await gp("gp-7", 7, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 800 }], { completeness: "incomplete" }));
    ok(await gp("gp-8", 8, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 800 }]));
    ok(await gp("gp-8-sheet", 8, [{ metric: "gross_profit", value: 300 }, { metric: "gross_profit_revenue_basis", value: 900 }], {}, "sheet:x", "sheet.intake")); // second integration
    ok(await gp("gp-9", 9, [{ metric: "gross_profit", value: 100 }, { metric: "gross_profit_revenue_basis", value: 400 }]));
    ok(await gp("gp-10", 10, [{ metric: "gross_profit", value: 300 }, { metric: "gross_profit_revenue_basis", value: 600 }]));
  });

  it("divides gross profit by its own revenue basis, not business revenue", async () => {
    const m = await margin(0);
    expect(m.value).toMatchObject({ state: "value", value: 0.25 });   // 200 / 800, not 200 / 1000
  });

  it("business revenue, channel revenue and revenue trends are unchanged by the revenue basis", async () => {
    expect((await metric(0, "revenue")).value.value).toBe(1000);
    const ov = (await call("viewer", "GET", `/overview?start=${wk(0).start}&end=${wk(0).end}&compare=none`)).body;
    expect(ov.sbChannels.total.revenue).toBe(1000);
    expect(ov.sbChannels.tracked.map((c: any) => c.revenue)).toEqual([700]);
    const t = ov.trends.find((x: any) => x.business === "sb" && x.key === "revenue");
    expect(t.points.every((p: any) => p.value.value === 1000)).toBe(true);
    expect(ov.trends.some((x: any) => x.key === "gross_profit_revenue_basis")).toBe(false);
    expect((await q("select count(*)::int n from observations where metric_key = 'revenue' and status = 'active'"))[0].n).toBe(28);
  });

  it.each([
    [1, /No revenue basis was sent in the same submission/],
    [2, /revenue basis is zero/],
    [3, /No revenue basis was sent in the same submission/],   // basis exists but from another integration
    [4, /No revenue basis was sent in the same submission/],   // separate submission by the same integration (also another timezone)
    [5, /No revenue basis was sent in the same submission/],   // basis for another accounting scope
    [8, /more than one integration/],
  ])("week %i: margin is unavailable with a reason and never falls back to business revenue", async (i, reason) => {
    const m = await margin(i);
    expect(m.value.state).toBe("missing");
    expect(m.value.value).toBeNull();
    expect(m.value.note).toMatch(reason);
    expect((await metric(i, "revenue")).value.value).toBe(1000);   // business revenue was available and not used
  });

  it("gross profit reported for the same week by two integrations is not added together", async () => {
    const r = await call("viewer", "GET", `/business/sb/profitability?start=${wk(8).start}&end=${wk(8).end}&compare=none`);
    const g = r.body.metrics.find((m: any) => m.key === "gross_profit");
    expect(g.value).toMatchObject({ state: "missing", note: "Reported by more than one source for the same period" });
  });

  it("keeps provisional and incomplete labels", async () => {
    const p = await margin(6);
    expect(p.value).toMatchObject({ state: "value", value: 0.25, flag: "provisional" });
    expect(formatFig(p.value, "percent")).toBe("25.00% (provisional)");
    const gpTile = (await call("viewer", "GET", `/business/sb/profitability?start=${wk(6).start}&end=${wk(6).end}&compare=none`)).body.metrics.find((m: any) => m.key === "gross_profit");
    expect(gpTile.value.flag).toBe("provisional");
    const inc = await margin(7);
    expect(inc.value).toMatchObject({ state: "incomplete", value: 0.25 });
    expect(formatFig(inc.value, "percent")).toBe("25.00% (incomplete)");
  });

  it("sums profit and basis across periods (weighted, not an average of margins)", async () => {
    const r = await call("viewer", "GET", `/business/sb/profitability?start=${wk(10).start}&end=${wk(9).end}&compare=none`);
    const m = r.body.metrics.find((x: any) => x.key === "margin");
    expect(m.value.value).toBeCloseTo(400 / 1000);   // (100 + 300) / (400 + 600), not (0.25 + 0.5) / 2
  });

  it("the margin trend uses the revenue basis per period", async () => {
    const r = await call("viewer", "GET", `/business/sb/profitability?start=${wk(9).start}&end=${wk(9).end}&compare=none`);
    const t = r.body.trends.find((x: any) => x.key === "margin");
    const byEnd = Object.fromEntries(t.points.map((p: any) => [p.end, p.value]));
    expect(byEnd[wk(9).end].value).toBeCloseTo(0.25);
    expect(byEnd[wk(10).end].value).toBeCloseTo(0.5);
    expect(byEnd[wk(1).end]?.state ?? "missing").toBe("missing");
  });

  it("compares margins in percentage points using each period's own basis", async () => {
    const r = await call("viewer", "GET", `/business/sb/profitability?start=${wk(9).start}&end=${wk(9).end}&compare=previous_period`);
    const m = r.body.metrics.find((x: any) => x.key === "margin");
    expect(m.change.percentagePoints).toBeCloseTo(-25);   // 25% now vs 50% the week before
  });
});

describe("profit and its revenue basis must come from the same submission", () => {
  const ok = (r: any) => expect(r.outcome).toBe("accepted");

  it("a basis sent in a separate submission never pairs, even when integration, dates, timezone and scope all match", async () => {
    // Reproduction: an older basis-only submission, then a new profit-only submission for the same week.
    ok(await gp("sep-basis", 11, [{ metric: "gross_profit_revenue_basis", value: 800 }]));
    ok(await gp("sep-profit", 11, [{ metric: "gross_profit", value: 200 }]));
    const rows = await q(`select o.metric_key, o.timezone, o.scope_key, o.granularity, i.submitter, i.submission_source, i.source_id, o.import_run_id
                            from observations o join import_runs i on i.id = o.import_run_id where o.period_start = $1 and o.metric_key like 'gross_profit%'`, [wk(11).start]);
    expect(new Set(rows.map((r: any) => `${r.timezone}|${r.scope_key}|${r.granularity}|${r.submitter}|${r.submission_source}|${r.source_id}`)).size).toBe(1);   // everything matches
    expect(new Set(rows.map((r: any) => r.import_run_id)).size).toBe(2);                                                                                    // except the run
    const m = await margin(11);
    expect(m.value).toMatchObject({ state: "missing", value: null, note: "No revenue basis was sent in the same submission as this gross profit" });
  });

  it("a correction carrying only gross profit (or only the basis) is rejected and the earlier pair stays", async () => {
    ok(await gp("pair-1", 12, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 800 }]));
    // Validation refuses these before anything is written (the test helper throws on a refused submission).
    await expect(gp("pair-1-fix-a", 12, [{ metric: "gross_profit", value: 300 }], { corrects: "pair-1" })).rejects.toThrow(/together/);
    await expect(gp("pair-1-fix-b", 12, [{ metric: "gross_profit_revenue_basis", value: 900 }], { corrects: "pair-1" })).rejects.toThrow(/together/);
    // The same rule through the API returns a 422 receipt.
    const token = (await call("admin", "POST", "/settings/automation-clients", { label: "GP task", sources: ["gross_profit"], businesses: ["sb"] })).body.token;
    const api = await call(null, "POST", "/submissions", { ...envelope("x-pair-fix", "sb", wk(12), "week", { corrects: "pair-1" }), source: "gross_profit",
      records: { observations: [{ metric: "gross_profit", value: 300 }] } }, { authorization: `Bearer ${token}` });
    expect(api.status).toBe(422);
    expect(api.body.errors[0].message).toMatch(/together/);
    expect((await margin(12)).value.value).toBeCloseTo(0.25);
  });

  it("a correction sending both replaces the pair and the margin uses the new pair only", async () => {
    ok(await gp("pair-1-fix", 12, [{ metric: "gross_profit", value: 300 }, { metric: "gross_profit_revenue_basis", value: 1000 }], { corrects: "pair-1" }));
    expect((await margin(12)).value).toMatchObject({ state: "value", value: 0.3 });
    expect((await metric(12, "revenue")).value.value).toBe(1000);
  });

  it("a correction cannot pair a new profit with the basis of a different scope", async () => {
    ok(await gp("pair-2", 13, [{ metric: "gross_profit", value: 200 }, { metric: "gross_profit_revenue_basis", value: 800 }]));
    await expect(gp("pair-2-fix", 13, [{ metric: "gross_profit", value: 250 }, { metric: "gross_profit_revenue_basis", scope: "channel:online_store", value: 800 }], { corrects: "pair-2" })).rejects.toThrow(/together/);
    expect((await margin(13)).value.value).toBeCloseTo(0.25);
  });
});
