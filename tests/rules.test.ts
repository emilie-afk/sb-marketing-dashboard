// Pure rules: dates and comparisons, coverage, weighted ratios, value states, scope, recurrence, listing rules.
import { describe, it, expect, beforeEach } from "vitest";
import { comparisonPeriod, equivalentElapsed, shiftMonths, addDays } from "../shared/dates";
import { resolveCoverage, latestRollingChecks, overlapShare } from "../shared/coverage";
import { sumFigs, ratio, weightedRatio, purchaseCpa, change, fig, missing, notApplicable, formatChange, formatFig } from "../shared/metrics";
import { totalWithBreakdown, dedupeTransactions, isExcludedBrand, rankingScopeLabel } from "../shared/scope";
import { occurrences } from "../shared/recurrence";
import { comparable, pricePosition, applyCorrections, canApprove, sampleLabel } from "../shared/listingReview";
import { parseDateText } from "../shared/sheetDates";
import { checkSubmission } from "../shared/submission";

describe("comparison periods", () => {
  it("previous equivalent period has the same length, immediately before", () => {
    expect(comparisonPeriod({ start: "2026-10-24", end: "2026-10-30" }, "previous_period")).toMatchObject({ start: "2026-10-17", end: "2026-10-23" });
  });
  it("same dates last month clamps to month end", () => {
    const c = comparisonPeriod({ start: "2026-03-29", end: "2026-03-31" }, "same_dates_last_month");
    expect(c).toMatchObject({ start: "2026-02-28", end: "2026-02-28", clamped: true });
  });
  it("whole months compare with whole months (Mar to Feb, both lengths)", () => {
    expect(comparisonPeriod({ start: "2026-03-01", end: "2026-03-31" }, "same_dates_last_month")).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(comparisonPeriod({ start: "2025-03-01", end: "2025-03-31" }, "same_dates_last_year")).toMatchObject({ start: "2024-03-01", end: "2024-03-31" });
  });
  it("leap day maps to Feb 28 last year; Feb 28 maps back to Feb 28", () => {
    expect(shiftMonths("2028-02-29", -12)).toEqual({ date: "2027-02-28", clamped: true });
    expect(comparisonPeriod({ start: "2028-02-29", end: "2028-02-29" }, "same_dates_last_year")).toMatchObject({ start: "2027-02-28", clamped: true });
    expect(comparisonPeriod({ start: "2028-02-01", end: "2028-02-29" }, "same_dates_last_year")).toMatchObject({ start: "2027-02-01", end: "2027-02-28" });
  });
  it("partial periods compare equivalent elapsed days", () => {
    const cur = { start: "2026-11-01", end: "2026-11-30" };
    const e = equivalentElapsed(cur, comparisonPeriod(cur, "same_dates_last_month"), "2026-11-10");
    expect(e).toMatchObject({ partial: true, elapsedDays: 10, current: { start: "2026-11-01", end: "2026-11-10" }, comparison: { start: "2026-10-01", end: "2026-10-10" } });
  });
});

