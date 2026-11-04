// Figures with explicit states, weighted ratios and change calculations.
// Missing, zero, not applicable and incomplete stay distinct everywhere.

export type ValueState = "value" | "missing" | "not_applicable" | "incomplete";
/** flag marks a value whose source period was provisional or still running ("partial"); it is always shown. */
export type Fig = { state: ValueState; value: number | null; note?: string; flag?: "provisional" | "partial" };

export const fig = (value: number): Fig => ({ state: "value", value });
export const missing = (note?: string): Fig => ({ state: "missing", value: null, note });
export const notApplicable = (note?: string): Fig => ({ state: "not_applicable", value: null, note });

/**
 * Sums figures. Zero counts as a value. If any part is missing or incomplete, the known sum is returned
 * with state 'incomplete' so it is never shown as a complete total. All not-applicable stays not applicable.
 */
export function sumFigs(parts: Fig[]): Fig {
  if (!parts.length) return missing("No data");
  const relevant = parts.filter((p) => p.state !== "not_applicable");
  if (!relevant.length) return notApplicable();
  const known = relevant.filter((p) => p.state === "value" || (p.state === "incomplete" && p.value !== null));
  const total = known.reduce((a, p) => a + (p.value as number), 0);
  const gaps = relevant.length - relevant.filter((p) => p.state === "value").length;
  if (!known.length) return missing("No values reported");
  if (gaps) return { state: "incomplete", value: total, note: `${gaps} of ${relevant.length} parts missing or incomplete` };
  return fig(round(total, 6));
}

/** Ratio from matching numerator and denominator totals (never an average of ratios). */
export function ratio(num: Fig, den: Fig): Fig {
  if (num.state === "not_applicable" || den.state === "not_applicable") return notApplicable();
  if (num.value === null || den.value === null) return missing("Numerator or denominator missing");
  if (den.value === 0) return notApplicable("Denominator is zero");
  const v = num.value / den.value;
  return num.state === "value" && den.state === "value" ? fig(v) : { state: "incomplete", value: v, note: "Based on incomplete parts" };
}

/** Weighted ratio across rows: sum(numerators) / sum(denominators). */
export function weightedRatio(rows: { num: Fig; den: Fig }[]): Fig {
  return ratio(sumFigs(rows.map((r) => r.num)), sumFigs(rows.map((r) => r.den)));
}

export const aov = (revenue: Fig, orders: Fig) => ratio(revenue, orders);
export const roas = (purchaseValue: Fig, spend: Fig) => ratio(purchaseValue, spend);
export const margin = (grossProfit: Fig, revenue: Fig) => ratio(grossProfit, revenue);

/** Purchase CPA. Below one reported purchase it is 'N/A (<1 purchase)', not infinity or zero. */
export function purchaseCpa(spend: Fig, purchases: Fig): Fig & { display?: string } {
  if (purchases.value !== null && purchases.value < 1) return { ...notApplicable("Fewer than one purchase"), display: "N/A (<1 purchase)" };
  return ratio(spend, purchases);
}

export type Unit = "currency" | "count" | "ratio" | "percent" | "multiple";
export type Direction = "up" | "down" | "neutral";

export type Change = {
  absolute: number | null;            // currency/count/multiple: current minus prior
  percent: number | null;             // relative change, (c - p) / |p| x 100
  percentagePoints: number | null;    // for rates: difference in percentage points
  label: "new" | "no_prior" | "change" | "unavailable";
  sentiment: "good" | "bad" | "neutral";
};

/**
 * Changes. Rates (unit 'percent', stored as fractions) get percentage points, never percent change.
 * Other units get both the absolute difference and the percentage. The percentage uses |prior| so a negative
 * prior (refund-only period) still gives the right sign. Sentiment follows the metric's good direction, so a
 * rise in CPA or bot traffic is not shown as good.
 */
export function change(current: Fig, prior: Fig, unit: Unit, good: Direction): Change {
  const none: Change = { absolute: null, percent: null, percentagePoints: null, label: "unavailable", sentiment: "neutral" };
  if (current.value === null) return none;
  if (prior.state === "missing" || prior.value === null) return { ...none, label: "no_prior" };
  const diff = current.value - prior.value;
  const sentiment = good === "neutral" || diff === 0 ? "neutral" : (diff > 0) === (good === "up") ? "good" : "bad";
  if (unit === "percent") return { absolute: null, percent: null, percentagePoints: round(diff * 100, 6), label: "change", sentiment };
  if (prior.value === 0) return { absolute: round(diff, 6), percent: null, percentagePoints: null, label: current.value === 0 ? "change" : "new", sentiment };
  return { absolute: round(diff, 6), percent: round((diff / Math.abs(prior.value)) * 100, 6), percentagePoints: null, label: "change", sentiment };
}

export function round(v: number, dp = 2) {
  const f = 10 ** dp;
  return Math.round((v + Number.EPSILON) * f) / f;
}

// ---------- display (no em dashes; explicit words for non-values)
export function formatFig(f: Fig & { display?: string }, unit: Unit): string {
  if (f.display) return f.display;
  if (f.state === "missing") return "Missing";
  if (f.state === "not_applicable") return "N/A";
  const v = f.value as number;
  const s = formatValue(v, unit);
  if (f.state === "incomplete") return `${s} (incomplete)`;
  return f.flag ? `${s} (${f.flag})` : s;
}

export function formatValue(v: number, unit: Unit): string {
  switch (unit) {
    case "currency": return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "percent": return `${(v * 100).toFixed(2)}%`;
    case "multiple": return `${v.toFixed(2)}x`;
    case "ratio": return v.toFixed(3);
    default: return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

export function formatChange(c: Change, unit: Unit): string {
  if (c.label === "unavailable") return "No comparison";
  if (c.label === "no_prior") return "No prior data";
  if (c.percentagePoints !== null) return `${c.percentagePoints >= 0 ? "+" : ""}${c.percentagePoints.toFixed(2)} pp`;
  const abs = c.absolute === null ? "" : (c.absolute >= 0 ? "+" : "-") + formatValue(Math.abs(c.absolute), unit).replace(/^-/, "");
  if (c.label === "new") return `${abs} (new, no prior)`;
  if (c.percent === null) return abs;
  return `${abs} (${c.percent >= 0 ? "+" : ""}${c.percent.toFixed(1)}%)`;
}
