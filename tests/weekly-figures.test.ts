// Weekly figures: the EOS scorecard's week columns fill weeks the weekly report submission hasn't sent, the submission
// wins where both have a week, a missing week is named in the status, and a card with nothing for its dates shows the
// latest earlier figure (never counted). Invented layout and synthetic figures only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, closePool, q } from "./helpers";
import { envelope, scorecardLayout } from "./fixtures/synthetic";
import { applyPulled } from "../server/adapters/pullApply";
import { parseEosWeeks, weekHeader } from "../shared/scorecardParse";
import { dueReportWeek } from "../shared/dates";
import { missingWeeklyFigures } from "../server/routes/dashboard";
import { runSheetSync } from "../server/sheetSync";
import { dueReportWeek as due, todayIn, OPERATIONS_TZ, addDays } from "../shared/dates";

const L = scorecardLayout as any;

describe("scorecard week columns (invented layout)", () => {
  const sheet = (rows: any[][]) => ({ name: "2030", rows: [[], [],
    [null, null, "OCT", null, "OCT 1-31", "NOV", null, null],
    [null, null, "Oct 19 - 25", "Oct 26 - Nov 1", "Month total", "Nov 2 - 8", "Nov 9 - 15", "Nov 16 - 22"], ...rows] });

  it("reads week headers, across months and New Year, and only 7-day spans", () => {
    expect(weekHeader("Oct 31 - Nov 6", 2026, 11)).toEqual({ start: "2026-10-31", end: "2026-11-06" });
    expect(weekHeader("Nov 7 - 13", 2026, 11)).toEqual({ start: "2026-11-07", end: "2026-11-13" });
    expect(weekHeader("Dec 27 - Jan 2", 2027, 1)).toEqual({ start: "2026-12-27", end: "2027-01-02" });   // under JAN of the next year's tab
    expect(weekHeader("Dec 26 - Jan 1", 2026, 12)).toEqual({ start: "2026-12-26", end: "2027-01-01" });  // under DEC
    expect(weekHeader("Nov 1 - 3", 2026, 11)).toBeNull();                                               // not a week
    expect(weekHeader("TOTAL (MONTH)", 2026, 11)).toBeNull();
  });

  it("sends funnel rates and ad spend for weeks that have ended; blanks are never zero; month totals are not weeks", () => {
    const s = sheet([["Sales", "Everything", 100, 110, 400, 120, 130, 140],
      ["Funnel", "Carts", 0.05, 0.051, 0.05, 0.052, 0.049, null], [null, "Orders placed", 0.009, 0.0085, 0.009, 0.008, 0.0077, null],
      ["Advertising", "Google spend", 10, 11, 40, 12, null, null], [null, "Meta spend", 5, null, 20, 6, null, null],
      [null, "Ad total", 15, 11, 60, 18, 0, 0], [null, "Second business", 3, null, 9, 4, null, null]]);
    const out = parseEosWeeks([s], L, { today: "2030-11-20" });
    const sb = (start: string) => out.find((b) => b.business === "sb" && b.start === start);
    expect(out.map((b) => `${b.business} ${b.start}`)).toEqual(["sb 2030-10-19", "p2s 2030-10-19", "sb 2030-10-26", "sb 2030-11-02", "p2s 2030-11-02", "sb 2030-11-09"]);
    expect(sb("2030-11-02")!.observations.map((o) => [o.metric, o.scope, o.value, o.granularity])).toEqual([
      ["add_to_cart_rate", "all", 0.052, "week"], ["conversion_rate", "all", 0.008, "week"],
      ["ad_spend", "platform:google", 12, "week"], ["ad_spend", "platform:facebook", 6, "week"], ["ad_spend", "all", 18, "week"]]);
    // Nov 9-15: rates filled, ad rows blank: no ad spend at all (the total formula's 0 is not a figure).
    expect(sb("2030-11-09")!.observations.map((o) => o.metric)).toEqual(["add_to_cart_rate", "conversion_rate"]);
    // Nov 16-22 hasn't ended on Nov 20: not read. Revenue is never read from week columns.
    expect(out.some((b) => b.start === "2030-11-16")).toBe(false);
    expect(out.flatMap((b) => b.observations).some((o) => o.metric === "revenue")).toBe(false);
  });

  it("the reporting week due by a date: Saturday to Friday, from the Tuesday after", () => {
    expect(dueReportWeek("2026-11-20")).toEqual({ start: "2026-11-07", end: "2026-11-13" });   // Friday
    expect(dueReportWeek("2026-11-17")).toEqual({ start: "2026-11-07", end: "2026-11-13" });   // Tuesday: due
    expect(dueReportWeek("2026-11-16")).toEqual({ start: "2026-10-31", end: "2026-11-06" });   // Monday: not yet
    expect(dueReportWeek("2026-11-14")).toEqual({ start: "2026-10-31", end: "2026-11-06" });   // Saturday
  });
});

