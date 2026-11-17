// The dashboard shows the dates each figure covers, and for a period it can't answer, the latest reported figure
// with its own dates (never counted toward the period).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, closePool } from "./helpers";
import { envelope } from "./fixtures/synthetic";
import { applyPulled } from "../server/adapters/pullApply";

beforeAll(async () => { await freshDb(); });
afterAll(closePool);

describe("latest reported figure for a period that can't be answered", () => {
  const week = { start: "2030-03-29", end: "2030-04-04" };   // starts in March, ends in April
  beforeAll(async () => {
    const token = (await call("admin", "POST", "/settings/automation-clients", { label: "Weekly", sources: ["weekly_report"], businesses: ["sb"] })).body.token as string;
    const r = await call(null, "POST", "/submissions", { ...envelope("wk-straddle", "sb", week), records: { observations: [{ metric: "ad_spend", value: 1665.05 }, { metric: "revenue", value: 9000 }] } }, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(201);
  });

  it("April stays missing, and the straddling week is shown with its own dates and the days outside April", async () => {
    const m = (await call("viewer", "GET", "/business/sb/summary?start=2030-04-01&end=2030-04-30&compare=previous_period")).body.metrics;
    const ad = m.find((x: any) => x.key === "ad_spend");
    expect(ad.value.state).toBe("missing");
    expect(ad.covered).toBeNull();
    expect(ad.latest).toMatchObject({ period: week, granularity: "week", value: { state: "value", value: 1665.05 }, outside: [{ start: "2030-03-29", end: "2030-03-31" }] });
  });

  it("a figure the period can answer carries its covered dates and no latest-figure note", async () => {
    const m = (await call("viewer", "GET", `/business/sb/summary?start=${week.start}&end=${week.end}&compare=none`)).body.metrics;
    const ad = m.find((x: any) => x.key === "ad_spend");
    expect(ad.value.value).toBe(1665.05);
    expect(ad.covered).toEqual(week);
    expect(ad.latest).toBeUndefined();
  });
});

describe("default view is the latest full reporting week", () => {
  // 2030-11-02 is a Saturday; weeks run Saturday to Friday.
  const day = (d: number) => `2030-11-${String(d).padStart(2, "0")}`;
  let post: (b: any) => Promise<any>;
  /** Daily Analytics figures, as the sheet sync stores them: one submission per business and month. */
  const daily = (business: "sb" | "p2s", tag: string, days: { day: string; value: number | null; state?: string }[]) =>
    applyPulled({ schema_version: 1, submission_id: `dar:${business}:2030-11:${tag}`, source: "daily_analytics", business,
      period: { start: "2030-11-01", end: "2030-11-30", granularity: "month", timezone: "America/Los_Angeles" },
      collected_at: "2030-12-01T08:00:00Z", completeness: "complete",
      records: { observations: days.map((d) => ({ metric: "revenue", scope: "all", period_start: d.day, period_end: d.day, granularity: "day", value: d.value, ...(d.state ? { state: d.state } : {}) })) } },
      `dar:${business}:2030-11`, { sourceId: "sheet.daily_analytics", submitter: "sheet:test", submissionSource: "daily_analytics" }, "test");
  const weekly = (id: string, period: { start: string; end: string }) =>
    post({ ...envelope(id, "sb", period), records: { observations: [{ metric: "revenue", value: 5000 }] } });
  const defaultPeriod = async () => (await call("viewer", "GET", "/business/sb/summary")).body.period;
  const reset = async () => {
    await freshDb();
    const token = (await call("admin", "POST", "/settings/automation-clients", { label: "Weekly", sources: ["weekly_report", "ads"], businesses: ["sb", "p2s"] })).body.token as string;
    post = (b: any) => call(null, "POST", "/submissions", b, { authorization: `Bearer ${token}` });
    expect((await weekly("wk-1026", { start: "2030-10-26", end: "2030-11-01" })).status).toBe(201);
  };

  it("uses a Sat-Fri week with seven Daily Analytics totals for one business when it ends after the latest weekly report", async () => {
    await reset();
    const r = await daily("sb", "full", Array.from({ length: 9 }, (_, i) => ({ day: day(2 + i), value: 100 })));
    expect(r.outcome).toBe("accepted");
    expect(await defaultPeriod()).toMatchObject({ start: day(2), end: day(8) });
  });

  it("does not stitch a week together from two businesses", async () => {
    await reset();
    await daily("sb", "half", [2, 3, 4, 5].map((d) => ({ day: day(d), value: 100 })));
    await daily("p2s", "half", [6, 7, 8].map((d) => ({ day: day(d), value: 50 })));
    expect(await defaultPeriod()).toMatchObject({ start: "2030-10-26", end: "2030-11-01" });
  });

  it("a day marked missing breaks the week; a reported zero does not", async () => {
    await reset();
    await daily("sb", "miss", [2, 3, 4, 5, 6, 7, 8].map((d) => (d === 5 ? { day: day(d), value: null, state: "missing" } : { day: day(d), value: 100 })));
    expect(await defaultPeriod()).toMatchObject({ start: "2030-10-26", end: "2030-11-01" });
    await reset();
    await daily("sb", "zero", [2, 3, 4, 5, 6, 7, 8].map((d) => ({ day: day(d), value: d === 5 ? 0 : 100 })));
    expect(await defaultPeriod()).toMatchObject({ start: day(2), end: day(8) });
  });

  it("ignores daily figures from other sources and weekly rows that aren't exactly Saturday to Friday", async () => {
    await reset();
    // Seven daily revenue rows from another source don't count as Daily Analytics totals.
    for (const d of [2, 3, 4, 5, 6, 7, 8]) expect((await post({ ...envelope(`other-${d}`, "sb", { start: day(d), end: day(d) }, "day"), records: { observations: [{ metric: "revenue", value: 100 }] } })).status).toBe(201);
    // A "week" that runs Monday to Sunday, and one that is eight days long, are not reporting weeks.
    expect((await weekly("wk-mon", { start: day(4), end: day(10) })).status).toBe(201);
    expect((await weekly("wk-long", { start: day(9), end: day(16) })).status).toBe(201);
    expect(await defaultPeriod()).toMatchObject({ start: "2030-10-26", end: "2030-11-01" });
  });
});
