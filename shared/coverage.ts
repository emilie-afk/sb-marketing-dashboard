// Decides whether a requested date range can be answered from the periods a source actually has.
// Every figure counts toward the calendar days it covers. A weekly total that runs past the range is never split
// into invented daily values: the range is answered from daily data or exact monthly totals instead, or the days the
// week covers are reported as a gap. Rolling checks are never added.
import { DateRange, addDays, eachDay, formatRange } from "./dates";

export type Granularity = "day" | "week" | "month" | "rolling_30" | "custom";
/** known: false marks a stored row whose figure is missing or incomplete (zero is a known figure). */
export type AvailablePeriod = DateRange & { granularity: Granularity; completeness?: string; known?: boolean };

export type CoverageResult =
  | { status: "supported"; granularity: Granularity; periods: AvailablePeriod[]; partial: boolean; note?: string }
  | { status: "gaps"; granularity: "day" | "week"; periods: AvailablePeriod[]; missingDays: string[]; note: string }
  | { status: "unsupported"; reason: string; nearest?: DateRange[] };

/** Whether a stored period counts toward a requested range: all of its days must be inside the range. */
export function periodWithin(p: DateRange & { granularity?: string }, req: DateRange) {
  return p.start >= req.start && p.end <= req.end;
}
/** The share of a period's calendar days that fall inside a range (0 to 1). Used only for work counts. */
export function overlapShare(p: DateRange, req: DateRange) {
  const s = p.start > req.start ? p.start : req.start, e = p.end < req.end ? p.end : req.end;
  if (e < s) return 0;
  return eachDay({ start: s, end: e }).length / eachDay(p).length;
}
const spans = (days: string[]) => {
  const out: DateRange[] = [];
  for (const d of days) { const last = out[out.length - 1]; if (last && addDays(last.end, 1) === d) last.end = d; else out.push({ start: d, end: d }); }
  return out.map(formatRange).join(", ");
};
/** Stored periods of one granularity that exactly tile the range (consecutive, no overlap, no gap), or null. */
function exactUnion(req: DateRange, agg: AvailablePeriod[]) {
  const inside = agg.filter((p) => periodWithin(p, req)).sort((a, b) => (a.start < b.start ? -1 : 1));
  let cursor = req.start;
  for (const p of inside) { if (p.start !== cursor) return null; cursor = addDays(p.end, 1); }
  return inside.length && addDays(req.end, 1) === cursor ? inside : null;
}

/**
 * In order:
 * 1. Monthly (or fixed-period) totals that exactly make up the range, e.g. the EOS scorecard's month totals.
 * 2. Otherwise daily figures and weekly totals lying wholly inside the range, each date counted once: a week is used
 *    unless every one of its days is reported by day with a known figure (a missing day figure keeps the week total).
 *    Days left uncovered are gaps.
 * Rolling 30-day checks: only a single check whose own window matches exactly.
 */
export function resolveCoverage(req: DateRange, available: AvailablePeriod[]): CoverageResult {
  if (req.end < req.start) return { status: "unsupported", reason: "The end date is before the start date." };
  const partialOf = (ps: AvailablePeriod[]) => ps.some((p) => p.completeness && p.completeness !== "complete");

  // Month totals first: they carry month-end adjustments (returns, Amazon shipping) that daily figures don't.
  for (const g of ["month", "custom"] as Granularity[]) {
    const exact = exactUnion(req, available.filter((p) => p.granularity === g));
    if (exact) return { status: "supported", granularity: g, periods: exact, partial: partialOf(exact) };
  }
  // Daily figures and whole weeks together, counting each date once: a week lying wholly inside the range is used
  // when its own days are not all reported day by day; otherwise its days are used. Days outside any such week
  // come from daily figures. Days left uncovered are gaps (a week running past the range is never split).
  const daily = available.filter((p) => p.granularity === "day");
  const have = new Map(daily.map((p) => [p.start, p]));
  const days = eachDay(req);
  const weekly = available.filter((p) => p.granularity === "week").sort((a, b) => (a.start < b.start ? -1 : 1) || (a.end < b.end ? -1 : 1));
  const weeksUsed: AvailablePeriod[] = [];
  const byWeek = new Set<string>();
  for (const w of weekly.filter((p) => periodWithin(p, req))) {
    const wd = eachDay(w);
    if (wd.some((d) => byWeek.has(d))) continue;                     // overlaps a week already counted
    if (wd.every((d) => have.get(d)?.known !== false && have.has(d))) continue;   // every day reported with a known figure: use the days
    weeksUsed.push(w); wd.forEach((d) => byWeek.add(d));
  }
  const dayPeriods = days.filter((d) => !byWeek.has(d) && have.has(d)).map((d) => have.get(d)!);
  const periods = [...weeksUsed, ...dayPeriods].sort((a, b) => (a.start < b.start ? -1 : 1));
  const covered = new Set([...byWeek, ...dayPeriods.map((p) => p.start)]);
  const missing = days.filter((d) => !covered.has(d));
  if (periods.length) {
    const gran: "day" | "week" = weeksUsed.length ? "week" : "day";
    if (!missing.length) return { status: "supported", granularity: gran, periods, partial: partialOf(periods) };
    const note = weeksUsed.length
      ? `Figures cover the days shown. ${missing.length} day${missing.length === 1 ? "" : "s"} (${spans(missing)}) ${missing.length === 1 ? "is" : "are"} not covered: a week running past this range is never split into days.`
      : `${missing.length} of ${days.length} days have no data. Totals cover only the days shown.`;
    return { status: "gaps", granularity: gran, periods, missingDays: missing, note };
  }
  if (weekly.length) {
    const nearest = weekly.filter((p) => p.end >= req.start && p.start <= req.end).map(({ start, end }) => ({ start, end }));
    return { status: "unsupported", reason: `This source has weekly totals only. ${formatRange(req)} does not contain a full reported week, and totals are never split into days.`, nearest };
  }

  for (const g of ["month", "custom"] as Granularity[]) {
    const agg = available.filter((p) => p.granularity === g);
    if (!agg.length) continue;
    const nearest = agg.filter((p) => p.end >= req.start && p.start <= req.end).map(({ start, end }) => ({ start, end }));
    return {
      status: "unsupported",
      reason: `This source has ${g === "month" ? "monthly" : "fixed-period"} totals only. ${formatRange(req)} does not line up with them, and totals are never split into days.`,
      nearest,
    };
  }

  const rolling = available.filter((p) => p.granularity === "rolling_30");
  if (rolling.length) {
    const exact = rolling.find((p) => p.start === req.start && p.end === req.end);
    if (exact) return { status: "supported", granularity: "rolling_30", periods: [exact], partial: false };
    return {
      status: "unsupported",
      reason: "Rolling 30-day checks are shown one at a time with their own dates. Overlapping checks are never added together.",
      nearest: rolling.map(({ start, end }) => ({ start, end })),
    };
  }
  return { status: "unsupported", reason: "No data from this source for the selected period." };
}

/** Picks rolling checks for display: latest per key, never summed. */
export function latestRollingChecks<T extends { key: string; start: string; end: string; collectedAt: string }>(checks: T[]): T[] {
  const best = new Map<string, T>();
  for (const c of checks) {
    const cur = best.get(c.key);
    if (!cur || c.end > cur.end || (c.end === cur.end && c.collectedAt > cur.collectedAt)) best.set(c.key, c);
  }
  return [...best.values()];
}

export function rangesOverlap(a: DateRange, b: DateRange) {
  return a.start <= b.end && b.start <= a.end;
}