describe("weekly figures in the dashboard", () => {
  const wk = { start: "2030-11-02", end: "2030-11-08" };
  let post: (b: any) => Promise<any>;
  /** The EOS scorecard's week column as the sheet sync stores it. */
  const eosWeek = (business: "sb" | "p2s", start: string, end: string, obs: any[], tag = "a") =>
    applyPulled({ schema_version: 1, submission_id: `eosw:${business}:${start}:${tag}`, source: "eos_scorecard", business,
      period: { start, end, granularity: "week", timezone: "America/Los_Angeles" }, collected_at: "2030-11-20T08:00:00Z", completeness: "complete",
      records: { observations: obs.map((o) => ({ scope: "all", period_start: start, period_end: end, granularity: "week", ...o })) } },
      `eosw:${business}:${start}`, { sourceId: "sheet.eos_scorecard", submitter: "sheet:test", submissionSource: "eos_scorecard" }, "test");
  const card = async (business: string, key: string, r = wk) =>
    (await call("viewer", "GET", `/business/${business}/summary?start=${r.start}&end=${r.end}&compare=none`)).body.metrics.find((x: any) => x.key === key);

  beforeAll(async () => {
    await freshDb();
    const token = (await call("admin", "POST", "/settings/automation-clients", { label: "Weekly", sources: ["weekly_report"], businesses: ["sb", "p2s"] })).body.token as string;
    post = (b: any) => call(null, "POST", "/submissions", b, { authorization: `Bearer ${token}` });
  });

  it("the scorecard week fills ad spend and the conversion rate when the weekly report hasn't sent the week", async () => {
    expect((await eosWeek("sb", wk.start, wk.end, [{ metric: "ad_spend", value: 1665.05 }, { metric: "conversion_rate", value: 0.0085 }])).outcome).toBe("accepted");
    expect((await eosWeek("p2s", wk.start, wk.end, [{ metric: "ad_spend", value: 202.29 }])).outcome).toBe("accepted");
    expect((await card("sb", "ad_spend")).value).toMatchObject({ state: "value", value: 1665.05 });
    expect((await card("p2s", "ad_spend")).value).toMatchObject({ state: "value", value: 202.29 });
    const conv = await card("sb", "conversion_rate");
    expect(conv.value).toMatchObject({ state: "value", value: 0.0085, note: "Week figure from the EOS scorecard" });
  });

  it("where the weekly report has the same week, it is used (never added to the scorecard, never Missing)", async () => {
    const r = await post({ ...envelope("wr-1102", "sb", wk), records: { observations: [
      { metric: "ad_spend", value: 1700 }, { metric: "sessions", value: 10000 }, { metric: "sessions_converted", value: 90 }] } });
    expect(r.status).toBe(201);
    expect((await card("sb", "ad_spend")).value).toMatchObject({ state: "value", value: 1700 });
    // Counts for the week win over the reported rate.
    expect((await card("sb", "conversion_rate")).value).toMatchObject({ state: "value", value: 0.009 });
    // Two sources of the same rank still conflict.
    const t2 = (await call("admin", "POST", "/settings/automation-clients", { label: "Other", sources: ["weekly_report"], businesses: ["p2s"] })).body.token as string;
    await call(null, "POST", "/submissions", { ...envelope("wr-p2s-a", "p2s", wk), records: { observations: [{ metric: "ad_spend", value: 210 }] } }, { authorization: `Bearer ${t2}` });
    await q("update observations set source_id = 'manual.upload' where business_id = 'p2s' and source_id = 'submission.api'");
    await post({ ...envelope("wr-p2s-b", "p2s", wk), records: { observations: [{ metric: "ad_spend", value: 220 }] } });
    expect((await card("p2s", "ad_spend")).value.state).toBe("missing");
  });

  it("a card with nothing for its dates shows the latest earlier figure, labelled and not counted", async () => {
    const next = { start: "2030-11-09", end: "2030-11-15" };
    const ad = await card("sb", "ad_spend", next);
    expect(ad.value.state).toBe("missing");
    expect(ad.latest).toMatchObject({ period: wk, granularity: "week", value: { value: 1700 }, earlier: true, outside: [] });
    // Nothing within about two months: no latest figure.
    expect((await card("sb", "ad_spend", { start: "2031-03-01", end: "2031-03-07" })).latest).toBeUndefined();
  });

  it("the status names the week whose figures are due but not received", async () => {
    // Nov 2-8, 2030 is due from Tuesday Nov 12.
    expect(dueReportWeek("2030-11-12")).toEqual(wk);
    expect((await missingWeeklyFigures("2030-11-12")).missing).toEqual([]);   // sb ad spend + sessions, p2s ad spend: all there
    const r = await missingWeeklyFigures("2030-11-19");                     // Nov 9-15: nothing yet
    expect(r.week).toMatchObject({ start: "2030-11-09", end: "2030-11-15" });
    expect(r.missing).toEqual(["Succulents Box advertising spend", "Succulents Box sessions / conversion rate", "P2S advertising spend"]);
    // A scorecard conversion rate alone counts as received for the conversion figure.
    await eosWeek("sb", "2030-11-09", "2030-11-15", [{ metric: "conversion_rate", value: 0.0077 }]);
    expect((await missingWeeklyFigures("2030-11-19")).missing).toEqual(["Succulents Box advertising spend", "P2S advertising spend"]);
    const status = (await call("viewer", "GET", "/status")).body;
    expect(status.weekly).toHaveProperty("week");
    expect(Array.isArray(status.weekly.missing)).toBe(true);
  });
});

