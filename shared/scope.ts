// Scope rules for business totals, channel breakdowns and transaction de-duplication.

// Business-specific scope is configuration, not code, so this public repository holds no business rules:
//   EXCLUDED_BRANDS   comma-separated brand names hidden from every view (matched case-insensitively on labels)
//   TRACKED_CHANNELS  "key:Label,key:Label" channels itemized in the business breakdown; anything else stays
//                     inside the reported total as "other channels"
// Both are set privately on the server. Settings shows what is configured.
const env = (k: string) => (typeof process !== "undefined" && process.env ? process.env[k] ?? "" : "");

export function excludedBrands(): string[] {
  return env("EXCLUDED_BRANDS").split(",").map((b) => b.trim().toLowerCase()).filter(Boolean);
}
export const isExcludedBrand = (label: string) => excludedBrands().some((b) => label.trim().toLowerCase().includes(b));

export function trackedChannels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of env("TRACKED_CHANNELS").split(",")) {
    const i = part.indexOf(":");
    const key = (i > 0 ? part.slice(0, i) : part).trim().toLowerCase();
    if (/^[a-z0-9_]{1,40}$/.test(key)) out[key] = (i > 0 ? part.slice(i + 1) : key).trim() || key;
  }
  return out;
}

export type ChannelFigure = { scope: string; label: string; revenue: number | null; orders: number | null };

/**
 * The business total comes from its own 'all' observation and is never rebuilt from the breakdown.
 * The breakdown lists tracked channels only, and the difference is shown as "other channels" so nothing
 * appears to be double counted or lost. Corporate revenue is reported separately and never added.
 */
export function totalWithBreakdown(total: { revenue: number | null; orders: number | null }, channels: ChannelFigure[]) {
  const tc = trackedChannels();
  const tracked = channels.filter((c) => c.scope.startsWith("channel:") && tc[c.scope.slice(8)] && !isExcludedBrand(c.label));
  const sumRev = tracked.every((c) => c.revenue !== null) ? tracked.reduce((a, c) => a + (c.revenue as number), 0) : null;
  const otherRevenue = total.revenue !== null && sumRev !== null ? Math.round((total.revenue - sumRev) * 100) / 100 : null;
  return {
    total,
    tracked,
    otherRevenue,
    note: "Total covers all channels. The breakdown shows tracked channels only; corporate revenue may overlap other channels and is not added.",
  };
}

export type Transaction = {
  source: string;                  // the tool or export it came from
  orderId: string;                 // id within that source
  canonicalOrderId?: string;       // the marketplace order id; set it on the marketplace's own record AND on any copy mirrored into another tool
  productKey: string;
  channel: string;
  revenue: number;
  units: number;
};

/**
 * De-duplicates transaction lines across source tools. Two lines are the same sale when they share the
 * canonical order id (or source order id) AND product. Distinct sales of the same product, including on
 * different channels, still count.
 */
export function dedupeTransactions(lines: Transaction[]) {
  const seen = new Map<string, Transaction>();
  const duplicates: Transaction[] = [];
  for (const t of lines) {
    if (isExcludedBrand(t.channel)) continue;
    const key = `${(t.canonicalOrderId ? `order:${t.canonicalOrderId}` : `${t.source}:${t.orderId}`).toLowerCase()}|${t.productKey}`;
    if (seen.has(key)) duplicates.push(t);
    else seen.set(key, t);
  }
  return { lines: [...seen.values()], duplicates };
}

/** States what channels a ranking covers, so a ranking is never read as all sales. */
export function rankingScopeLabel(channelScopes: string[]) {
  const tc = trackedChannels();
  const names = channelScopes.map((s) => tc[s.replace(/^channel:/, "")] ?? s.replace(/^channel:/, "")).sort();
  return names.length ? `Covers ${names.join(", ")} only` : "Channel scope not stated";
}
