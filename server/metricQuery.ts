// Reads active observations for a period, honouring each source's real coverage.
import { query } from "./db";
import { DateRange, addDays, comparisonPeriod, ComparisonKind, dayCount, equivalentElapsed } from "../shared/dates";
import { resolveCoverage, periodWithin, AvailablePeriod, CoverageResult } from "../shared/coverage";
import { Fig, fig, missing, notApplicable, sumFigs, ratio, change, Change, purchaseCpa, Unit, Direction } from "../shared/metrics";

type ObsRow = { metric_key: string; scope_key: string; period_start: string; period_end: string; granularity: any; timezone: string;
  value: number | null; value_state: Fig["state"]; completeness: string; collected_at: string | null; source_id: string };

export type MetricDef = { key: string; label: string; unit: Unit; kind: "base" | "derived" | "reported_ratio"; good_direction: Direction; numerator: string | null; denominator: string | null };

let defsCache: Map<string, MetricDef> | null = null;
export async function metricDefs() {
  if (!defsCache) defsCache = new Map((await query<MetricDef>("select key, label, unit, kind, good_direction, numerator, denominator from metric_definitions")).map((d) => [d.key, d]));
  return defsCache;
}
export const _resetDefsCache = () => { defsCache = null; };

export async function observationsFor(business: string, metrics: string[], scope: string, range: DateRange) {
  return query<ObsRow>(
    `select metric_key, scope_key, to_char(period_start,'YYYY-MM-DD') as period_start, to_char(period_end,'YYYY-MM-DD') as period_end, granularity, timezone,
            value::float8 as value, value_state, completeness, collected_at, source_id
       from observations where status = 'active' and business_id = $1 and metric_key = any($2) and scope_key = $3
        and period_end >= $4 and period_start <= $5 order by period_start`,
    [business, metrics, scope, range.start, range.end]);
}

/** Carries source completeness onto a figure: incomplete data makes it incomplete; provisional or partial is flagged. */
export function withCompleteness(v: Fig, completeness: string[]): Fig {
  if (v.value === null) return v;
  if (completeness.includes("incomplete") && v.state === "value") return { ...v, state: "incomplete", note: v.note ?? "Source marked the data incomplete" };
  const flag = completeness.includes("provisional") ? "provisional" : completeness.includes("partial") ? "partial" : undefined;
  return flag ? { ...v, flag } : v;
}

export type MetricResult = { key: string; label: string; unit: Unit; value: Fig & { display?: string }; coverage: CoverageResult; timezone: string | null; covered: DateRange | null };

/** Base metric total over a range, or a typed reason why it cannot be given. */
export function baseTotal(rows: ObsRow[], metric: string, range: DateRange): { value: Fig; coverage: CoverageResult; timezone: string | null; covered: DateRange | null } {
  const mine = rows.filter((r) => r.metric_key === metric);
  // The same figure for the same period from more than one source is never added together.
  const seen = new Map<string, Set<string>>();
  for (const r of mine.filter((r) => periodWithin({ start: r.period_start, end: r.period_end, granularity: r.granularity }, range))) {
    const k = `${r.period_start}|${r.period_end}|${r.granularity}`;
    seen.set(k, (seen.get(k) ?? new Set()).add(r.source_id));
  }
  if ([...seen.values()].some((v) => v.size > 1)) {
    const cov: CoverageResult = { status: "unsupported", reason: "Reported by more than one source for the same period" };
    return { value: missing(cov.reason), coverage: cov, timezone: null, covered: null };
  }
  const avail: (AvailablePeriod & { row: ObsRow })[] = mine.map((r) => ({ start: r.period_start, end: r.period_end, granularity: r.granularity, completeness: r.completeness, row: r }));
  const cov = resolveCoverage(range, avail);
  if (cov.status === "unsupported") return { value: missing(cov.reason), coverage: cov, timezone: null, covered: null };
  const used = (cov.periods as typeof avail).map((p) => p.row);
  let v = sumFigs(used.map((r) => ({ state: r.value_state, value: r.value })));
  if (cov.status === "gaps" && v.state === "value") v = { state: "incomplete", value: v.value, note: cov.note };
  v = withCompleteness(v, used.map((r) => r.completeness));
  const tz = used[0]?.timezone ?? null;
  const covered = used.length ? { start: used[0].period_start, end: used[used.length - 1].period_end } : null;
  return { value: v, coverage: cov, timezone: tz, covered };
}

