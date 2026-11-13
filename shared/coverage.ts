// Decides whether a requested date range can be answered from the periods a source actually has.
// Every figure counts toward the calendar days it covers. A weekly total that runs past the range is never split
// into invented daily values: the range is answered from daily data or exact monthly totals instead, or the days the
// week covers are reported as a gap. Rolling checks are never added.
import { DateRange, addDays, eachDay, formatRange } from "./dates";

export type Granularity = "day" | "week" | "month" | "rolling_30" | "custom";
export type AvailablePeriod = DateRange & { granularity: Granularity; completeness?: string };

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
 * 2. Daily data covering every day of the range.
 * 3. Daily data with missing days reported as gaps.
 * 4. Weekly totals lying wholly inside the range; days of the range that sit in a week running past it are gaps.
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
  const daily = available.filter((p) => p.granularity === "day");
  const have = new Map(daily.map((p) => [p.start, p]));
  const days = eachDay(req);
  const inRange = days.filter((d) => have.has(d));
  if (inRange.length === days.length) {
    const periods = days.map((d) => have.get(d)!);
    return { status: "supported", granularity: "day", periods, partial: partialOf(periods) };
  }
  if (inRange.length) {
    const missing = days.filter((d) => !have.has(d));
    const periods = inRange.map((d) => have.get(d)!);
    return { status: "gaps", granularity: "day", periods, missingDays: missing, note: `${missing.length} of ${days.length} days have no data. Totals cover only the days shown.` };
  }

  const weekly = available.filter((p) => p.granularity === "week").sort((a, b) => (a.start < b.start ? -1 : 1));
  if (weekly.length) {
    const inside = weekly.filter((p) => periodWithin(p, req));
    const overlapping = inside.some((p, i) => i > 0 && p.start <= inside[i - 1].end);
    const covered = new Set(inside.flatMap((p) => eachDay(p)));
    const missing = days.filter((d) => !covered.has(d));
    if (inside.length && !overlapping) {
      if (!missing.length) return { status: "supported", granularity: "week", periods: inside, partial: partialOf(inside) };
      return { status: "gaps", granularity: "week", periods: inside, missingDays: missing,
        note: `Weekly totals cover the days shown. ${missing.length} day${missing.length === 1 ? "" : "s"} (${spans(missing)}) ${missing.length === 1 ? "is" : "are"} not covered: a week running past this range is never split into days.` };
    }
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
