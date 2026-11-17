// Corporate gifting workflow summary on the dashboard, with synthetic Corporate Gifting answers only: read
// server-side with the reporting credential, only the intended summary fields reach the browser, failures show as
// unavailable, and the Google Form signup count is a separate read.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, call, closePool } from "./helpers";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { corporateWorkflow, _clearWorkflowCache, _clearSampleSignupsCache } from "../server/adapters/corporateGifting";

const CG_URL = "https://cg.example.test", CG_KEY = "c".repeat(40);
let seen: { url: string; auth: string | null }[] = [];
let answers: Record<string, () => Response> = {};
const summary = (over: any = {}) => ({
  ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:corporate-workflow", as_of: "2026-11-16T00:00:00.000Z", today: "2026-11-16",
  sample_progress: { tracked: 2, by_status: { requested: 1, approved: 0, shipped: 1, delivered: 0, cancelled: 0 } },
  follow_ups: { open: 3, overdue: 1 },
  recent: [{ id: "cg:action:x", kind: "blocker", title: "Vendor images missing", supplier: "Demo Market Alpha", at: "2026-11-15T00:00:00.000Z", status: "open",
    source_url: "https://example-workspace.slack.com/archives/C1/p1", note: "PRIVATE NOTE" }],
  supplier_terms: "PRIVATE TERMS", ...over,
});

beforeAll(async () => {
  await freshDb();
  _setReportingFetchForTests((async (u: any, init: any) => {
    const url = String(u);
    seen.push({ url, auth: new Headers(init?.headers ?? {}).get("authorization") });
    const path = new URL(url).pathname;
    return (answers[path] ?? (() => new Response("{}", { status: 404 })))();
  }) as any);
});
afterAll(async () => { _setReportingFetchForTests(null); await closePool(); });
beforeEach(() => {
  seen = []; answers = {};
  _clearWorkflowCache(); _clearSampleSignupsCache();
  Object.assign(process.env, { CORPORATE_GIFTING_API_URL: CG_URL, CORPORATE_GIFTING_REPORTING_SECRET: CG_KEY });
});

describe("corporate workflow summary", () => {
  it("reads the summary with the reporting credential and keeps only the intended fields", async () => {
    answers["/api/reporting/v1/corporate-workflow"] = () => new Response(JSON.stringify(summary()));
    const r = await call("viewer", "GET", "/corporate-workflow");
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ url: `${CG_URL}/api/reporting/v1/corporate-workflow`, auth: `Bearer ${CG_KEY}` }]);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "follow_ups", "ok", "recent", "sample_progress", "schema_version", "today"]);
    expect(Object.keys(r.body.recent[0]).sort()).toEqual(["at", "kind", "status", "supplier", "title"]);
    const text = JSON.stringify(r.body);
    for (const leak of ["PRIVATE NOTE", "PRIVATE TERMS", "slack.com"]) expect(text).not.toContain(leak);
    expect(r.body.follow_ups).toEqual({ open: 3, overdue: 1 });
  });

  it("a source failure or unexpected format is unavailable, never zeros", async () => {
    for (const bad of [() => new Response("{}", { status: 502 }), () => new Response("not json"),
      () => new Response(JSON.stringify(summary({ follow_ups: { open: -1, overdue: 0 } }))), () => new Response(JSON.stringify(summary({ schema_version: 2 })))]) {
      _clearWorkflowCache();
      answers["/api/reporting/v1/corporate-workflow"] = bad;
      expect(await corporateWorkflow()).toEqual({ ok: false, reason: "unavailable" });
    }
    delete process.env.CORPORATE_GIFTING_REPORTING_SECRET;
    expect(await corporateWorkflow()).toEqual({ ok: false, reason: "not_configured" });
  });

  it("is team-only and ignores the date range", async () => {
    answers["/api/reporting/v1/corporate-workflow"] = () => new Response(JSON.stringify(summary()));
    expect((await call(null, "GET", "/corporate-workflow")).status).toBe(401);
    const a = await call("viewer", "GET", "/corporate-workflow?from=2020-01-01&to=2020-01-31");
    expect(a.body.sample_progress.tracked).toBe(2);
  });

  it("sample progress does not change the Google Form signup count (separate source)", async () => {
    answers["/api/reporting/v1/sample-signups"] = () => new Response(JSON.stringify({ ok: true, schema_version: 1, count: 4, checked_at: "2026-11-16T00:00:00.000Z" }));
    answers["/api/reporting/v1/corporate-workflow"] = () => new Response(JSON.stringify(summary({ sample_progress: { tracked: 9, by_status: { requested: 0, approved: 0, shipped: 0, delivered: 9, cancelled: 0 } } })));
    expect((await call("viewer", "GET", "/corporate-workflow")).body.sample_progress.tracked).toBe(9);
    expect((await call("viewer", "GET", "/sample-signups")).body.count).toBe(4);
  });
});