describe("source date coverage", () => {
  const weeks = [{ start: "2026-10-17", end: "2026-10-23", granularity: "week" as const }, { start: "2026-10-24", end: "2026-10-30", granularity: "week" as const }];
  it("weekly data supports its own weeks and unions of them", () => {
    expect(resolveCoverage({ start: "2026-10-17", end: "2026-10-30" }, weeks).status).toBe("supported");
  });
  it("weekly data does not support an arbitrary range and never splits into days", () => {
    const r = resolveCoverage({ start: "2026-10-20", end: "2026-10-26" }, weeks);
    expect(r.status).toBe("unsupported");
    expect((r as any).reason).toMatch(/never split/);
  });
  it("weeks count toward a range only by their calendar days; a week running past it is a gap, never split", () => {
    const satFri = ["2026-10-31", "2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"].map((s) => ({ start: s, end: addDays(s, 6), granularity: "week" as const }));
    const nov = resolveCoverage({ start: "2026-11-01", end: "2026-11-30" }, satFri) as any;
    expect(nov.status).toBe("gaps");
    // Oct 31 – Nov 6 has a day in October, so it isn't counted in November; nor is Nov 28 – Dec 4.
    expect(nov.periods.map((p: any) => p.start)).toEqual(["2026-11-07", "2026-11-14", "2026-11-21"]);
    expect(nov.missingDays).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-28", "2026-11-29", "2026-11-30"]);
    expect(nov.note).toMatch(/9 days \(Nov 1 – 6, 2026, Nov 28 – 30, 2026\)|9 days/);
    expect(resolveCoverage({ start: "2026-10-31", end: "2026-11-06" }, satFri).status).toBe("supported");
    expect(resolveCoverage({ start: "2026-11-07", end: "2026-11-27" }, satFri).status).toBe("supported");
    expect(resolveCoverage({ start: "2026-11-03", end: "2026-11-05" }, satFri).status).toBe("unsupported");
  });
  it("month totals answer a whole month first, then daily figures, then whole weeks", () => {
    const weeks = ["2026-10-31", "2026-11-07"].map((s) => ({ start: s, end: addDays(s, 6), granularity: "week" as const }));
    const days = ["2026-11-01", "2026-11-02"].map((d) => ({ start: d, end: d, granularity: "day" as const }));
    const months = [{ start: "2026-10-01", end: "2026-10-31", granularity: "month" as const }, { start: "2026-11-01", end: "2026-11-30", granularity: "month" as const }];
    const oct = resolveCoverage({ start: "2026-10-01", end: "2026-10-31" }, [...weeks, ...months, ...days]) as any;
    expect(oct).toMatchObject({ status: "supported", granularity: "month" });
    expect(resolveCoverage({ start: "2026-10-01", end: "2026-11-30" }, months)).toMatchObject({ status: "supported", granularity: "month" });
    expect(resolveCoverage({ start: "2026-11-01", end: "2026-11-02" }, [...weeks, ...months, ...days])).toMatchObject({ status: "supported", granularity: "day" });
    // Part of a month with only weekly totals: whole weeks inside the range, the rest reported as gaps.
    expect(resolveCoverage({ start: "2026-11-07", end: "2026-11-13" }, [...weeks, ...months])).toMatchObject({ status: "supported", granularity: "week" });
  });
  it("partial daily figures never hide whole weeks: each date counted once", () => {
    const weeks = [{ start: "2026-11-07", end: "2026-11-13", granularity: "week" as const }, { start: "2026-11-14", end: "2026-11-20", granularity: "week" as const }];
    const oneDay = [{ start: "2026-11-09", end: "2026-11-09", granularity: "day" as const }];
    const r = resolveCoverage({ start: "2026-11-07", end: "2026-11-20" }, [...weeks, ...oneDay]) as any;
    expect(r).toMatchObject({ status: "supported", granularity: "week" });
    expect(r.periods.map((p: any) => `${p.granularity}:${p.start}`)).toEqual(["week:2026-11-07", "week:2026-11-14"]);
    // A week reported for every one of its days uses the days; the other week its total.
    const allDays = Array.from({ length: 7 }, (_, i) => ({ start: addDays("2026-11-07", i), end: addDays("2026-11-07", i), granularity: "day" as const }));
    const r2 = resolveCoverage({ start: "2026-11-07", end: "2026-11-20" }, [...weeks, ...allDays]) as any;
    expect(r2.status).toBe("supported");
    expect(r2.periods.map((p: any) => `${p.granularity}:${p.start}`)).toEqual([...allDays.map((d) => `day:${d.start}`), "week:2026-11-14"]);
    // Days outside any whole week fill in around it; the rest are gaps.
    const r3 = resolveCoverage({ start: "2026-11-06", end: "2026-11-13" }, [...weeks, { start: "2026-11-06", end: "2026-11-06", granularity: "day" as const }]) as any;
    expect(r3).toMatchObject({ status: "supported" });
    expect(r3.periods.map((p: any) => p.start)).toEqual(["2026-11-06", "2026-11-07"]);
  });
  it("a day row marked missing keeps the week total; a valid zero day does not", () => {
    const week = [{ start: "2026-11-07", end: "2026-11-13", granularity: "week" as const, known: true }];
    const days = (missingOn: string | null) => Array.from({ length: 7 }, (_, i) => addDays("2026-11-07", i))
      .map((d) => ({ start: d, end: d, granularity: "day" as const, known: d !== missingOn }));
    const r = resolveCoverage({ start: "2026-11-07", end: "2026-11-13" }, [...week, ...days("2026-11-10")]) as any;
    expect(r).toMatchObject({ status: "supported", granularity: "week" });
    expect(r.periods).toHaveLength(1);
    const z = resolveCoverage({ start: "2026-11-07", end: "2026-11-13" }, [...week, ...days(null)]) as any;
    expect(z).toMatchObject({ status: "supported", granularity: "day" });
  });
  it("work counts of a period running past the range are prorated by its days", () => {
    expect(overlapShare({ start: "2026-10-31", end: "2026-11-06" }, { start: "2026-11-01", end: "2026-11-30" })).toBeCloseTo(6 / 7);
    expect(overlapShare({ start: "2026-10-31", end: "2026-11-06" }, { start: "2026-10-01", end: "2026-10-31" })).toBeCloseTo(1 / 7);
    expect(overlapShare({ start: "2026-11-07", end: "2026-11-13" }, { start: "2026-11-01", end: "2026-11-30" })).toBe(1);
    expect(overlapShare({ start: "2026-12-05", end: "2026-12-11" }, { start: "2026-11-01", end: "2026-11-30" })).toBe(0);
  });
  it("daily data supports arbitrary ranges and reports gaps", () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-04"].map((d) => ({ start: d, end: d, granularity: "day" as const }));
    expect(resolveCoverage({ start: "2026-10-01", end: "2026-10-02" }, days).status).toBe("supported");
    const g = resolveCoverage({ start: "2026-10-01", end: "2026-10-04" }, days);
    expect(g.status).toBe("gaps");
    expect((g as any).missingDays).toEqual(["2026-10-03"]);
  });
  it("overlapping rolling 30-day checks are never added together", () => {
    const rolling = [{ start: "2026-09-27", end: "2026-10-26", granularity: "rolling_30" as const }, { start: "2026-10-04", end: "2026-11-02", granularity: "rolling_30" as const }];
    expect(resolveCoverage({ start: "2026-09-27", end: "2026-11-02" }, rolling).status).toBe("unsupported");
    expect(resolveCoverage({ start: "2026-10-04", end: "2026-11-02" }, rolling).status).toBe("supported");
    const latest = latestRollingChecks([{ key: "L1", start: "2026-09-27", end: "2026-10-26", collectedAt: "a" }, { key: "L1", start: "2026-10-04", end: "2026-11-02", collectedAt: "b" }]);
    expect(latest).toHaveLength(1);
    expect(latest[0].end).toBe("2026-11-02");
  });
});

