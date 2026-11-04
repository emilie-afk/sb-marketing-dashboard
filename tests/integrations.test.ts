// Integration adapters with synthetic inputs (no network): xlsx reading, Plant Revenue Breakdown mapping,
// Google read credential handling, and migration rollback.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { readdirSync, readFileSync } from "node:fs";
import { workbookToSheets, driveReader, appsScriptReader, sheetReader, appsScriptConfigured, readerConfigured, _setFetchForTests, READER_LIMITS } from "../server/sheetsReader";
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

describe("Apps Script spreadsheet reader", () => {
  const URL_OK = "https://script.google.com/macros/s/FAKEdeploymentidabcdefghijklmnop0123/exec";
  const KEY = "k".repeat(40);
  let calls: { url: string; init: any }[] = [];
  const respond = (body: string, status = 200) => _setFetchForTests((async (u: any, init: any) => { calls.push({ url: String(u), init }); return new Response(body, { status }); }) as any);
  beforeEach(() => { calls = []; process.env.SHEET_READER_URL = URL_OK; process.env.SHEET_READER_KEY = KEY; delete process.env.GOOGLE_SYNC_REFRESH_TOKEN; });
  afterEach(() => { _setFetchForTests(null); delete process.env.SHEET_READER_URL; delete process.env.SHEET_READER_KEY; });

  it("is configured only with a script.google.com web app address and a long key", () => {
    expect(appsScriptConfigured()).toBe(true);
    expect(readerConfigured()).toBe(true);
    process.env.SHEET_READER_URL = "https://example.com/macros/s/FAKEdeploymentidabcdefghijklmnop0123/exec";
    expect(appsScriptConfigured()).toBe(false);
    process.env.SHEET_READER_URL = URL_OK; process.env.SHEET_READER_KEY = "short";
    expect(appsScriptConfigured()).toBe(false);
    expect(readerConfigured()).toBe(false);
  });
  it("reads the workbook through the script, sending the key in the body and never in the address", async () => {
    const xlsx = await toXlsx(annualWorkbook(2026) as any);
    respond(JSON.stringify({ ok: true, data: xlsx.toString("base64") }));
    const sheets = await sheetReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx");
    expect(parseAnnualCalendar(sheets, 2026).occasions.length).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_OK);
    expect(calls[0].url).not.toContain(KEY);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ key: KEY, fileId: "FAKEabcdefghijklmnopqrstuvw0", kind: "xlsx" });
  });
  it("turns script refusals into clear sync errors", async () => {
    for (const [error, code] of [["bad_key", "reader_refused"], ["not_allowed", "file_not_allowed"], ["no_access", "file_unavailable"], ["something_else", "read_failed"]]) {
      respond(JSON.stringify({ ok: false, error }));
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "google_sheet")).rejects.toMatchObject({ code });
    }
  });
  it("reports a misdeployed script (sign-in page instead of JSON) and HTTP failures", async () => {
    respond("<html>Sign in</html>");
    await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "reader_misconfigured" });
    respond("err", 500);
    await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "read_failed" });
    respond(JSON.stringify({ ok: true }));
    await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "read_failed" });
  });
  it("refuses invalid file ids before calling the script", async () => {
    respond(JSON.stringify({ ok: true, data: "" }));
    await expect(appsScriptReader("../../etc/passwd", "xlsx")).rejects.toMatchObject({ code: "invalid_file_id" });
    expect(calls).toHaveLength(0);
  });
  const RESULT = "https://script.googleusercontent.com/macros/echo?user_content_key=FAKEresult&lib=FAKElib";
  const seq = (...responses: (() => Response)[]) => _setFetchForTests((async (u: any, init: any) => {
    calls.push({ url: String(u), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  }) as any);
  const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });
  const okJson = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

  it("follows Apps Script's 302 to the result host with a plain GET that carries no key, body or headers", async () => {
    const xlsx = await toXlsx(annualWorkbook(2026) as any);
    seq(redirect(302, RESULT), okJson({ ok: true, data: xlsx.toString("base64") }));
    const sheets = await appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx");
    expect(sheets.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[1].url).toBe(RESULT);
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.body).toBeUndefined();
    expect(calls[1].init.headers).toBeUndefined();
    expect(JSON.stringify(calls[1])).not.toContain(KEY);
  });
  it("refuses 307/308 redirects (they would resend the POST and its key)", async () => {
    for (const status of [307, 308]) {
      calls = [];
      seq(redirect(status, RESULT));
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "reader_redirect_refused" });
      expect(calls).toHaveLength(1);
    }
  });
  it("refuses redirects to any other host, to plain http, or with credentials or another port", async () => {
    for (const loc of ["https://example.com/steal", "http://script.googleusercontent.com/macros/echo", "https://accounts.google.com/ServiceLogin",
      "https://script.googleusercontent.com.evil.example/x", ["https://u:p", "script.googleusercontent.com/x"].join("@"), "https://script.googleusercontent.com:8443/x"]) {
      calls = [];
      seq(redirect(302, loc));
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "reader_misconfigured" });
      expect(calls).toHaveLength(1);
    }
  });
  it("stops after the allowed number of redirect hops", async () => {
    seq(redirect(302, RESULT), redirect(302, RESULT), redirect(302, RESULT), okJson({ ok: true, data: "AA==" }));
    await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "reader_redirect_refused" });
    expect(calls).toHaveLength(3);
  });
  it("one deadline covers a stalled request", async () => {
    const saved = READER_LIMITS.timeoutMs; READER_LIMITS.timeoutMs = 50;
    try {
      _setFetchForTests(((_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as any);
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "read_timeout" });
    } finally { READER_LIMITS.timeoutMs = saved; }
  });
  it("the same deadline covers a redirect followed by a body that never finishes", async () => {
    const saved = READER_LIMITS.timeoutMs; READER_LIMITS.timeoutMs = 80;
    try {
      const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true,"data":"')); } });
      seq(redirect(302, RESULT), () => new Response(stalled, { status: 200 }));
      const t0 = Date.now();
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "read_timeout" });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { READER_LIMITS.timeoutMs = saved; }
  });
  it("enforces the size limit while downloading, before parsing or decoding", async () => {
    const saved = READER_LIMITS.maxResponseBytes; READER_LIMITS.maxResponseBytes = 1000;
    try {
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(400).fill(65)); } });
      seq(() => new Response(endless, { status: 200 }));
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "too_large" });
      expect(pulled).toBeLessThan(10);
      calls = [];
      seq(() => new Response("x", { status: 200, headers: { "content-length": "5000" } }));
      await expect(appsScriptReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "too_large" });
    } finally { READER_LIMITS.maxResponseBytes = saved; }
  });
  it("falls back to the Drive reader when the script is not configured", async () => {
    delete process.env.SHEET_READER_URL;
    respond(JSON.stringify({ ok: true, data: "" }));
    await expect(sheetReader("FAKEabcdefghijklmnopqrstuvw0", "xlsx")).rejects.toMatchObject({ code: "not_configured" });
    expect(calls).toHaveLength(0);
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
