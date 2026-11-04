// Annual and seasonal spreadsheets of the same business synced at the same time (their background jobs can run
// concurrently). A test hook pauses each sync after it has read existing promotions, waiting for the other to
// arrive, so without the per-business lock both would plan against the same empty state.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { freshDb, q, closePool } from "./helpers";
import { annualWorkbook, seasonalWorkbook } from "./fixtures/synthetic";
import { runSheetSync, _setAfterCalendarReadForTests } from "../server/sheetSync";

let annual = "", seasonal = "";
const annualWithHarvest = () => {
  const wb = annualWorkbook(2026);
  wb.find((s) => s.name === "Nov 2026")!.rows.push(["Nov 2 - 11", "Harvest (annual copy)", "20% off", "DEMOHARVEST"]);
  return wb;
};

// Each sync, after reading existing promotions, waits up to 400 ms for the other one to be at the same point.
// "overlapped" records whether both were ever there at the same time, i.e. both had read before either wrote.
function overlapBarrier() {
  let inside = 0, release: () => void = () => {};
  const both = new Promise<void>((r) => (release = r));
  let overlapped = false;
  _setAfterCalendarReadForTests(async () => {
    inside++;
    if (inside >= 2) { overlapped = true; release(); }
    await Promise.race([both, new Promise((r) => setTimeout(r, 400))]);
    inside--;
  });
  return { overlapped: () => overlapped };
}

beforeAll(async () => {
  await freshDb();
  annual = (await q("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'annual_calendar', 'A', 'TESTannualFILEid00000000001', 'xlsx', 't') returning id"))[0].id;
  seasonal = (await q("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'seasonal_program', 'S', 'TESTseasonFILEid00000000001', 'google_sheet', 't') returning id"))[0].id;
});
afterAll(closePool);
afterEach(() => _setAfterCalendarReadForTests(null));

async function reset() {
  await q("delete from review_items"); await q("delete from promotion_revisions"); await q("delete from promotion_source_links");
  await q("delete from promotions"); await q("delete from occasions");
}

describe("concurrent annual and seasonal syncs", () => {
  for (const order of ["annual first", "seasonal first"]) {
    it(`keep one promotion with seasonal precedence (${order} started)`, async () => {
      await reset();
      const barrier = overlapBarrier();
      const a = () => runSheetSync(annual, "schedule", "schedule", async () => annualWithHarvest());
      const s = () => runSheetSync(seasonal, "schedule", "schedule", async () => seasonalWorkbook(2026));
      const [r1, r2] = order === "annual first" ? await Promise.all([a(), s()]) : await Promise.all([s(), a()]);
      expect([r1.outcome, r2.outcome].every((o) => o !== "failed")).toBe(true);
      // With the lock the second sync cannot read until the first commits, so they never overlap at the hook.
      expect(barrier.overlapped()).toBe(false);

      const rows = await q("select id, title, offer from promotions where code = 'DEMOHARVEST'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "Demo harvest", offer: "5% off all orders" });
      // Both sheets link to the same promotion.
      const links = await q("select s.role from promotion_source_links l join sheet_sources s on s.id = l.sheet_source_id where l.promotion_id = $1 order by s.role", [rows[0].id]);
      expect(links.map((l: any) => l.role)).toEqual(["annual_calendar", "seasonal_program"]);
      // No other code was duplicated either.
      expect(await q("select code, count(*)::int n from promotions where code is not null group by code having count(*) > 1")).toEqual([]);
    });
  }
});
