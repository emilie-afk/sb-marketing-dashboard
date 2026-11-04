// Etsy listing review rules: like-for-like option comparison, sampled market statistics, corrections that
// supersede findings while keeping history, and proposals that need approval before they become tasks.

export type Format = "digital" | "printed" | "physical";
export type Option = { label: string; format: Format; pages?: number | null; pack_qty?: number | null; size?: string | null; price: number; price_basis?: "option" | "from_price" };

/** Two options are comparable only when format matches and stated pages, size and pack quantity agree. */
export function comparable(ours: Option, theirs: Option): boolean {
  if (theirs.price_basis === "from_price" || ours.price_basis === "from_price") return false;  // a "from" price is never compared
  if (ours.format !== theirs.format) return false;
  if (ours.pages && theirs.pages && ours.pages !== theirs.pages) return false;
  if (ours.size && theirs.size && norm(ours.size) !== norm(theirs.size)) return false;
  return true;                                    // pack sizes compare per unit (below)
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, "");
export const unitPrice = (o: Option) => o.price / Math.max(1, o.pack_qty ?? 1);

export type Position = { option: string; comparableCount: number; position: "below" | "at" | "above" | "no_comparable"; ourUnit: number; medianUnit: number | null; compared: string[] };

/** Position of one of our options against comparable competitor options (median of per-unit prices, 5% band = at). */
export function pricePosition(ours: Option, competitors: (Option & { id: string })[]): Position {
  const cmp = competitors.filter((c) => comparable(ours, c));
  const our = unitPrice(ours);
  if (!cmp.length) return { option: ours.label, comparableCount: 0, position: "no_comparable", ourUnit: our, medianUnit: null, compared: [] };
  const units = cmp.map(unitPrice).sort((a, b) => a - b);
  const mid = units.length >> 1;
  const median = units.length % 2 ? units[mid] : (units[mid - 1] + units[mid]) / 2;
  const position = our < median * 0.95 ? "below" : our > median * 1.05 ? "above" : "at";
  return { option: ours.label, comparableCount: cmp.length, position, ourUnit: our, medianUnit: Math.round(median * 100) / 100, compared: cmp.map((c) => c.id) };
}

/** Market statistics are always labelled as a sample of search results, never the whole market. */
export function sampleLabel(s: { sample_size: number; sampling_scope: string; keyword: string }) {
  return `Sample of ${s.sample_size} search result${s.sample_size === 1 ? "" : "s"} for "${s.keyword}" (${s.sampling_scope}). Not the whole market.`;
}

export type Finding = { key: string; state: "active" | "superseded" | "needs_review"; depends_on: string[]; sensitive_topic?: string | null; is_suggestion: boolean };
export type Correction = { supersedes: string; replacement?: string | null; reason: string };

/**
 * Applies corrections: the corrected finding becomes 'superseded' (kept for history). Any finding that depends,
 * directly or indirectly, on a superseded finding is marked 'needs_review'. Returns the keys that changed.
 */
export function applyCorrections(findings: Finding[], corrections: Correction[]) {
  const byKey = new Map(findings.map((f) => [f.key, { ...f }]));
  const superseded: string[] = [], flagged: string[] = [], unknown: string[] = [];
  for (const c of corrections) {
    const f = byKey.get(c.supersedes);
    if (!f) { unknown.push(c.supersedes); continue; }
    if (f.state !== "superseded") { f.state = "superseded"; superseded.push(f.key); }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of byKey.values()) {
      if (f.state !== "active") continue;
      if (f.depends_on.some((d) => { const p = byKey.get(d); return p && p.state !== "active"; })) { f.state = "needs_review"; flagged.push(f.key); changed = true; }
    }
  }
  return { findings: [...byKey.values()], superseded, flagged, unknown };
}

export const SENSITIVE_TOPICS = ["guarantee", "shipping_promise", "proof", "product_option"] as const;

/** Whether a finding may be approved (and so turned into a task). */
export function canApprove(f: Finding): { ok: boolean; reason?: string } {
  if (f.state === "superseded") return { ok: false, reason: "This finding was superseded by a correction." };
  if (f.state === "needs_review") return { ok: false, reason: "A fact this finding depends on changed. Review it first." };
  return { ok: true };
}

/** A proposal (guarantee, shipping promise, proof, option) is never shown as a product fact. */
export const findingLabel = (f: Finding) => (f.sensitive_topic || f.is_suggestion ? "Proposal, needs approval" : "Finding");

export type RunListing = { listing_id: string; clicks: number | null; orders: number | null; spend: number | null; options: Option[] };
/** Differences between two checks of the same listing. Windows overlap, so figures are compared, never summed. */
export function diffChecks(prev: RunListing, cur: RunListing) {
  const changes: string[] = [];
  const pm = new Map(prev.options.map((o) => [o.label, o])), cm = new Map(cur.options.map((o) => [o.label, o]));
  for (const [l, o] of cm) {
    const p = pm.get(l);
    if (!p) changes.push(`New option: ${l} at $${o.price.toFixed(2)}`);
    else if (p.price !== o.price) changes.push(`${l}: $${p.price.toFixed(2)} to $${o.price.toFixed(2)}`);
  }
  for (const l of pm.keys()) if (!cm.has(l)) changes.push(`Option removed: ${l}`);
  for (const k of ["clicks", "orders", "spend"] as const) {
    if (prev[k] !== null && cur[k] !== null && prev[k] !== cur[k]) changes.push(`${k}: ${prev[k]} to ${cur[k]} (30-day windows overlap)`);
  }
  return changes;
}
