// Plans a one-way spreadsheet sync. Pure: takes parsed rows plus what the dashboard already holds and returns
// the operations to apply. Never deletes; flags removals, conflicts and ambiguous matches for review.
import { SourcePromotion, SOURCE_FIELDS, SourceField, ParsedWorkbook, TabReport } from "./calendarParse";

export type SourceRole = "annual_calendar" | "seasonal_program" | "intake";
/** Higher wins when two sources describe the same promotion. The seasonal program owns its months. */
export const ROLE_PRECEDENCE: Record<SourceRole, number> = { seasonal_program: 2, annual_calendar: 1, intake: 0 };

export type ExistingLink = { identityKey: string; promotionId: string; lastTab: string | null; lastSeenAt: string | null };
export type ExistingPromotion = {
  id: string;
  code: string | null;
  kind: string;
  start_date: string | null;
  end_date: string | null;
  missing_from_source_since: string | null;
  fields: Partial<Record<SourceField, unknown>>;
  /** Roles of other sources linked to this promotion. */
  otherSourceRoles: SourceRole[];
};

export type ReviewOp = { kind: "conflict" | "removed_from_source" | "ambiguous_match" | "unparsed_date" | "blank_tab"; promotionId?: string; details: Record<string, unknown> };
export type SyncPlan = {
  create: { key: string; record: SourcePromotion }[];
  link: { key: string; promotionId: string; record: SourcePromotion }[];   // existing promotion, new link for this source
  update: { promotionId: string; key: string; changes: Record<string, { from: unknown; to: unknown }>; record: SourcePromotion }[];
  unchanged: { promotionId: string; key: string; record: SourcePromotion }[];
  touchLinks: { promotionId: string; key: string; record: SourcePromotion }[];
  missing: { promotionId: string; key: string }[];
  reappeared: string[];
  reviews: ReviewOp[];
};

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);

function diff(existing: Partial<Record<SourceField, unknown>>, rec: SourcePromotion) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of SOURCE_FIELDS) {
    const to = (rec as any)[f];
    if (to === undefined) continue;              // this tab does not carry the field
    if (!same(existing[f], to)) changes[f] = { from: existing[f] ?? null, to: to ?? null };
  }
  return changes;
}

const CONFLICT_FIELDS: SourceField[] = ["start_date", "end_date", "code", "customer_discount", "vendor_cost_reduction", "offer"];

