// Vendor profit for an exact date range, from the Gross Profit app's published days (observations scoped
// gp_vendor:<slug>, written by the Gross Profit pull). Product GP is before shipping and covers known-cost lines only.
//
// Rules:
//  - Every day of the range must have a vendor breakdown (the gp_vendors marker). If any day is missing, every
//    vendor's profit is Missing and the note names the dates: a range is never half counted, and nothing is prorated.
//  - Days are added one by one, so any range works (a Saturday–Friday week spans two Monday–Sunday GP weeks).
//  - Any line whose cost is missing (whatever its revenue, $0 or negative included), or a provisional/partial GP
//    week, makes profit and margin incomplete, with the reason.
//  - Margin = product GP ÷ the known-cost revenue it was calculated on (Gross Profit's own basis), never ÷ the
//    product reports' revenue.
//  - A vendor with no Gross Profit figure under its name for covered dates stays Missing (a name that doesn't match
//    is not a zero).
import { query } from "./db";
import { DateRange, eachDay, formatRange } from "../shared/dates";
import { Fig, fig, missing, ratio } from "../shared/metrics";
import { vendorSlug, GP_VENDOR_SCOPE, GP_VENDORS_COVERAGE } from "./adapters/grossProfit";

export type VendorProfitRow = { metric_key: string; scope_key: string; scope_label: string | null; d: string; value: number | null; completeness: string | null };
export type VendorProfit = { grossProfit: Fig; margin: Fig; note: string; basis: number | null; missingCostRevenue: number | null };

const money = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const c2 = (v: number) => Math.round(v * 100) / 100;

/** Gaps as compact ranges, e.g. "Nov 14 – 15, 2026". */
function gapsText(days: string[]) {
  const out: DateRange[] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    const next = last ? new Date(Date.parse(`${last.end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : null;
    if (last && next === d) last.end = d; else out.push({ start: d, end: d });
  }
  return out.map(formatRange).join(", ");
}

/** Pure: the range's vendor profit from the day observations. `profitFor(name)` gives one vendor's figures. */
export function vendorProfitFrom(range: DateRange, rows: VendorProfitRow[]) {
  const days = eachDay(range);
  const covered = new Set(rows.filter((r) => r.scope_key === GP_VENDORS_COVERAGE && r.metric_key === "vendor_breakdown_vendors").map((r) => r.d));
  const gaps = days.filter((d) => !covered.has(d));
  const provisional = rows.some((r) => r.scope_key === GP_VENDORS_COVERAGE && covered.has(r.d) && r.completeness && r.completeness !== "complete");
  const by = new Map<string, { gp: number; basis: number; missing: number; lines: number; label: string }>();
  for (const r of rows) {
    if (!r.scope_key.startsWith(GP_VENDOR_SCOPE) || r.value === null || !covered.has(r.d) || r.d < range.start || r.d > range.end) continue;
    const slug = r.scope_key.slice(GP_VENDOR_SCOPE.length);
    const b = by.get(slug) ?? by.set(slug, { gp: 0, basis: 0, missing: 0, lines: 0, label: r.scope_label ?? slug }).get(slug)!;
    if (r.metric_key === "vendor_product_gp") b.gp += r.value;
    else if (r.metric_key === "vendor_product_gp_revenue_basis") b.basis += r.value;
    else if (r.metric_key === "vendor_missing_cost_revenue") b.missing += r.value;
    else if (r.metric_key === "vendor_missing_cost_lines") b.lines += r.value;
  }
  const coverage = gaps.length
    ? { complete: false, note: `Gross Profit has no published vendor figures for ${gapsText(gaps)}, so profit is not shown for ${formatRange(range)}.` }
    : { complete: true, note: "" };
  function profitFor(vendorName: string): VendorProfit {
    if (!coverage.complete) return { grossProfit: missing(coverage.note), margin: missing(coverage.note), note: coverage.note, basis: null, missingCostRevenue: null };
    const b = by.get(vendorSlug(vendorName));
    if (!b) {
      const note = `Gross Profit has no product sales under this vendor name for ${formatRange(range)}.`;
      return { grossProfit: missing(note), margin: missing(note), note, basis: null, missingCostRevenue: null };
    }
    const gp = c2(b.gp), basis = c2(b.basis), miss = c2(b.missing), lines = Math.round(b.lines);
    const reasons = [
      lines > 0 || miss !== 0
        ? `cost missing on ${lines} line${lines === 1 ? "" : "s"} (${money(miss)} of product revenue); profit covers known-cost products only` : "",
      provisional ? "from provisional Gross Profit weeks" : "",
    ].filter(Boolean);
    const gpFig: Fig = reasons.length ? { state: "incomplete", value: gp, note: reasons.join("; ") } : fig(gp);
    const m0 = basis > 0 ? ratio(gpFig, fig(basis)) : missing("No known-cost product revenue");
    // Margin is incomplete whenever profit is (a missing-cost line can carry $0 or negative revenue).
    const m: Fig = reasons.length && m0.value !== null ? { state: "incomplete", value: m0.value, note: reasons.join("; ") } : m0;
    const note = `Product gross profit before shipping, from Gross Profit (${formatRange(range)}); margin on its known-cost revenue of ${money(basis)}` +
      (reasons.length ? ` · ${reasons.join("; ")}` : "") + ".";
    return { grossProfit: gpFig, margin: m, note, basis, missingCostRevenue: miss };
  }
  return { covered: coverage.complete, gaps, note: coverage.note, profitFor, vendors: by };
}

/** Loads the range's day observations (one row per metric, scope and date: the newest active one). */
export async function vendorProfitFor(business: string, range: DateRange) {
  const rows = await query<VendorProfitRow>(
    `select distinct on (metric_key, scope_key, period_start) metric_key, scope_key, scope_label, to_char(period_start, 'YYYY-MM-DD') as d,
            value::float8 as value, completeness
       from observations
      where status = 'active' and business_id = $1 and granularity = 'day' and period_start = period_end
        and period_start >= $2 and period_start <= $3
        and metric_key in ('vendor_product_gp', 'vendor_product_gp_revenue_basis', 'vendor_missing_cost_revenue', 'vendor_missing_cost_lines', 'vendor_breakdown_vendors')
        and (scope_key = $4 or scope_key like $5)
      order by metric_key, scope_key, period_start, collected_at desc`,
    [business, range.start, range.end, GP_VENDORS_COVERAGE, `${GP_VENDOR_SCOPE}%`]);
  return vendorProfitFrom(range, rows);
}

/** Profit and margin withheld (e.g. a channel or category filter Gross Profit can't apply): Missing, with the reason. */
export function vendorProfitWithheld(note: string) {
  const profitFor = (): VendorProfit => ({ grossProfit: missing(note), margin: missing(note), note, basis: null, missingCostRevenue: null });
  return { covered: false, gaps: [] as string[], note, profitFor, vendors: new Map() };
}