/** A metric (base or derived) for a business, scope and range. Derived ratios use matching sums. */
export async function metricValue(business: string, key: string, scope: string, range: DateRange): Promise<MetricResult> {
  const defs = await metricDefs();
  const d = defs.get(key);
  if (!d) throw new Error(`unknown metric ${key}`);
  if (d.kind === "base") {
    const rows = await observationsFor(business, [key], scope, range);
    const t = baseTotal(rows, key, range);
    return { key, label: d.label, unit: d.unit, ...t };
  }
  if (d.kind === "reported_ratio") {
    const rows = await observationsFor(business, [key], scope, range);
    const exact = rows.filter((r) => r.period_start === range.start && r.period_end === range.end);
    const cov = resolveCoverage(range, rows.map((r) => ({ start: r.period_start, end: r.period_end, granularity: r.granularity })));
    if (exact.length === 1) return { key, label: d.label, unit: d.unit, value: { state: exact[0].value_state, value: exact[0].value, note: "As reported, at its original scope" }, coverage: cov, timezone: exact[0].timezone, covered: range };
    return { key, label: d.label, unit: d.unit, value: missing("Reported ratios are shown only for their exact original period"), coverage: cov, timezone: null, covered: null };
  }
  if (key === "margin") {
    const g = grossMarginFromRows(await marginRows(business, scope, range), range);
    return { key, label: d.label, unit: d.unit, value: g.value, coverage: g.coverage, timezone: g.timezone, covered: g.covered };
  }
  const rows = await observationsFor(business, [d.numerator!, d.denominator!], scope, range);
  const n = baseTotal(rows, d.numerator!, range), m = baseTotal(rows, d.denominator!, range);
  const value = key === "cpa" ? purchaseCpa(n.value, m.value) : ratio(n.value, m.value);
  return { key, label: d.label, unit: d.unit, value, coverage: n.coverage.status !== "supported" ? n.coverage : m.coverage, timezone: n.timezone ?? m.timezone, covered: n.covered };
}

export type Compared = MetricResult & { prior: Fig; priorRange: DateRange | null; change: Change; partialNote?: string };

/** Current vs comparison. For partial current coverage the comparison uses the same elapsed days. */
export async function compared(business: string, key: string, scope: string, range: DateRange, kind: ComparisonKind | null): Promise<Compared> {
  const defs = await metricDefs();
  const d = defs.get(key)!;
  const cur = await metricValue(business, key, scope, range);
  if (!kind) return { ...cur, prior: missing(), priorRange: null, change: change(cur.value, missing(), d.unit, d.good_direction) };
  let cmp: DateRange = comparisonPeriod(range, kind);
  let partialNote: string | undefined;
  if (cur.coverage.status === "gaps" || (cur.covered && cur.covered.end < range.end && cur.covered.start === range.start)) {
    const through = cur.coverage.status === "gaps" ? lastContiguous(range, cur.coverage.missingDays) : cur.covered!.end;
    if (through) {
      const e = equivalentElapsed(range, cmp, through);
      cmp = e.comparison;
      partialNote = `Current data covers ${e.elapsedDays} of ${dayCount(range)} days; the comparison uses the same ${e.elapsedDays} days.`;
      const cur2 = await metricValue(business, key, scope, e.current);
      const prior = await metricValue(business, key, scope, cmp);
      return { ...cur2, prior: prior.value, priorRange: cmp, change: change(cur2.value, prior.value, d.unit, d.good_direction), partialNote };
    }
  }
  const prior = await metricValue(business, key, scope, cmp);
  return { ...cur, prior: prior.value, priorRange: cmp, change: change(cur.value, prior.value, d.unit, d.good_direction), partialNote };
}

function lastContiguous(range: DateRange, missingDays: string[]): string | null {
  const miss = new Set(missingDays);
  if (miss.has(range.start)) return null;
  let d = range.start;
  while (d < range.end && !miss.has(addDays(d, 1))) d = addDays(d, 1);
  return d;
}

/** Trend points in the source's own periods (daily data grouped into blocks the length of the selected range). */
export async function trend(business: string, key: string, scope: string, end: string, points = 8, blockDays = 7) {
  const defs = await metricDefs();
  const d = defs.get(key)!;
  const span: DateRange = { start: addDays(end, -(points * Math.max(blockDays, 31))), end };
  const metrics = d.kind === "derived" ? [d.numerator!, d.denominator!] : [key];
  const rows = await observationsFor(business, metrics, scope, span);
  const base = rows.filter((r) => r.metric_key === metrics[0]);
  const gran = base.length ? base[base.length - 1].granularity : null;
  let periods: DateRange[] = [];
  if (gran === "day") {
    for (let i = points - 1; i >= 0; i--) { const e = addDays(end, -i * blockDays); periods.push({ start: addDays(e, -(blockDays - 1)), end: e }); }
  } else {
    const seen = new Set<string>();
    periods = base.filter((r) => r.period_end <= end && r.granularity !== "rolling_30").map((r) => ({ start: r.period_start, end: r.period_end }))
      .filter((p) => (seen.has(p.start + p.end) ? false : (seen.add(p.start + p.end), true))).slice(-points);
  }
  const mRows = key === "margin" ? await marginRows(business, scope, span) : [];
  const out = periods.map((p) => {
    if (key === "margin") return { ...p, value: grossMarginFromRows(mRows, p).value };
    if (d.kind !== "derived") { const t = baseTotal(rows, key, p); return { ...p, value: t.value }; }
    const n = baseTotal(rows, d.numerator!, p), m = baseTotal(rows, d.denominator!, p);
    return { ...p, value: key === "cpa" ? purchaseCpa(n.value, m.value) : ratio(n.value, m.value) };
  });
  return { key, label: d.label, unit: d.unit, granularity: gran, timezone: rows[0]?.timezone ?? null, points: out };
}

