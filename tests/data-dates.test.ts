// The dashboard shows the dates each figure covers, and for a period it can't answer, the latest reported figure
// with its own dates (never counted toward the period).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, closePool } from "./helpers";
import { envelope } from "./fixtures/synthetic";

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
  it("uses the Saturday-to-Friday week of daily figures when it ends after the latest reported week", async () => {
    await freshDb();
    const token = (await call("admin", "POST", "/settings/automation-clients", { label: "Feeds", sources: ["weekly_report"], businesses: ["sb"] })).body.token as string;
    const post = (b: any) => call(null, "POST", "/submissions", b, { authorization: `Bearer ${token}` });
    const rev = (v: number) => ({ observations: [{ metric: "revenue", value: v }] });
    expect((await post({ ...envelope("wk-1031", "sb", { start: "2030-10-26", end: "2030-11-01" }), records: rev(5000) })).status).toBe(201);
    // 2030-11-02 is a Saturday: days Nov 2 to 10 → the full week Nov 2 to 8 (Fri), plus a partial next week.
    for (let d = 2; d <= 10; d++) {
      const day = `2030-11-${String(d).padStart(2, "0")}`;
      expect((await post({ ...envelope(`day-${day}`, "sb", { start: day, end: day }, "day"), records: rev(100) })).status).toBe(201);
    }
    const r = await call("viewer", "GET", "/business/sb/summary");
    expect(r.body.period).toMatchObject({ start: "2030-11-02", end: "2030-11-08" });
  });
});
