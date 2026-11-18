// Suggests which gift occasion (and which year of it) a Slack suggestion is about. Used when a suggestion arrives and
// for older suggestions that were never matched. It only ever SUGGESTS: the planning owner confirms, changes or clears
// the link, and her choice is never overwritten by a rescan.
//
// Rules:
// - Only dated occasions, matched by their name or an alias as whole words (case, apostrophes and punctuation ignored).
//   Broad words such as "holiday" are not aliases, so "holiday email" stays unclassified instead of becoming Christmas.
// - Where two names overlap, the longer wins ("Teacher Appreciation Day" is not also "Teacher Appreciation Week").
// - The suggestion's business narrows the occasions to the ones that apply to it.
// - The year: a single year written in the message wins; otherwise the occurrence the exact deadline leads into;
//   otherwise the next occurrence after the message was posted, when it is within ~6 months. When the year is not
//   clear (two years written, or the next occurrence is far off), both years are offered and nothing is preselected.
// - One clear match is preselected (still unconfirmed). Several possible matches are listed, none preselected.
import { occurrence, type GiftRule } from "./giftCalendar";
import { addDays } from "./dates";

export type MatchOccasion = { id: string; name: string; aliases: string[]; brands: string[]; rule: GiftRule | null; kind: string; parent_id?: string | null };
export type MatchInput = { title: string; brief?: string | null; excerpt?: string | null; deadline_text?: string | null; business?: string | null; due_date?: string | null; posted_at: string };
export type Candidate = { id: string; name: string; year: number; matched: string; start: string | null; end: string | null; tbc: boolean };
export type MatchResult = { status: "suggested" | "ambiguous" | "unmatched"; occasion_id: string | null; occasion_year: number | null; candidates: Candidate[] };

/** Lowercase words only: "Mother’s Day!" → "mothers day", "BF/CM" → "bf cm". */
export function normalize(s: string) {
  return ` ${s.toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

const NEAR_DAYS = 200;
type Ov = Map<string, { start: string; end: string }>;
const place = (o: MatchOccasion, y: number, ovs?: Ov) => {
  const x = occurrence(o.rule!, y, ovs?.get(`${o.id}:${y}`));
  return x.tbc ? { start: null, end: null, tbc: true, sortEnd: `${y}-${String(x.month).padStart(2, "0")}-28` } : { start: x.start, end: x.end, tbc: false, sortEnd: x.end };
};

export function matchOccasion(input: MatchInput, occasions: MatchOccasion[], overrides?: Ov): MatchResult {
  const text = normalize([input.title, input.brief, input.excerpt, input.deadline_text].filter(Boolean).join(" \n "));
  const pool = occasions.filter((o) => o.kind === "dated" && o.rule && !o.parent_id && (!input.business || o.brands.includes(input.business)));
  // Every phrase occurrence as a span; longer spans win over spans they contain.
  const spans: { o: MatchOccasion; phrase: string; from: number; to: number }[] = [];
  for (const o of pool) for (const p of [o.name, ...(o.aliases ?? [])]) {
    const n = normalize(p);
    if (n.trim().length < 2) continue;
    for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) spans.push({ o, phrase: p, from: i, to: i + n.length });
  }
  spans.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const kept: typeof spans = [];
  for (const s of spans) if (!kept.some((k) => s.from >= k.from && s.to <= k.to && k.o.id !== s.o.id)) kept.push(s);
  const found = new Map<string, { o: MatchOccasion; phrase: string }>();
  for (const s of kept) if (!found.has(s.o.id)) found.set(s.o.id, { o: s.o, phrase: s.phrase });
  if (!found.size) return { status: "unmatched", occasion_id: null, occasion_year: null, candidates: [] };

  const years = [...new Set((text.match(/ (20[2-9][0-9]) /g) ?? []).map((y) => Number(y.trim())))];
  const posted = (input.posted_at || "").slice(0, 10);
  const candidates: Candidate[] = [];
  let unclearYear = false;
  for (const { o, phrase } of found.values()) {
    let ys: number[];
    if (years.length === 1) ys = years;
    else if (years.length > 1) { ys = years.slice(0, 3); unclearYear = true; }
    else if (input.due_date) {
      const y0 = Number(input.due_date.slice(0, 4));
      ys = [[y0, y0 + 1].find((y) => place(o, y, overrides).sortEnd >= input.due_date!) ?? y0 + 1];
    } else {
      const y0 = Number(posted.slice(0, 4)) || new Date().getUTCFullYear();
      const next = [y0, y0 + 1].find((y) => place(o, y, overrides).sortEnd >= posted) ?? y0 + 1;
      const p = place(o, next, overrides);
      if ((p.start ?? p.sortEnd) <= addDays(posted, NEAR_DAYS)) ys = [next];
      else { ys = [next - 1, next]; unclearYear = true; }
    }
    for (const y of ys) { const p = place(o, y, overrides); candidates.push({ id: o.id, name: o.name, year: y, matched: phrase, start: p.start, end: p.end, tbc: p.tbc }); }
  }
  const list = candidates.slice(0, 6);
  if (list.length === 1 && !unclearYear) return { status: "suggested", occasion_id: list[0].id, occasion_year: list[0].year, candidates: list };
  return { status: "ambiguous", occasion_id: null, occasion_year: null, candidates: list };
}
