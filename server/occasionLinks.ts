// Occasion links for Slack Review suggestions: the matcher's input (active dated occasions with their aliases, brands
// and confirmed per-year dates) and how a linked occasion is described. Private to the planning owner's queue.
import type pg from "pg";
import { query } from "./db";
import { matchOccasion, type MatchOccasion, type MatchResult } from "../shared/occasionMatch";
import { occurrence, tbcText, type GiftRule } from "../shared/giftCalendar";
import { formatRange } from "../shared/dates";

export type OccasionIndex = { list: MatchOccasion[]; byId: Map<string, MatchOccasion>; overrides: Map<string, { start: string; end: string }> };

export async function loadOccasionIndex(db?: pg.PoolClient): Promise<OccasionIndex> {
  const run = (sql: string) => (db ? db.query(sql).then((r) => r.rows) : query<any>(sql));
  const list: MatchOccasion[] = (await run(
    `select o.id, o.name, o.kind, o.rule, o.parent_id, o.aliases,
            coalesce((select array_agg(b.business_id order by b.business_id) from gift_occasion_brands b where b.occasion_id = o.id), '{}') brands
       from gift_occasions o where o.active order by o.sort_order`)).map((o: any) => ({ ...o, aliases: o.aliases ?? [] }));
  const ov = await run(`select occasion_id, year, to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e from gift_occasion_overrides`);
  return { list, byId: new Map(list.map((o) => [o.id, o])), overrides: new Map(ov.map((r: any) => [`${r.occasion_id}:${r.year}`, { start: r.s, end: r.e }])) };
}

/** Where the occurrence falls: dates, or "to be confirmed" with no invented day. */
export function placeOccasion(idx: OccasionIndex, id: string, year: number) {
  const o = idx.byId.get(id);
  if (!o?.rule) return null;
  const x = occurrence(o.rule as GiftRule, year, idx.overrides.get(`${id}:${year}`));
  return x.tbc ? { start: null, end: null, tbc: true, month: x.month, text: tbcText(x.month) } : { start: x.start, end: x.end, tbc: false, month: Number(x.start.slice(5, 7)), text: formatRange(x) };
}

export function matchSuggestion(idx: OccasionIndex, s: { title: string; brief?: string | null; excerpt?: string | null; deadline_text?: string | null;
  business_id?: string | null; suggested_business?: string | null; due_date?: string | null; suggested_due_date?: string | null; posted_at: string | Date }): MatchResult {
  const posted = s.posted_at instanceof Date ? s.posted_at.toISOString() : String(s.posted_at);
  return matchOccasion({ title: s.title, brief: s.brief, excerpt: s.excerpt, deadline_text: s.deadline_text, business: s.business_id ?? s.suggested_business ?? null,
    due_date: s.due_date ?? s.suggested_due_date ?? null, posted_at: posted }, idx.list, idx.overrides);
}

/** Stores the matcher's suggestion on a suggestion that has never been matched (never over the owner's choice). */
export async function storeMatch(c: pg.PoolClient, id: string, m: MatchResult) {
  await c.query(`update review_suggestions set occasion_status = $2, occasion_id = $3, occasion_year = $4, occasion_candidates = $5, occasion_matched_at = now()
                  where id = $1 and occasion_matched_at is null and occasion_status in ('unmatched', 'suggested', 'ambiguous')`,
    [id, m.status, m.occasion_id, m.occasion_year, JSON.stringify(m.candidates)]);
}