describe("missing, zero, not applicable, incomplete", () => {
  it("zero is a value; missing parts make totals incomplete", () => {
    expect(sumFigs([fig(0), fig(5)])).toEqual(fig(5));
    expect(sumFigs([fig(0), missing()]).state).toBe("incomplete");
    expect(sumFigs([notApplicable(), notApplicable()]).state).toBe("not_applicable");
    expect(formatFig(missing(), "currency")).toBe("Missing");
    expect(formatFig(fig(0), "currency")).toBe("$0.00");
  });
  it("submissions cannot send 0 for an unknown value or a cost-missing gross profit", () => {
    const base = { schema_version: 1, submission_id: "s-1", source: "x1", business: "sb", period: { start: "2026-10-01", end: "2026-10-07", granularity: "week", timezone: "America/Los_Angeles" }, collected_at: "2026-10-08T00:00:00Z", completeness: "complete" };
    const r = checkSubmission({ ...base, records: { observations: [{ metric: "revenue", value: null, state: "value" }, { metric: "orders", value: 3, state: "missing" }],
      products: [{ external_id: "p", title: "P", channel_scope: "channel:x", revenue: 10, units: 1, gross_profit: 0, cost_state: "missing" }] } });
    expect(r.ok && r.value.rejected.map((x) => x.kind)).toEqual(["observations", "observations", "products"]);
  });
});

describe("weighted ratios and changes", () => {
  it("ratios come from matching sums, not averages of ratios", () => {
    // Two weeks: 10/100 and 90/100 orders per session -> 100/200 = 0.5 (average of ratios would also be 0.5; use uneven weights)
    const r = weightedRatio([{ num: fig(1), den: fig(10) }, { num: fig(90), den: fig(100) }]);
    expect(r.value).toBeCloseTo(91 / 110);
    expect(r.value).not.toBeCloseTo((0.1 + 0.9) / 2);
    expect(ratio(fig(10), fig(0)).state).toBe("not_applicable");
  });
  it("CPA below one purchase shows N/A (<1 purchase)", () => {
    expect(purchaseCpa(fig(14.2), fig(0.5))).toMatchObject({ display: "N/A (<1 purchase)" });
    expect(purchaseCpa(fig(100), fig(4)).value).toBe(25);
  });
  it("rates change in percentage points; other figures in absolute and percent", () => {
    const pp = change(fig(0.0098), fig(0.0087), "percent", "up");
    expect(pp.percentagePoints).toBeCloseTo(0.11);
    expect(pp.percent).toBeNull();
    expect(formatChange(pp, "percent")).toBe("+0.11 pp");
    const c = change(fig(150), fig(100), "currency", "up");
    expect(c).toMatchObject({ absolute: 50, percent: 50 });
    expect(formatChange(c, "currency")).toBe("+$50.00 (+50.0%)");
  });
  it("increases in CPA or bot traffic are not good", () => {
    expect(change(fig(12), fig(10), "currency", "down").sentiment).toBe("bad");
    expect(change(fig(5000), fig(3000), "count", "down").sentiment).toBe("bad");
  });
  it("negative prior uses |prior|, zero prior is 'new'", () => {
    expect(change(fig(0), fig(-20), "currency", "up").percent).toBe(100);
    expect(change(fig(25), fig(0), "currency", "up").label).toBe("new");
  });
});