export { fig, notApplicable };

// ------------------------------------------------------------ gross margin
// Gross margin = gross profit / the revenue basis sent in the SAME submission (import run). Profit and basis must also
// match on integration (source, submitter, envelope source), business, period, granularity, timezone and accounting scope.
// Anything else (missing, mismatched, zero, several integrations) makes margin unavailable with a reason.
// It never falls back to business revenue.
export type MarginRow = ObsRow & { submitter: string; submission_source: string; import_run_id: string };

export async function marginRows(business: string, scope: string, range: DateRange) {
  return query<MarginRow>(
    `select o.metric_key, o.scope_key, to_char(o.period_start,'YYYY-MM-DD') as period_start, to_char(o.period_end,'YYYY-MM-DD') as period_end,
            o.granularity, o.timezone, o.value::float8 as value, o.value_state, o.completeness, o.collected_at, o.source_id, i.submitter, i.submission_source, o.import_run_id::text as import_run_id
       from observations o join import_runs i on i.id = o.import_run_id
      where o.status = 'active' and o.business_id = $1 and o.metric_key in ('gross_profit', 'gross_profit_revenue_basis') and o.scope_key = $2
        and o.period_end >= $3 and o.period_start <= $4 order by o.period_start`,
    [business, scope, range.start, range.end]);
}

const unavailable = (note: string): Fig => ({ state: "missing", value: null, note });
const owner = (r: MarginRow) => `${r.source_id}|${r.submitter}|${r.submission_source}`;

export function grossMarginFromRows(rows: MarginRow[], range: DateRange): { value: Fig; coverage: CoverageResult; timezone: string | null; covered: DateRange | null } {
  const profit = rows.filter((r) => r.metric_key === "gross_profit");
  const inRange = profit.filter((r) => periodWithin({ start: r.period_start, end: r.period_end, granularity: r.granularity }, range));
  const periodOwners = new Map<string, Set<string>>();
  for (const r of inRange) { const k = `${r.period_start}|${r.period_end}|${r.granularity}`; periodOwners.set(k, (periodOwners.get(k) ?? new Set()).add(owner(r))); }
  if ([...periodOwners.values()].some((o) => o.size > 1))
    return { value: unavailable("Gross profit for this period comes from more than one integration"), coverage: { status: "unsupported", reason: "Reported by more than one integration" }, timezone: null, covered: null };
  const avail = profit.map((r) => ({ start: r.period_start, end: r.period_end, granularity: r.granularity, completeness: r.completeness, row: r }));
  const cov = resolveCoverage(range, avail);
  if (cov.status === "unsupported") return { value: unavailable(cov.reason), coverage: cov, timezone: null, covered: null };
  const used = (cov.periods as typeof avail).map((p) => p.row);
  const covered = used.length ? { start: used[0].period_start, end: used[used.length - 1].period_end } : null;
  const done = (v: Fig) => ({ value: v, coverage: cov, timezone: used[0]?.timezone ?? null, covered });
  if (new Set(used.map(owner)).size > 1) return done(unavailable("Gross profit for this period comes from more than one integration"));
  const bases: MarginRow[] = [];
  for (const p of used) {
    // Profit and basis must come from the same import run: a basis sent separately, even by the same integration
    // with identical dates, timezone and scope, never pairs with a profit figure.
    const sameOwnerPeriod = rows.filter((b) => b.metric_key === "gross_profit_revenue_basis" && b.import_run_id === p.import_run_id && owner(b) === owner(p) && b.period_start === p.period_start
      && b.period_end === p.period_end && b.granularity === p.granularity && b.scope_key === p.scope_key);
    if (!sameOwnerPeriod.length) return done(unavailable("No revenue basis was sent in the same submission as this gross profit"));
    const b = sameOwnerPeriod.find((x) => x.timezone === p.timezone);
    if (!b) return done(unavailable("The revenue basis uses a different timezone from the gross profit"));
    bases.push(b);
  }
  const num = sumFigs(used.map((r) => ({ state: r.value_state, value: r.value })));
  const den = sumFigs(bases.map((r) => ({ state: r.value_state, value: r.value })));
  if (num.value === null) return done(unavailable("Gross profit is missing"));
  if (den.value === null) return done(unavailable("The revenue basis is missing"));
  if (den.value === 0) return done(unavailable("The revenue basis is zero"));
  let v: Fig = { state: num.state === "value" && den.state === "value" && cov.status === "supported" ? "value" : "incomplete", value: num.value / den.value };
  if (v.state === "incomplete") v.note = cov.status === "gaps" ? cov.note : "Gross profit or its revenue basis is incomplete";
  v = withCompleteness(v, [...used, ...bases].map((r) => r.completeness));
  return done(v);
}