describe("the scorecard sync sends recent week columns as week figures", () => {
  it("one submission per business and finished week; older weeks and unfinished weeks are not sent; re-sync is unchanged", async () => {
    await freshDb();
    process.env.SCORECARD_LAYOUT = JSON.stringify(scorecardLayout);
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const lbl = (w: { start: string; end: string }) => {
      const [, m1, d1] = w.start.split("-").map(Number), [, m2, d2] = w.end.split("-").map(Number);
      return m1 === m2 ? `${M[m1 - 1]} ${d1} - ${d2}` : `${M[m1 - 1]} ${d1} - ${M[m2 - 1]} ${d2}`;
    };
    const w = due(todayIn(OPERATIONS_TZ));
    const old = { start: addDays(w.start, -210), end: addDays(w.end, -210) };   // 30 weeks back: older than six months
    const tab = (wk: { start: string; end: string }, rate: number, google: number, p2sAd: number) => ({ name: wk.end.slice(0, 4), rows: [[], [],
      [null, null, M[Number(wk.end.slice(5, 7)) - 1].toUpperCase()], [null, null, lbl(wk)],
      ["Sales", "Everything", 1], ["Funnel", "Orders placed", rate], ["Advertising", "Google spend", google], [null, "Ad total", google], [null, "Second business", p2sAd]] });
    const sheets = old.end.slice(0, 4) === w.end.slice(0, 4)
      ? [{ ...tab(w, 0.0077, 12, 4), rows: tab(w, 0.0077, 12, 4).rows.map((r, i) => (i < 2 ? r : [...r.slice(0, 2), tab(old, 0.01, 5, 1).rows[i][2], r[2]])) }]
      : [tab(old, 0.01, 5, 1), tab(w, 0.0077, 12, 4)];
    const src = (await q("insert into sheet_sources (business_id, role, label, file_id, file_kind, created_by) values ('sb', 'eos_scorecard', 'EOS', 'TESTeosFILEid0000000000009', 'google_sheet', 't') returning id"))[0].id;
    const r1: any = await runSheetSync(src, "manual", "t", async () => sheets as any);
    expect(r1.outcome).toBe("succeeded");
    const weekRows = await q("select business_id, metric_key, scope_key, value::float8 v from observations where source_id = 'sheet.eos_scorecard' and granularity = 'week' order by 1, 2, 3");
    expect(weekRows.map((r: any) => [r.business_id, r.metric_key, r.scope_key, r.v])).toEqual([
      ["p2s", "ad_spend", "all", 4], ["sb", "ad_spend", "all", 12], ["sb", "ad_spend", "platform:google", 12], ["sb", "conversion_rate", "all", 0.0077]]);
    expect((await q("select distinct to_char(period_start,'YYYY-MM-DD') s from observations where granularity = 'week'"))[0].s).toBe(w.start);
    const r2: any = await runSheetSync(src, "manual", "t", async () => sheets as any);
    expect(r2.receipts.filter((x: any) => /week/.test(x.label)).every((x: any) => x.outcome === "unchanged")).toBe(true);
    // Ad spend for both businesses and the conversion rate arrived for the due week: nothing is reported missing.
    expect((await missingWeeklyFigures(todayIn(OPERATIONS_TZ))).missing).toEqual([]);
  });
});

afterAll(closePool);
