// Perksradar reporting pull (fake app, synthetic counts): daily counts become the Perksradar cards; only finished days
// and whole months in the window are stored; a changed month is a correction; a failed page stores nothing.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { freshDb, call, closePool, q } from "./helpers";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { pullPerksradar, perksradarConfigured, PR_WINDOW_DAYS } from "../server/adapters/perksradar";
import { PULLS } from "../server/syncJobs";
import { addDays, eachDay } from "../shared/dates";

const TODAY = "2030-11-20";
const SECRET = "test-perksradar-reporting-secret-0123456789";
type FakeDay = { date: string; complete?: boolean; signups?: number | null; cards_added?: number | null; reminders_sent?: number | null; emails_delivered?: number | null; emails_opened?: number | null; emails_clicked?: number | null };
let days: FakeDay[] = [];
let calls: { url: string; secret: string | null }[] = [];
let failPage: number | null = null;

function fake(pageSize = 50) {
  _setReportingFetchForTests((async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ url: u.pathname + u.search, secret: init?.headers?.["x-reporting-secret"] ?? null });
    if (u.pathname !== "/v1/reporting/days") return new Response("{}", { status: 404 });
    if (init?.headers?.["x-reporting-secret"] !== SECRET) return new Response("{}", { status: 401 });
    const from = u.searchParams.get("from")!, to = u.searchParams.get("to")!;
    const start = Number(u.searchParams.get("cursor") ?? 0);
    if (failPage !== null && start === failPage * pageSize) return new Response("{}", { status: 500 });
    const inRange = days.filter((d) => !d.date || (d.date >= from && d.date <= to));   // an item without a date is sent as is
    const page = inRange.slice(start, start + pageSize).map((d) => ({ complete: true, signups: 0, cards_added: 0, reminders_sent: 0, emails_delivered: 0, emails_opened: 0, emails_clicked: 0, ...d }));
    const next = start + pageSize < inRange.length ? String(start + pageSize) : null;
    return new Response(JSON.stringify({ ok: true, schema_version: 1, timezone: "America/Los_Angeles", days: page, next_cursor: next }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any);
}

beforeAll(async () => {
  await freshDb();
  process.env.PERKSRADAR_API_URL = "https://perksradar.example.test";
  process.env.PERKSRADAR_REPORTING_SECRET = SECRET;
});
afterEach(() => { _setReportingFetchForTests(null); failPage = null; });
afterAll(async () => { delete process.env.PERKSRADAR_API_URL; delete process.env.PERKSRADAR_REPORTING_SECRET; await closePool(); });

describe("Perksradar pull", () => {
  it("is a registered pull with its own source, configured only with an https origin and a long secret", async () => {
    expect(PULLS.perksradar).toMatchObject({ sourceId: "pull.perksradar", label: "Perksradar" });
    expect(perksradarConfigured()).toBe(true);
    const saved = process.env.PERKSRADAR_REPORTING_SECRET;
    process.env.PERKSRADAR_REPORTING_SECRET = "short";
    expect(perksradarConfigured()).toBe(false);
    process.env.PERKSRADAR_REPORTING_SECRET = saved;
    expect((await q("select business_id, kind, status from source_connections where id = 'pull.perksradar'"))[0]).toEqual({ business_id: "perksradar", kind: "pull", status: "not_configured" });
  });

  it("stores finished days by month; the four Perksradar cards show the week's totals", async () => {
    const window = eachDay({ start: addDays(TODAY, -PR_WINDOW_DAYS), end: TODAY });
    days = window.map((d, i) => ({ date: d, signups: 2, cards_added: 5, reminders_sent: 40, emails_delivered: 39, emails_opened: 20, emails_clicked: i % 2 }));
    days[days.length - 1].complete = false;                                   // today: still running
    fake();
    const r = await pullPerksradar("test", TODAY);
    expect(r.outcome).toBe("done");
    expect(calls.every((c) => c.secret === SECRET && !c.url.includes(SECRET))).toBe(true);   // credential in a header only
    // Window Jul 23 - Nov 19: July starts before it, so only Aug, Sep, Oct and the running November are stored.
    expect(r.results.map((x: any) => [x.month, x.outcome])).toEqual([["2030-08", "accepted"], ["2030-09", "accepted"], ["2030-10", "accepted"], ["2030-11", "accepted"]]);
    expect((await q("select count(*)::int n from observations where source_id = 'pull.perksradar' and period_start = $1", [TODAY]))[0].n).toBe(0);
    const m = (await call("viewer", "GET", "/business/perksradar/summary?start=2030-11-09&end=2030-11-15&compare=previous_period")).body.metrics;
    const v = (k: string) => m.find((x: any) => x.key === k).value;
    expect([v("signups"), v("cards_added"), v("reminders_sent"), v("emails_opened")].map((x: any) => [x.state, x.value])).toEqual([["value", 14], ["value", 35], ["value", 280], ["value", 140]]);
  });

  it("an unchanged read writes nothing; a changed day corrects its month only; a missing count is never zero", async () => {
    calls = [];
    fake();
    expect((await pullPerksradar("test", TODAY)).results.every((x: any) => x.outcome === "unchanged")).toBe(true);
    days = days.map((d) => (d.date === "2030-10-05" ? { ...d, signups: 9 } : d.date === "2030-10-06" ? { ...d, emails_opened: null } : d));
    const r = await pullPerksradar("test", TODAY);
    expect(r.results.filter((x: any) => x.outcome === "accepted").map((x: any) => x.month)).toEqual(["2030-10"]);
    const day = async (d: string, k: string) => (await q("select value::float8 v, value_state s from observations where status = 'active' and source_id = 'pull.perksradar' and metric_key = $2 and period_start = $1", [d, k]))[0];
    expect(await day("2030-10-05", "signups")).toEqual({ v: 9, s: "value" });
    expect(await day("2030-10-06", "emails_opened")).toEqual({ v: null, s: "missing" });
  });

  // A complete month already stored must never be replaced by a partial read.
  const oct = async () => (await q("select count(distinct period_start)::int n, sum(value)::float8 total from observations where status = 'active' and source_id = 'pull.perksradar' and metric_key = 'cards_added' and period_start between '2030-10-01' and '2030-10-31'"))[0];
  it("an omitted, malformed, unfinished or conflicting day holds its month: the stored month is kept and the gap reported", async () => {
    const full = days.map((d) => ({ ...d }));
    const before = await oct();
    expect(before.n).toBe(31);
    const variants: [string, FakeDay[]][] = [
      ["omitted", full.filter((d) => d.date !== "2030-10-15")],
      ["malformed", full.map((d) => (d.date === "2030-10-15" ? { ...d, cards_added: -1 } : d))],
      ["unfinished", full.map((d) => (d.date === "2030-10-15" ? { ...d, complete: false } : d))],
      ["conflicting", [...full, { ...full.find((d) => d.date === "2030-10-15")!, cards_added: 99 }]],
    ];
    for (const [name, v] of variants) {
      days = v.map((d) => (d.date.startsWith("2030-10") && d.date !== "2030-10-15" ? { ...d, cards_added: 7 } : d));   // other October days changed too
      fake();
      const r = await pullPerksradar("test", TODAY);
      expect(r.outcome, name).toBe("incomplete");
      expect(r.results.find((x: any) => x.month === "2030-10"), name).toMatchObject({ outcome: "held" });
      expect(r.problems.join(" "), name).toMatch(/2030-10: 1 day\(s\) missing, unfinished or unreadable \(first: 2030-10-15\)/);
      expect(await oct(), name).toEqual(before);                     // October unchanged: nothing replaced, nothing lost
      expect(r.results.find((x: any) => x.month === "2030-09")?.outcome, name).not.toBe("held");   // other months unaffected
    }
    days = full;
  });

  it("a day with no readable date stores nothing at all", async () => {
    days = [...days.map((d) => ({ ...d, signups: 4 })), { nonsense: true } as any];
    fake();
    const runs = (await q("select count(*)::int n from import_runs where source_id = 'pull.perksradar'"))[0].n;
    const r = await pullPerksradar("test", TODAY);
    expect(r.outcome).toBe("incomplete");
    expect(r.problems.join(" ")).toMatch(/unexpected format; nothing was stored/);
    expect((await q("select count(*)::int n from import_runs where source_id = 'pull.perksradar'"))[0].n).toBe(runs);
    days = days.filter((d: any) => d.date).map((d) => ({ ...d, signups: 2 }));
  });

  it("a page that can't be read stores nothing and reports the problem", async () => {
    days = days.map((d) => ({ ...d, signups: 3 }));
    failPage = 1;
    fake();
    const before = (await q("select count(*)::int n from import_runs where source_id = 'pull.perksradar'"))[0].n;
    const r = await pullPerksradar("test", TODAY);
    expect(r.outcome).toBe("incomplete");
    expect(r.problems.join(" ")).toMatch(/page 2 could not be read/);
    expect((await q("select count(*)::int n from import_runs where source_id = 'pull.perksradar'"))[0].n).toBe(before);
  });

  it("a refused credential fails the pull without storing anything", async () => {
    process.env.PERKSRADAR_REPORTING_SECRET = "x".repeat(40);
    fake();
    const r = await pullPerksradar("test", TODAY);
    expect(r.outcome).toBe("incomplete");
    expect(r.problems.join(" ")).toMatch(/refused the reporting credential/);
    process.env.PERKSRADAR_REPORTING_SECRET = SECRET;
  });
});
