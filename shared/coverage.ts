// Decides whether a requested date range can be answered from the periods a source actually has.
// Weekly and monthly aggregates are never split into invented daily values; rolling checks are never added.
import { DateRange, addDays, eachDay, formatRange } from "./dates";

export type Granularity = "day" | "week" | "month" | "rolling_30" | "custom";
export type AvailablePeriod = DateRange & { granularity: Granularity; completeness?: string };

export type CoverageResult =
  | { status: "supported"; granularity: Granularity; periods: AvailablePeriod[]; partial: boolean; note?: string }
  | { status: "gaps"; granularity: "day"; periods: AvailablePeriod[]; missingDays: string[]; note: string }
  | { status: "unsupported"; reason: string; nearest?: DateRange[] };

/**
 * Daily data: any range inside coverage; missing days are reported as gaps (not filled).
 * Weekly/monthly data: only ranges that are an exact union of stored periods.
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

  for (const g of ["week", "month", "custom"] as Granularity[]) {
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
      reason: `This source has ${g === "week" ? "weekly" : g === "month" ? "monthly" : "fixed-period"} totals only. ${formatRange(req)} does not line up with them, and totals are never split into days.`,
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
