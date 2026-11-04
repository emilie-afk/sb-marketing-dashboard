// Calendar-date helpers. Dates are 'YYYY-MM-DD' strings in the source's reporting timezone; no clock time,
// so no timezone shifting can happen here. Ranges are inclusive.

export type DateRange = { start: string; end: string };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function parts(s: string) {
  if (!isIsoDate(s)) throw new Error(`invalid date: ${s}`);
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const toMs = (s: string) => { const p = parts(s); return Date.UTC(p.y, p.m - 1, p.d); };
const fromMs = (ms: number) => { const t = new Date(ms); return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

export const addDays = (s: string, n: number) => fromMs(toMs(s) + n * 86_400_000);
export const dayCount = (r: DateRange) => Math.round((toMs(r.end) - toMs(r.start)) / 86_400_000) + 1;
export const compareDates = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const minDate = (a: string, b: string) => (a < b ? a : b);
export const maxDate = (a: string, b: string) => (a > b ? a : b);

export function eachDay(r: DateRange): string[] {
  const out: string[] = [];
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isMonthStart = (s: string) => parts(s).d === 1;
export function isMonthEnd(s: string) { const p = parts(s); return p.d === daysInMonth(p.y, p.m); }
export function monthEnd(s: string) { const p = parts(s); return fmt(p.y, p.m, daysInMonth(p.y, p.m)); }
export function isWholeMonths(r: DateRange) { return isMonthStart(r.start) && isMonthEnd(r.end); }

/**
 * Shifts a date by whole months. Month-end rule: when the day does not exist in the target month
 * (31st into a 30-day month, Feb 29 into a non-leap year), it becomes that month's last day.
 */
export function shiftMonths(s: string, months: number): { date: string; clamped: boolean } {
  const p = parts(s);
  const idx = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(idx / 12), m = (idx % 12) + 1;
  const dim = daysInMonth(y, m);
  return { date: fmt(y, m, Math.min(p.d, dim)), clamped: p.d > dim };
}

export type Comparison = DateRange & {
  kind: ComparisonKind;
  clamped: boolean;       // a date was moved to month end (month-end or leap-day rule)
  note?: string;
};
export type ComparisonKind = "previous_period" | "same_dates_last_month" | "same_dates_last_year";

export const COMPARISON_LABELS: Record<ComparisonKind, string> = {
  previous_period: "Previous equivalent period",
  same_dates_last_month: "Same dates last month",
  same_dates_last_year: "Same dates last year",
};

/**
 * Comparison periods.
 * - previous_period: the same number of days immediately before.
 * - same_dates_last_month / last_year: each date shifted back; a whole-month selection maps to the whole
 *   comparison month (Mar 1 to 31 compares with Feb 1 to 28 or 29); otherwise day numbers are kept and
 *   clamped to month end (Mar 31 maps to Feb 28; Feb 29 maps to Feb 28 last year).
 */
export function comparisonPeriod(r: DateRange, kind: ComparisonKind): Comparison {
  if (r.end < r.start) throw new Error("range end before start");
  if (kind === "previous_period") {
    const n = dayCount(r);
    return { kind, start: addDays(r.start, -n), end: addDays(r.start, -1), clamped: false };
  }
  const months = kind === "same_dates_last_month" ? -1 : -12;
  if (isWholeMonths(r)) {
    const s = shiftMonths(r.start, months).date;
    const e = monthEnd(shiftMonths(r.end, months).date);
    return { kind, start: s, end: e, clamped: false, note: "Whole months compared with whole months" };
  }
  const s = shiftMonths(r.start, months), e = shiftMonths(r.end, months);
  const clamped = s.clamped || e.clamped;
  return { kind, start: s.date, end: e.date, clamped, note: clamped ? "A date did not exist in the comparison month and was moved to that month's last day" : undefined };
}

/**
 * Equivalent elapsed coverage for a partial current period: when data covers the current period only up to
 * `coveredThrough`, the comparison covers the same number of days from its own start.
 */
export function equivalentElapsed(current: DateRange, comparison: DateRange, coveredThrough: string):
  { current: DateRange; comparison: DateRange; partial: boolean; elapsedDays: number } {
  if (coveredThrough >= current.end) return { current, comparison, partial: false, elapsedDays: dayCount(current) };
  if (coveredThrough < current.start) throw new Error("no coverage in the current period");
  const elapsed = dayCount({ start: current.start, end: coveredThrough });
  const cmpEnd = minDate(addDays(comparison.start, elapsed - 1), comparison.end);
  return { current: { start: current.start, end: coveredThrough }, comparison: { start: comparison.start, end: cmpEnd }, partial: true, elapsedDays: elapsed };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatRange(r: DateRange) {
  const a = parts(r.start), b = parts(r.end);
  if (r.start === r.end) return `${MONTHS[a.m - 1]} ${a.d}, ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d} to ${b.d}, ${a.y}`;
  if (a.y === b.y) return `${MONTHS[a.m - 1]} ${a.d} to ${MONTHS[b.m - 1]} ${b.d}, ${a.y}`;
  return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} to ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}

/** Today's date in a given IANA timezone (operational deadlines use Vietnam time). */
export function todayIn(tz: string, now = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(now);
}
export const OPERATIONS_TZ = "Asia/Ho_Chi_Minh";
