// Corporate sample box signups on the dashboard, with synthetic Corporate Gifting answers only: the count comes
// server-side from the Corporate Gifting reporting API with its own credential, ignores the date filter, and a
// source failure shows as unavailable, never as zero.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, call, closePool } from "./helpers";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { corporateSampleSignups, _clearSampleSignupsCache } from "../server/adapters/corporateGifting";

const CG_URL = "https://cg.example.test", CG_KEY = "c".repeat(40);
let seen: { url: string; auth: string | null }[] = [];
let answer: () => Response;
const ok = (count: number) => () => new Response(JSON.stringify({ ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:sample-signups", count, checked_at: "2026-11-16T00:00:00.000Z" }), { status: 200 });

beforeAll(async () => {
  await freshDb();
  _setReportingFetchForTests((async (u: any, init: any) => {
    seen.push({ url: String(u), auth: new Headers(init?.headers ?? {}).get("authorization") });
    return answer();
  }) as any);
});
afterAll(async () => { _setReportingFetchForTests(null); await closePool(); });
beforeEach(() => {
  seen = [];
  _clearSampleSignupsCache();
  Object.assign(process.env, { CORPORATE_GIFTING_API_URL: CG_URL, CORPORATE_GIFTING_REPORTING_SECRET: CG_KEY });
});

describe("sample box signups", () => {
  it("reads the count from Corporate Gifting with its reporting credential", async () => {
    answer = ok(0);
    expect(await corporateSampleSignups()).toEqual({ count: 0, checked_at: "2026-11-16T00:00:00.000Z" });
    expect(seen).toEqual([{ url: `${CG_URL}/api/reporting/v1/sample-signups`, auth: `Bearer ${CG_KEY}` }]);
  });
  it("a source failure is unavailable, never zero, and is not cached", async () => {
    for (const bad of [() => new Response("{}", { status: 502 }), () => new Response("{}", { status: 401 }), () => new Response("{}", { status: 503 }),
      () => new Response("not json"), () => new Response(JSON.stringify({ ok: true, schema_version: 1, count: -1 })), () => new Response(JSON.stringify({ ok: true, schema_version: 2, count: 3 }))]) {
      answer = bad;
      expect(await corporateSampleSignups()).toEqual({ count: null, reason: "unavailable" });
    }
    answer = ok(4);
    expect((await corporateSampleSignups()).count).toBe(4);
  });
  it("without credentials it is not configured and nothing is requested", async () => {
    delete process.env.CORPORATE_GIFTING_REPORTING_SECRET;
    expect(await corporateSampleSignups()).toEqual({ count: null, reason: "not_configured" });
    expect(seen).toHaveLength(0);
  });
  it("does not depend on the monthly pull switch", async () => {
    const saved = process.env.CORPORATE_GIFTING_PULL_ENABLED;
    delete process.env.CORPORATE_GIFTING_PULL_ENABLED;
    answer = ok(2);
    expect((await corporateSampleSignups()).count).toBe(2);
    if (saved !== undefined) process.env.CORPORATE_GIFTING_PULL_ENABLED = saved;
  });
  it("caches a successful count for two minutes", async () => {
    answer = ok(1);
    const t = Date.now();
    await corporateSampleSignups(t);
    answer = ok(9);
    expect((await corporateSampleSignups(t + 60_000)).count).toBe(1);
    expect((await corporateSampleSignups(t + 3 * 60_000)).count).toBe(9);
    expect(seen).toHaveLength(2);
  });
  it("the dashboard route needs a team member and ignores any date range", async () => {
    answer = ok(5);
    expect((await call(null, "GET", "/sample-signups")).status).toBe(401);
    expect((await call("outsider", "GET", "/sample-signups")).status).toBe(401);
    const a = await call("viewer", "GET", "/sample-signups");
    const b = await call("viewer", "GET", "/sample-signups?from=2020-01-01&to=2020-01-31");
    expect(a.status).toBe(200);
    expect(a.body.count).toBe(5);
    expect(b.body.count).toBe(5);
    // Count and metadata only.
    expect(Object.keys(a.body).sort()).toEqual(["checked_at", "count"]);
  });
});