export function planSync(args: {
  role: SourceRole;
  parsed: ParsedWorkbook;
  links: ExistingLink[];                 // links held by THIS source
  promotions: ExistingPromotion[];       // candidate promotions for the same business and year
}): SyncPlan {
  const { role, parsed, links, promotions } = args;
  const plan: SyncPlan = { create: [], link: [], update: [], unchanged: [], touchLinks: [], missing: [], reappeared: [], reviews: [] };
  const byId = new Map(promotions.map((p) => [p.id, p]));
  const linkByKey = new Map(links.map((l) => [l.identityKey, l]));

  // 1. Group rows by identity. The same promotion can sit in two monthly tabs; values must agree.
  const groups = new Map<string, SourcePromotion[]>();
  for (const r of parsed.promotions) groups.set(r.identityKey, [...(groups.get(r.identityKey) ?? []), r]);

  const seenKeys = new Set<string>();
  const claimed = new Set<string>();       // promotion ids matched in this run
  const unmatched: { key: string; rec: SourcePromotion }[] = [];

  for (const [key, rows] of groups) {
    const designated = rows.filter((r) => !r.crossCheckOnly);
    const rec = designated[0] ?? rows[0];
    for (const other of rows.filter((x) => x !== rec)) {
      const d = CONFLICT_FIELDS.filter((f) => (other as any)[f] !== undefined && (rec as any)[f] !== undefined && !same((other as any)[f], (rec as any)[f]));
      if (d.length) plan.reviews.push({ kind: "conflict", details: { identity: key, fields: d, tabs: [rec.tab, other.tab], rows: [rec.row, other.row], message: "Two rows for the same promotion disagree. The first designated row was used." } });
    }
    if (!designated.length) {
      // A summary row with nothing designated to check against: report, never create.
      plan.reviews.push({ kind: "ambiguous_match", details: { identity: key, tab: rec.tab, row: rec.row, message: "Summary row has no matching row in the designated tab, so no record was created." } });
      continue;
    }
    if (rec.dateIssue) plan.reviews.push({ kind: "unparsed_date", details: { identity: key, tab: rec.tab, row: rec.row, dateText: rec.date_text, issue: rec.dateIssue } });
    seenKeys.add(key);

    const link = linkByKey.get(key);
    if (link && byId.has(link.promotionId)) { applyExisting(byId.get(link.promotionId)!, key, rec, true); claimed.add(link.promotionId); continue; }
    // Cross-source match by code (the same promotion listed in the annual calendar and the seasonal program).
    const codeMatch = rec.code ? promotions.filter((p) => p.code === rec.code && !claimed.has(p.id)) : [];
    if (codeMatch.length === 1) { plan.link.push({ key, promotionId: codeMatch[0].id, record: rec }); applyExisting(codeMatch[0], key, rec, false); claimed.add(codeMatch[0].id); continue; }
    if (codeMatch.length > 1) { plan.reviews.push({ kind: "ambiguous_match", details: { identity: key, candidates: codeMatch.map((p) => p.id), message: "Several promotions share this code." } }); continue; }
    unmatched.push({ key, rec });
  }

  // 2. Links not seen this run.
  const blankTabs = new Set(parsed.tabs.filter((t: TabReport) => t.blank).map((t) => t.tab));
  const unseenLinks = links.filter((l) => !seenKeys.has(l.identityKey) && byId.has(l.promotionId));

  // 3. Renamed or moved rows: an unmatched row with the same kind and dates as exactly one unseen link is that promotion.
  for (const { key, rec } of unmatched) {
    const cands = unseenLinks.filter((l) => {
      const p = byId.get(l.promotionId)!;
      return !claimed.has(p.id) && p.kind === rec.kind && p.start_date === rec.start_date && p.end_date === rec.end_date && rec.start_date !== null;
    });
    if (cands.length === 1) {
      const p = byId.get(cands[0].promotionId)!;
      plan.link.push({ key, promotionId: p.id, record: rec });
      applyExisting(p, key, rec, false);
      claimed.add(p.id);
      plan.reviews.push({ kind: "ambiguous_match", promotionId: p.id, details: { identity: key, previousIdentity: cands[0].identityKey, message: "Row looks renamed (same dates). Linked to the existing promotion; please confirm." } });
    } else if (cands.length > 1) {
      plan.reviews.push({ kind: "ambiguous_match", details: { identity: key, candidates: cands.map((c) => c.promotionId), message: "Several existing promotions could match this row. Nothing was created." } });
    } else {
      plan.create.push({ key, record: rec });
    }
  }

  for (const l of unseenLinks) {
    if (claimed.has(l.promotionId)) continue;
    if (l.lastTab && blankTabs.has(l.lastTab)) {
      plan.reviews.push({ kind: "blank_tab", promotionId: l.promotionId, details: { tab: l.lastTab, message: "The tab is now blank. The promotion was kept unchanged; a blank tab is not a cancellation." } });
      continue;
    }
    const p = byId.get(l.promotionId)!;
    if (!p.missing_from_source_since) {
      plan.missing.push({ promotionId: l.promotionId, key: l.identityKey });
      plan.reviews.push({ kind: "removed_from_source", promotionId: l.promotionId, details: { identity: l.identityKey, tab: l.lastTab, message: "No longer found in the spreadsheet. Kept in the dashboard until reviewed." } });
    }
  }
  return plan;

  function applyExisting(p: ExistingPromotion, key: string, rec: SourcePromotion, linked: boolean) {
    if (p.missing_from_source_since) plan.reappeared.push(p.id);
    const outranked = p.otherSourceRoles.some((r) => ROLE_PRECEDENCE[r] > ROLE_PRECEDENCE[role]);
    const changes = diff(p.fields, rec);
    if (outranked) {
      const conflicts = CONFLICT_FIELDS.filter((f) => changes[f]);
      if (conflicts.length) plan.reviews.push({ kind: "conflict", promotionId: p.id, details: { identity: key, fields: conflicts, values: Object.fromEntries(conflicts.map((f) => [f, changes[f]])), message: "This spreadsheet disagrees with the source that owns this promotion. The owner's values were kept." } });
      if (linked) plan.touchLinks.push({ promotionId: p.id, key, record: rec });
      return;
    }
    if (Object.keys(changes).length) plan.update.push({ promotionId: p.id, key, changes, record: rec });
    else plan.unchanged.push({ promotionId: p.id, key, record: rec });
  }
}
