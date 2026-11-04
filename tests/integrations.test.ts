// Integration adapters with synthetic inputs (no network): xlsx reading, Plant Revenue Breakdown mapping,
// Google read credential handling, and migration rollback.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { readdirSync, readFileSync } from "node:fs";
import { workbookToSheets, driveReader } from "../server/sheetsReader";
import { parseAnnualCalendar, parseSeasonalProgram } from "../shared/calendarParse";
import { annualWorkbook, seasonalWorkbook } from "./fixtures/synthetic";
import { reportToSubmission } from "../server/adapters/plantBreakdown";
import { checkSubmission } from "../shared/submission";
import { freshDb, q, closePool } from "./helpers";
import { fileIdFrom } from "../server/routes/settings";

async function toXlsx(sheets: { name: string; rows: any[][] }[]) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) { const ws = wb.addWorksheet(s.name); s.rows.forEach((r) => ws.addRow(r)); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("spreadsheet reading", () => {
  it("reads an .xlsx workbook (Drive export path) into the same parse results", async () => {
    const sheets = await workbookToSheets(await toXlsx(annualWorkbook(2026) as any));
    const p = parseAnnualCalendar(sheets, 2026);
    expect(p.promotions.map((x) => x.code).filter(Boolean)).toEqual(expect.arrayContaining(["DEMONEW", "DEMOLOVE", "DEMOVDAY", "DEMOEARTH"]));
    expect(p.tabs.find((t) => t.tab === "Nov 2026")).toMatchObject({ blank: true });
    expect(p.occasions.length).toBe(5);
    const s = parseSeasonalProgram(await workbookToSheets(await toXlsx(seasonalWorkbook(2026) as any)), 2026);
    expect(s.promotions.find((x) => x.identityKey === "vendor:fernwood-growers-demo" && !x.crossCheckOnly)).toMatchObject({ vendor_cost_reduction: 7, customer_discount: 12 });
  });
  it("columns are found by header and content, not position", async () => {
    const p = parseAnnualCalendar(annualWorkbook(2026), 2026);
    const earth = p.promotions.find((x) => x.code === "DEMOEARTH")!;   // discount before name in this tab
    expect(earth).toMatchObject({ title: "Demo Earth Day", customer_discount: 12 });
    expect(p.promotions.find((x) => x.code === "DEMOVDAY")!.identityKey).toBe("code:DEMOVDAY");
  });
  it("reports 'not configured' without a Google read credential, and never accepts arbitrary ids", async () => {
    delete process.env.GOOGLE_SYNC_REFRESH_TOKEN;
    await expect(driveReader("AAAAAAAAAAAAAAAAAAAAAAAA", "xlsx")).rejects.toMatchObject({ code: "not_configured" });
    expect(fileIdFrom("https://docs.google.com/spreadsheets/d/FAKEabcdefghijklmnopqrstuvw0/edit#gid=1")).toBe("FAKEabcdefghijklmnopqrstuvw0");
    expect(fileIdFrom("https://drive.google.com/file/d/FAKEabcdefghijklmnopqrstuvw0/view")).toBe("FAKEabcdefghijklmnopqrstuvw0");
    expect(fileIdFrom("../../etc/passwd")).toBeNull();
  });
});

describe("Plant Revenue Breakdown adapter", () => {
  beforeAll(() => { process.env.EXCLUDED_BRANDS = "Excluded Demo Brand"; });
  it("maps a saved report to a valid submission with explicit channel scope and missing costs", () => {
    const body = reportToSubmission({ id: "shopify:total_sales_by_product:2026-09-01:2026-09-30:r2", source: "shopify", report_scope: "total_sales_by_product",
      period_start: "2026-09-01", period_end: "2026-09-30", timezone: "America/Los_Angeles", revision: 2, status: "active", collected_at: "2026-10-01T10:00:00Z", completeness: "complete" },
      [{ product_id: "1", title: "Demo plant", vendor: "Demo vendor", product_type: "Succulent", units: 3, net: 30 }, { product_id: "2", title: "x", vendor: "Excluded Demo Brand", product_type: "", units: 1, net: 9 }]);
    expect(body.period.granularity).toBe("month");
    const c = checkSubmission(body);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.value.accepted.products).toHaveLength(1);
      expect(c.value.accepted.products[0]).toMatchObject({ channel_scope: "channel:shopify_report", cost_state: "missing", gross_profit: null });
    }
  });
});

describe("migrations", () => {
  beforeAll(freshDb);
  afterAll(closePool);
  it("roll back cleanly in reverse order and re-apply", async () => {
    const dir = new URL("../db/rollback/", import.meta.url);
    for (const f of readdirSync(dir).sort().reverse()) await q(readFileSync(new URL(f, dir), "utf8"));
    expect((await q("select count(*)::int n from schema_migrations"))[0].n).toBe(0);
    expect((await q("select to_regclass('public.promotions') as t"))[0].t).toBeNull();
    const { migrate } = await import("../scripts/migrate");
    await migrate(() => {});
    expect((await q("select count(*)::int n from businesses"))[0].n).toBe(3);
  });
});
