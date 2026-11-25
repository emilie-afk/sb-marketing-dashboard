// Products and vendors when no product report matches the selected dates exactly (synthetic data only).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb } from "./helpers";
import { closePool, query, one } from "../server/db";
import { nearestPeriod, productsAndVendors } from "../server/routes/dashboard";

describe("nearestPeriod", () => {
  const week = { start: "2026-11-07", end: "2026-11-13" };
  it("prefers the shortest saved period covering the whole range", () => {
    expect(nearestPeriod(week, [
      { start: "2026-11-01", end: "2026-11-30" },
      { start: "2026-11-01", end: "2026-11-22" },
      { start: "2026-10-01", end: "2026-10-31" },
    ])).toEqual({ start: "2026-11-01", end: "2026-11-22" });
  });
  it("falls back to the largest overlap when nothing covers the range", () => {
    expect(nearestPeriod({ start: "2026-10-31", end: "2026-11-06" }, [
      { start: "2026-10-01", end: "2026-10-31" },          // 1 day of overlap
      { start: "2026-11-01", end: "2026-11-22" },          // 6 days
    ])).toEqual({ start: "2026-11-01", end: "2026-11-22" });
  });
  it("returns null when no saved period overlaps", () => {
    expect(nearestPeriod(week, [{ start: "2026-09-01", end: "2026-09-30" }])).toBeNull();
    expect(nearestPeriod(week, [])).toBeNull();
  });
});

describe("productsAndVendors with a week range", () => {
  beforeAll(async () => {
    await freshDb();
    const run = await one<any>(`insert into import_runs (source_id, business_id, submission_id, submitter, submission_source, schema_version, content_hash, outcome, period_start, period_end, actor)
      values ('pull.plant_breakdown', 'sb', 'test:mtd', 'pull:test', 'test', 1, 'h', 'accepted', '2026-11-01', '2026-11-22', 'test') returning id`);
    const v = await one<any>(`insert into vendors (business_id, name) values ('sb', 'Demo vendor') returning id`);
    const p = await one<any>(`insert into products (business_id, title, vendor_id, category) values ('sb', 'Demo echeveria', $1, 'Succulent') returning id`, [v.id]);
    await query(`insert into product_observations (import_run_id, product_id, business_id, channel_scope, period_start, period_end, granularity, timezone, revenue, units, orders, completeness)
      values ($1, $2, 'sb', 'channel:shopify_report', '2026-11-01', '2026-11-22', 'custom', 'America/Los_Angeles', 120, 12, 10, 'partial')`, [run.id, p.id]);
  });
  afterAll(closePool);

  it("shows the nearest saved report, labelled with its own dates", async () => {
    const r: any = await productsAndVendors("sb", { start: "2026-11-07", end: "2026-11-13" }, "previous_period");
    expect(r.exact).toBe(false);
    expect(r.period).toEqual({ start: "2026-11-01", end: "2026-11-22" });
    expect(r.requested).toEqual({ start: "2026-11-07", end: "2026-11-13" });
    expect(r.nearestNote).toMatch(/not part of the selected period's totals/);
    expect(r.products.map((x: any) => x.title)).toEqual(["Demo echeveria"]);
  });

  it("uses the exact report when one exists", async () => {
    const r: any = await productsAndVendors("sb", { start: "2026-11-01", end: "2026-11-22" }, null);
    expect(r.exact).toBe(true);
    expect(r.nearestNote).toBeNull();
  });

  it("published reports stay exact and never borrow another period", async () => {
    const r: any = await productsAndVendors("sb", { start: "2026-11-07", end: "2026-11-13" }, null, {}, { nearest: false });
    expect(r.exact).toBe(true);
    expect(r.products).toEqual([]);
  });
});