describe("channel overlap and total scope", () => {
  beforeEach(() => {
    process.env.EXCLUDED_BRANDS = "Excluded Demo Brand";
    process.env.TRACKED_CHANNELS = "online_store:Shopify website,amazon:Amazon";
  });
  it("the business total is independent of the tracked-channel breakdown", () => {
    const t = totalWithBreakdown({ revenue: 1000, orders: 30 }, [
      { scope: "channel:online_store", label: "Shopify website", revenue: 700, orders: 20 },
      { scope: "channel:amazon", label: "Amazon", revenue: 200, orders: 8 },
      { scope: "channel:other_box", label: "Other subscription channel", revenue: 50, orders: 1 },      // not tracked
      { scope: "channel:corporate", label: "Corporate", revenue: 400, orders: 2 },   // overlaps, never added
    ]);
    expect(t.total.revenue).toBe(1000);
    expect(t.tracked.map((c) => c.label)).toEqual(["Shopify website", "Amazon"]);
    expect(t.tracked.some((c) => c.label === "Corporate")).toBe(false);
    expect(t.otherRevenue).toBe(100);
  });
  it("de-duplicates mirrored marketplace orders but keeps distinct sales of the same product", () => {
    const { lines, duplicates } = dedupeTransactions([
      { source: "amazon", orderId: "111-1", canonicalOrderId: "111-1", productKey: "p1", channel: "amazon", revenue: 20, units: 1 },
      { source: "shopify", orderId: "#5001", canonicalOrderId: "111-1", productKey: "p1", channel: "amazon (mirrored)", revenue: 20, units: 1 },
      { source: "shopify", orderId: "#5002", productKey: "p1", channel: "online_store", revenue: 20, units: 1 },
      { source: "amazon", orderId: "111-2", canonicalOrderId: "111-2", productKey: "p1", channel: "amazon", revenue: 20, units: 1 },
      { source: "shopify", orderId: "#9", productKey: "p9", channel: "Excluded Demo Brand", revenue: 99, units: 1 },
    ]);
    expect(lines).toHaveLength(3);
    expect(duplicates).toHaveLength(1);
    expect(isExcludedBrand("excluded demo brand store")).toBe(true);
    expect(isExcludedBrand("Another brand")).toBe(false);
  });
  it("rankings state their channel scope", () => {
    expect(rankingScopeLabel(["channel:online_store"])).toBe("Covers Shopify website only");
    expect(rankingScopeLabel([])).toBe("Channel scope not stated");
  });
});

describe("recurring tasks", () => {
  it("weekly and monthly occurrences, month-end safe", () => {
    expect(occurrences("weekly:1", "2026-10-26", { start: "2026-11-01", end: "2026-11-30" })).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
    expect(occurrences("monthly:31", "2026-01-31", { start: "2026-02-01", end: "2026-04-30" })).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(occurrences(null, "2026-11-05", { start: "2026-11-01", end: "2026-11-30" })).toEqual(["2026-11-05"]);
    expect(occurrences("daily", "2026-11-01", { start: "2026-11-01", end: "2026-11-10" }, "2026-11-03")).toHaveLength(3);
  });
});

