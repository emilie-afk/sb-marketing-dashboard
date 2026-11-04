// Background sync jobs on a real database: the scheduled function and "Refresh from spreadsheet" only queue a job
// and start the background function, which runs the sync. Signed starts only, no overlapping jobs, replay-safe,
// and a failed, timed-out or abandoned job keeps the last successful data.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { freshDb, call, q, closePool } from "./helpers";
import { annualWorkbook } from "./fixtures/synthetic";
import { _setDispatcherForTests, signJob, jobHeaders, enqueueSheetSync, JOB_LIMITS, verifyJobRequest } from "../server/syncJobs";
import { _setFetchForTests, READER_LIMITS } from "../server/sheetsReader";
import background from "../netlify/functions/sheet-sync-background";
import scheduled from "../netlify/functions/sheet-sync";

let source = "";
let dispatched: string[] = [];
let readerCalls = 0;
let workbookB64 = "";

async function toXlsx(sheets: { name: string; rows: any[][] }[]) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) { const ws = wb.addWorksheet(s.name); s.rows.forEach((r) => ws.addRow(r)); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function signedRequest(jobId: string, opts: { ts?: number; tamper?: boolean; noSig?: boolean } = {}) {
  const body = JSON.stringify({ job_id: jobId });
  const ts = String(opts.ts ?? Date.now());
  const headers: Record<string, string> = { "content-type": "application/json", [jobHeaders.TS_HEADER]: ts };
  if (!opts.noSig) headers[jobHeaders.SIG_HEADER] = opts.tamper ? signJob(body, ts).replace(/^./, (c) => (c === "a" ? "b" : "a")) : signJob(body, ts);
  return new Request("http://localhost/.netlify/functions/sheet-sync-background", { method: "POST", headers, body });
}
const runs = async () => (await q("select count(*)::int n from sync_runs"))[0].n;
const job = async (id: string) => (await q("select status, error, result from sync_jobs where id = $1", [id]))[0];

beforeAll(async () => {
  await freshDb();
  workbookB64 = (await toXlsx(annualWorkbook(2026) as any)).toString("base64");
  source = (await q("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'annual_calendar', 'Annual (test)', 'TESTannualFILEid00000000001', 'xlsx', 't') returning id"))[0].id;
});
afterAll(closePool);
beforeEach(() => {
  dispatched = []; readerCalls = 0;
  _setDispatcherForTests(async (id) => { dispatched.push(id); });
  process.env.SHEET_READER_URL = "https://script.google.com/macros/s/FAKEdeploymentidabcdefghijklmnop0123/exec";
  process.env.SHEET_READER_KEY = "k".repeat(40);
  _setFetchForTests((async () => { readerCalls++; return new Response(JSON.stringify({ ok: true, data: workbookB64 }), { status: 200 }); }) as any);
});
afterEach(async () => {
  _setDispatcherForTests(null); _setFetchForTests(null);
  delete process.env.SHEET_READER_URL; delete process.env.SHEET_READER_KEY;
  await q("update sync_jobs set status = 'abandoned', finished_at = now() where status in ('queued','running')");
});

describe("manual refresh queues a background job", () => {
  it("returns at once without reading; viewers cannot start it", async () => {
    expect((await call("viewer", "POST", `/settings/sheet-sources/${source}/refresh`)).status).toBe(403);
    const before = await runs();
    const r = await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ outcome: "queued" });
    expect(dispatched).toEqual([r.body.job_id]);
    expect(readerCalls).toBe(0);
    expect(await runs()).toBe(before);
    expect((await job(r.body.job_id)).status).toBe("queued");
  });
  it("the signed background request runs the sync and the page can read the result", async () => {
    const { job_id } = (await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body;
    const res = await background(signedRequest(job_id));
    expect(res.status).toBe(204);
    expect(readerCalls).toBe(1);
    const j = await call("viewer", "GET", `/settings/sync-jobs/${job_id}`);
    expect(j.body).toMatchObject({ status: "succeeded", label: "Annual (test)" });
    expect(j.body.result.outcome).toBe("succeeded");
    expect((await q("select count(*)::int n from promotions where code = 'DEMOVDAY'"))[0].n).toBe(1);
  });
  it("a replayed start request does nothing", async () => {
    const { job_id } = (await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body;
    const req1 = signedRequest(job_id), req2 = signedRequest(job_id);
    await background(req1);
    const n = await runs();
    expect((await background(req2)).status).toBe(204);
    expect(await runs()).toBe(n);
    expect(readerCalls).toBe(1);
  });
});

describe("authentication of the background function", () => {
  it("refuses unsigned, tampered, expired and non-POST requests, and the job stays queued", async () => {
    const { job_id } = (await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body;
    const n = await runs();
    expect((await background(signedRequest(job_id, { noSig: true }))).status).toBe(401);
    expect((await background(signedRequest(job_id, { tamper: true }))).status).toBe(401);
    expect((await background(signedRequest(job_id, { ts: Date.now() - JOB_LIMITS.signatureMaxAgeMs - 1000 }))).status).toBe(401);
    expect((await background(new Request("http://localhost/x", { method: "GET" }))).status).toBe(405);
    const other = JSON.stringify({ job_id }), ts = String(Date.now());
    expect(verifyJobRequest(JSON.stringify({ job_id: "00000000-0000-0000-0000-000000000000" }), ts, signJob(other, ts))).toBe(false);
    expect(await runs()).toBe(n);
    expect(readerCalls).toBe(0);
    expect((await job(job_id)).status).toBe("queued");
  });
});

describe("no overlapping jobs", () => {
  it("two simultaneous refreshes create one job and start it once", async () => {
    const [a, b] = await Promise.all([enqueueSheetSync(source, "manual", "a"), enqueueSheetSync(source, "manual", "b")]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["already_running", "queued"]);
    expect(dispatched).toHaveLength(1);
    expect(a.job_id).toBe(b.job_id);
  });
  it("a refresh while a job is running reports it instead of starting another", async () => {
    const { job_id } = (await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body;
    await q("update sync_jobs set status = 'running', started_at = now() where id = $1", [job_id]);
    const r = await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: "already_running", job_id });
    expect(dispatched).toHaveLength(1);
    // The running job cannot be claimed a second time.
    await background(signedRequest(job_id));
    expect(readerCalls).toBe(0);
  });
  it("a job whose lease passed is marked abandoned, its start request no longer runs, and a new job may start", async () => {
    const old = (await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body.job_id;
    await q("update sync_jobs set lease_until = now() - interval '1 minute' where id = $1", [old]);
    const r = await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`);
    expect(r.body.outcome).toBe("queued");
    expect(await job(old)).toMatchObject({ status: "abandoned" });
    await background(signedRequest(old));
    expect(readerCalls).toBe(0);
  });
  it("a failed start is recorded and does not block the next refresh", async () => {
    _setDispatcherForTests(async () => { throw new Error("network"); });
    const r = await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`);
    expect(r.status).toBe(503);
    expect(await job(r.body.job_id)).toMatchObject({ status: "failed" });
    _setDispatcherForTests(async (id) => { dispatched.push(id); });
    expect((await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body.outcome).toBe("queued");
  });
});

describe("last successful data is preserved", () => {
  it("a job whose read times out fails, records the error and changes nothing", async () => {
    const before = await q("select id, title, to_char(start_date,'YYYY-MM-DD') s from promotions order by id");
    const lastOk = (await q("select last_success_at from sheet_sources where id = $1", [source]))[0].last_success_at;
    expect(lastOk).not.toBeNull();
    const saved = READER_LIMITS.timeoutMs; READER_LIMITS.timeoutMs = 50;
    _setFetchForTests(((_u: any, init: any) => { readerCalls++; return new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))); }) as any);
    try {
      const { job_id } = (await call("editor", "POST", `/settings/sheet-sources/${source}/refresh`)).body;
      await background(signedRequest(job_id));
      expect(await job(job_id)).toMatchObject({ status: "failed" });
      expect((await job(job_id)).error).toMatch(/did not finish within/);
    } finally { READER_LIMITS.timeoutMs = saved; }
    expect(await q("select id, title, to_char(start_date,'YYYY-MM-DD') s from promotions order by id")).toEqual(before);
    expect((await q("select last_success_at from sheet_sources where id = $1", [source]))[0].last_success_at).toEqual(lastOk);
  });
});

describe("scheduled function", () => {
  it("only queues due spreadsheets and never reads them itself", async () => {
    await q("update sheet_sources set last_attempt_at = now() - interval '1 day'");
    const t0 = Date.now();
    await scheduled();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(dispatched).toHaveLength(1);
    expect(readerCalls).toBe(0);
    expect((await q("select count(*)::int n from sync_jobs where status = 'queued' and trigger = 'schedule'"))[0].n).toBe(1);
    // A second tick while that job is still queued does not add another.
    await scheduled();
    expect(dispatched).toHaveLength(1);
  });
});
