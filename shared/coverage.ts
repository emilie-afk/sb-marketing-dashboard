// Decides whether a requested date range can be answered from the periods a source actually has.
// Weekly and monthly aggregates are never split into invented daily values; rolling checks are never added.
import { DateRange, addDays, eachDay, formatRange } from "./dates";

export type Granularity = "day" | "week" | "month" | "rolling_30" | "custom";
export type AvailablePeriod = DateRange & { granularity: Granularity; completeness?: string };

export type CoverageResult =
  | { status: "supported"; granularity: Granularity; periods: AvailablePeriod[]; partial: boolean; note?: string }
  | { status: "gaps"; granularity: "day" | "week"; periods: AvailablePeriod[]; missingDays: string[]; note: string }
  | { status: "unsupported"; reason: string; nearest?: DateRange[] };

const isWorkday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };
/** A weekly total's working days (Mon–Fri). The team works Mon–Fri, so weekend days at either end of a reported
 *  week (e.g. Saturday–Friday weeks) do not decide which date ranges the week belongs to. */
export function workSpan(p: DateRange): DateRange | null {
  const days = eachDay(p).filter(isWorkday);
  return days.length ? { start: days[0], end: days[days.length - 1] } : null;
}
/** Whether a stored period counts toward a requested range: weekly totals by their working days, others by their dates. */
export function periodWithin(p: DateRange & { granularity: string }, req: DateRange) {
  if (p.granularity === "week") { const w = workSpan(p); return !!w && w.start >= req.start && w.end <= req.end; }
  return p.start >= req.start && p.end <= req.end;
}
const spans = (days: string[]) => {
  const out: DateRange[] = [];
  for (const d of days) { const last = out[out.length - 1]; if (last && addDays(last.end, 1) === d) last.end = d; else if (last && eachDay({ start: addDays(last.end, 1), end: addDays(d, -1) }).every((x) => !isWorkday(x))) last.end = d; else out.push({ start: d, end: d }); }
  return out.map(formatRange).join(", ");
};

/**
 * Daily data: any range inside coverage; missing days are reported as gaps (not filled).
 * Weekly data: weeks whose working days (Mon–Fri) fall inside the range. Working days of the range that sit in a
 * week running past it are reported as gaps; a weekly total is never split.
 * Monthly data: only ranges that are an exact union of stored periods.
 * Rolling 30-day checks: only a single check whose own window matches exactly.
 */
export function resolveCoverage(req: DateRange, available: AvailablePeriod[]): CoverageResult {
  if (req.end < req.start) return { status: "unsupported", reason: "The end date is before the start date." };

  const daily = available.filter((p) => p.granularity === "day");
  if (daily.length) {
    const have = new Map(daily.map((p) => [p.start, p]));
    const days = eachDay(req);
    const inRange = days.filter((d) => have.has(d));
    if (inRange.length) {
      const missing = days.filter((d) => !have.has(d));
      const periods = inRange.map((d) => have.get(d)!);
      const partial = periods.some((p) => p.completeness && p.completeness !== "complete");
      if (!missing.length) return { status: "supported", granularity: "day", periods, partial };
      return { status: "gaps", granularity: "day", periods, missingDays: missing, note: `${missing.length} of ${days.length} days have no data. Totals cover only the days shown.` };
    }
  }

  const weekly = available.filter((p) => p.granularity === "week").sort((a, b) => (a.start < b.start ? -1 : 1));
  if (weekly.length) {
    const inside = weekly.filter((p) => periodWithin(p, req));
    const overlapping = inside.some((p, i) => i > 0 && p.start <= inside[i - 1].end);
    const workDays = eachDay(req).filter(isWorkday);
    const covered = new Set(inside.flatMap((p) => eachDay(p)));
    const missing = workDays.filter((d) => !covered.has(d));
    const partial = inside.some((p) => p.completeness && p.completeness !== "complete");
    if (inside.length && !overlapping && workDays.length) {
      if (!missing.length) return { status: "supported", granularity: "week", periods: inside, partial };
      return { status: "gaps", granularity: "week", periods: inside, missingDays: missing,
        note: `Weekly totals cover the working days shown. ${missing.length} working day${missing.length === 1 ? "" : "s"} (${spans(missing)}) fall${missing.length === 1 ? "s" : ""} in a week that runs past this range; weekly totals are never split.` };
    }
    const nearest = weekly.filter((p) => p.end >= req.start && p.start <= req.end).map(({ start, end }) => ({ start, end }));
    return { status: "unsupported", reason: `This source has weekly totals only. ${formatRange(req)} does not contain a full working week (Mon–Fri) of them, and totals are never split into days.`, nearest };
  }

  for (const g of ["month", "custom"] as Granularity[]) {
    const agg = available.filter((p) => p.granularity === g).sort((a, b) => (a.start < b.start ? -1 : 1));
    if (!agg.length) continue;
    const inside = agg.filter((p) => p.start >= req.start && p.end <= req.end);
    // Exact union: consecutive, non-overlapping, starting at req.start and ending at req.end.
    let cursor = req.start, ok = inside.length > 0;
    for (const p of inside) {
      if (p.start !== cursor) { ok = false; break; }
      cursor = addDays(p.end, 1);
    }
    if (ok && addDays(req.end, 1) === cursor) {
      return { status: "supported", granularity: g, periods: inside, partial: inside.some((p) => p.completeness && p.completeness !== "complete") };
    }
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