describe("listing review rules", () => {
  it("compares equivalent options only; a 'from' price is never compared", () => {
    expect(comparable({ label: "d", format: "digital", price: 6 }, { label: "p", format: "printed", price: 30 })).toBe(false);
    expect(comparable({ label: "d", format: "digital", pages: 1, price: 6 }, { label: "f", format: "digital", price: 1.5, price_basis: "from_price" })).toBe(false);
    expect(comparable({ label: "a", format: "printed", pages: 12, price: 30 }, { label: "b", format: "printed", pages: 24, price: 40 })).toBe(false);
    const pos = pricePosition({ label: "d", format: "digital", pages: 1, price: 6.5 }, [
      { id: "1", label: "a", format: "digital", pages: 1, price: 8.5 }, { id: "2", label: "b", format: "digital", pages: 1, price: 9 },
      { id: "3", label: "c", format: "digital", price: 1.5, price_basis: "from_price" }, { id: "4", label: "p", format: "printed", pages: 1, price: 30 }]);
    expect(pos).toMatchObject({ position: "below", comparableCount: 2, medianUnit: 8.75 });
  });
  it("pack quantities compare per unit", () => {
    const pos = pricePosition({ label: "3 pack", format: "physical", pack_qty: 3, price: 30 }, [{ id: "1", label: "single", format: "physical", price: 10 }]);
    expect(pos.position).toBe("at");
  });
  it("corrections supersede and flag dependents (transitively); flagged findings cannot be approved", () => {
    const r = applyCorrections([
      { key: "a", state: "active", depends_on: [], is_suggestion: false },
      { key: "b", state: "active", depends_on: ["a"], is_suggestion: true },
      { key: "c", state: "active", depends_on: ["b"], is_suggestion: true },
      { key: "d", state: "active", depends_on: [], is_suggestion: false },
    ], [{ supersedes: "a", reason: "wrong price" }]);
    expect(r.superseded).toEqual(["a"]);
    expect(r.flagged.sort()).toEqual(["b", "c"]);
    expect(canApprove(r.findings.find((f) => f.key === "b")!).ok).toBe(false);
    expect(canApprove(r.findings.find((f) => f.key === "d")!).ok).toBe(true);
  });
  it("market statistics are labelled as a sample", () => {
    expect(sampleLabel({ sample_size: 48, sampling_scope: "first page", keyword: "k" })).toMatch(/Sample of 48 .*Not the whole market/);
  });
  it("submission requires sample size with market statistics and no metrics on a fallback phrase", () => {
    const lr = { run_id: "r-1", window_start: "2026-10-01", window_end: "2026-10-30", scope_note: "x", listings: [],
      keywords: [{ listing_id: "1000000001", keyword: "k", kind: "reported", median_price: 5 }, { listing_id: "1000000001", keyword: "t", kind: "fallback_title_phrase", clicks: 3 }] };
    const r = checkSubmission({ schema_version: 1, submission_id: "x-1", source: "etsy", business: "p2s", period: { start: "2026-10-01", end: "2026-10-30", granularity: "rolling_30", timezone: "UTC" }, collected_at: "2026-10-31T00:00:00Z", completeness: "complete", records: { listing_review: lr } });
    expect(r.ok && r.value.rejected[0].errors.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/sample_size/), expect.stringMatching(/fallback/)]));
  });
});

describe("spreadsheet date text", () => {
  it.each([
    ["Nov 1–12, 2026", "2026-11-01", "2026-11-12"], ["26-Nov", "2026-11-26", "2026-11-26"], ["Nov 26–Jan 1", "2026-11-26", "2027-01-01"],
    ["Jan 22 - Feb 5", "2026-01-22", "2026-02-05"], ["Fri, Dec 4, 2026", "2026-12-04", "2026-12-04"], ["Nov 26, 2026–Jan 1, 2027", "2026-11-26", "2027-01-01"],
  ])("%s", (t, s, e) => expect(parseDateText(t, 2026)).toMatchObject({ ok: true, start: s, end: e }));
  it("lists of dates are flagged; text is not invented into a date", () => {
    expect(parseDateText("Nov 27 / Nov 30, 2026", 2026)).toMatchObject({ multiple: ["2026-11-27", "2026-11-30"] });
    expect(parseDateText("Existing baseline offer period", 2026).ok).toBe(false);
    expect(parseDateText("Feb 30", 2026).ok).toBe(false);
  });
});

describe("Daily Analytics Report and EOS scorecard layouts", () => {
  it("reads month tabs with irregular spacing and leaves out months that haven't ended", async () => {
    const { monthTab, parseEosMonths, amount } = await import("../shared/scorecardParse");
    expect(monthTab("October  2026")).toEqual({ y: 2026, m: 10 });
    expect(monthTab("Sep 2024")).toEqual({ y: 2024, m: 9 });
    expect(monthTab("Summary")).toBeNull();
    expect(amount("$1,389.62")).toBe(1389.62);
    expect(amount("No data")).toBeNull();
    expect(amount("#DIV/0!")).toBeNull();
    const sheet = { name: "2026", rows: [[], [], [null, null, "OCT 1-31", "NOV 1-30"], [null, null, "TOTAL (MONTH)", "TOTAL (MONTH)"], ["Revenue", "All", 100, 50], ["Ads Spent", "Google Ads SB", 10, null], [null, "Total Ad spent (Succulents Box)", 10, 0]] };
    const out = parseEosMonths([sheet], { today: "2026-11-13" });
    expect(out.map((b) => b.month)).toEqual(["2026-10"]);       // November's column isn't final until the month ends
  });
});
