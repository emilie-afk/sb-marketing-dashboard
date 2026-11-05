// POST /api/pull-check: a deployment-level connection check for the source apps' key rotations.
// It needs an automation token granted "pull-check" explicitly, answers one word, and never returns source data.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { freshDb, call, closePool } from "./helpers";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { createClient } from "../server/automation";
import { createHash } from "node:crypto";
const kid = (k: string) => createHash("sha256").update(`sb-reporting-key-id:${k}`).digest("hex").slice(0, 16);

const GP_URL = "https://gp.example.test", PB_URL = "https://pb.example.test", CG_URL = "https://cg.example.test";
const GP_KEY = "g".repeat(40), PB_KEY = "p".repeat(40), CG_KEY = "c".repeat(40);
const PRIVATE = "PRIVATE-FIGURE-998877";
let seen: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
let answer: (url: string, headers: Record<string, string>) => Response;
let checker = "", allSources = "", submitter = "";

const check = (token: string | null, body: unknown) =>
  call(null, "POST", "/pull-check", body, token ? { authorization: `Bearer ${token}` } : {});

beforeAll(async () => {
  await freshDb();
  checker = (await createClient("rotation workflow", ["pull-check"], ["sb"], "admin@example.test")).token;
  allSources = (await createClient("wildcard", ["*"], ["sb"], "admin@example.test")).token;
  submitter = (await createClient("weekly report", ["weekly_report"], ["sb"], "admin@example.test")).token;
});
afterAll(async () => { _setReportingFetchForTests(null); await closePool(); });
beforeEach(() => {
  seen = [];
  Object.assign(process.env, {
    GROSS_PROFIT_API_URL: GP_URL, GROSS_PROFIT_REPORTING_SECRET: GP_KEY,
    PLANT_BREAKDOWN_API_URL: PB_URL, PLANT_BREAKDOWN_REPORTING_KEY: PB_KEY,
    CORPORATE_GIFTING_API_URL: CG_URL, CORPORATE_GIFTING_REPORTING_SECRET: CG_KEY,
  });
  answer = () => new Response(JSON.stringify({ ok: true, weeks: [{ totals: { gross_profit: PRIVATE } }], reports: [], months: [] }), { status: 200, headers: { "x-reporting-key-slot": "2" } });
  _setReportingFetchForTests((async (u: any, init: any) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    seen.push({ url: String(u), headers, redirect: init?.redirect });
    return answer(String(u), headers);
  }) as any);
});
afterEach(() => {
  for (const k of ["GROSS_PROFIT_API_URL", "GROSS_PROFIT_REPORTING_SECRET", "PLANT_BREAKDOWN_API_URL", "PLANT_BREAKDOWN_REPORTING_KEY",
    "CORPORATE_GIFTING_API_URL", "CORPORATE_GIFTING_REPORTING_SECRET"]) delete process.env[k];
});

describe("pull check", () => {
  it("reads each source once with this deployment's credential and answers one word, no data", async () => {
    for (const [source, url, header, value] of [
      ["gross_profit", `${GP_URL}/v1/reporting/weeks?limit=1`, "x-reporting-secret", GP_KEY],
      ["plant_breakdown", `${PB_URL}/v1/reports`, "authorization", `Bearer ${PB_KEY}`],
      ["corporate_gifting", `${CG_URL}/api/reporting/v1/months?limit=1`, "authorization", `Bearer ${CG_KEY}`],
    ]) {
      seen = [];
      const r = await check(checker, { source });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ source, result: "ok", key_id: kid(String(value).replace("Bearer ", "")), slots: ["2"] });
      expect(JSON.stringify(r.body)).not.toContain(PRIVATE);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(url);
      expect(seen[0].headers[header]).toBe(value);
      expect(seen[0].redirect).toBe("manual");
    }
  });

  it("reports a refused credential, a disabled source and an unreachable one without details", async () => {
    answer = () => new Response(JSON.stringify({ error: PRIVATE }), { status: 401 });
    expect((await check(checker, { source: "gross_profit" })).body).toEqual({ source: "gross_profit", result: "unauthorized", key_id: kid(GP_KEY), slots: [] });
    answer = () => new Response("{}", { status: 503 });
    expect((await check(checker, { source: "gross_profit" })).body.result).toBe("disabled");
    answer = () => { throw new TypeError(`connect failed ${PRIVATE}`); };
    const r = await check(checker, { source: "plant_breakdown" });
    expect(r.body).toEqual({ source: "plant_breakdown", result: "unreachable", key_id: kid(PB_KEY), slots: [] });
    answer = () => new Response("", { status: 302, headers: { location: "https://elsewhere.example.test/" } });
    expect((await check(checker, { source: "gross_profit" })).body.result).toBe("unexpected_response");
    expect(seen.every((s) => !s.url.includes("elsewhere"))).toBe(true);
  });

  it("says not_configured when this deployment has no credential for the source", async () => {
    delete process.env.GROSS_PROFIT_REPORTING_SECRET;
    const r = await check(checker, { source: "gross_profit" });
    expect(r.body).toEqual({ source: "gross_profit", result: "not_configured", key_id: null, slots: [] });
    expect(seen).toHaveLength(0);
  });

  it("the key id changes with the key and never reveals it; unexpected slot values are dropped", async () => {
    const a = (await check(checker, { source: "gross_profit" })).body.key_id;
    process.env.GROSS_PROFIT_REPORTING_SECRET = "h".repeat(40);
    const b = (await check(checker, { source: "gross_profit" })).body.key_id;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).not.toBe(a);
    expect(JSON.stringify(b)).not.toContain("hhhh");
    answer = () => new Response("{}", { status: 200, headers: { "x-reporting-key-slot": "1,3,secret" } });
    expect((await check(checker, { source: "gross_profit" })).body.slots).toEqual(["1"]);
  });

  it("needs a token granted pull-check explicitly; sessions, wildcard and other tokens are refused", async () => {
    expect((await check(null, { source: "gross_profit" })).status).toBe(401);
    expect((await call("admin", "POST", "/pull-check", { source: "gross_profit" })).status).toBe(401);
    expect((await check(allSources, { source: "gross_profit" })).status).toBe(403);
    expect((await check(submitter, { source: "gross_profit" })).status).toBe(403);
    expect((await check(checker, { source: "unknown" })).status).toBe(400);
    expect((await check(checker, { source: "__proto__" })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("a pull-check token cannot submit data", async () => {
    const r = await call(null, "POST", "/submissions", { schema_version: 1 }, { authorization: `Bearer ${checker}` });
    expect([403, 422]).toContain(r.status);
  });
});
