// "Next two quarters": the planning timeline at the top of Marketing Planning → Plans.
//
// The window is the two calendar quarters after the current one (on 2026-11-18: January–June 2027), shown as six month
// columns. Each column lists the upcoming gift occasions (public reference data, shown even without a plan) and the
// plans this person may see (server rule: visibleSql), including category-only plans with no occasion. Prep start,
// campaign dates and occasion dates are kept apart; a prep date computed for an occasion with no plan is marked as a
// suggestion, and an occasion whose dates are not confirmed shows its month only (no invented day).
//
// The planning owner also sees, per occasion, her Slack Review suggestions that she has confirmed for that occasion,
// with the task due date or her manual prep date ("Prep date needed" when neither is set). Nobody else gets any
// suggestion data, draft plan, or count of either: they are not in the answer at all.
import type { Session } from "./auth";
import { query } from "./db";
import { visibleSql, isPlanningOwner, planningToday, BUSINESS_LABEL } from "./planning";
import { occurrence, tbcText, type GiftRule } from "../shared/giftCalendar";
import { addDays, daysInMonth, formatRange } from "../shared/dates";
import { trackerOrigin } from "./adapters/taskTracker";

/** Suggested prep start for an occasion with no plan: seven weeks before it (the plan form's default). */
export const SUGGESTED_PREP_DAYS = 49;

const ym = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
export function twoQuarterWindow(today: string) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const first = y * 12 + (Math.floor((m - 1) / 3) + 1) * 3;   // month index of the next quarter's first month
  const months = Array.from({ length: 6 }, (_, i) => ym(first + i));
  const last = months[5];
  return { months, from: `${months[0]}-01`, to: `${last}-${String(daysInMonth(Number(last.slice(0, 4)), Number(last.slice(5, 7)))).padStart(2, "0")}` };
}

export async function planningTimeline(s: Session, f: { business?: string | null; category?: string | null; seasonal?: boolean }) {
  const owner = isPlanningOwner(s);
  const today = planningToday();
  const w = twoQuarterWindow(today);
  const years = [...new Set([w.from.slice(0, 4), w.to.slice(0, 4)].map(Number))];
  const colOf = (d: string) => (d < w.from ? w.months[0] : d.slice(0, 7));

  // ---- occasions in the window (one entry per occasion and year; children such as Teacher Appreciation Day sit in their parent)
  const occs = await query<any>(
    `select o.id, o.name, o.rule, o.seasonal, o.themes,
            coalesce((select array_agg(b.business_id order by b.business_id) from gift_occasion_brands b where b.occasion_id = o.id), '{}') brands
       from gift_occasions o where o.active and o.kind = 'dated' and o.parent_id is null order by o.sort_order`);
  const ovRows = await query<any>(`select occasion_id, year, to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e from gift_occasion_overrides where year = any($1::int[])`, [years]);
  const ovs = new Map(ovRows.map((r) => [`${r.occasion_id}:${r.year}`, { start: r.s, end: r.e }]));
  const entries = new Map<string, any>();
  for (const o of occs) {
    if (f.business && !o.brands.includes(f.business)) continue;
    if (f.seasonal === false && o.seasonal) continue;
    for (const y of years) {
      const x = occurrence(o.rule as GiftRule, y, ovs.get(`${o.id}:${y}`));
      if (x.tbc) {
        const m = `${y}-${String(x.month).padStart(2, "0")}`;
        if (!w.months.includes(m)) continue;
        entries.set(`gift:${o.id}:${y}`, { key: `gift:${o.id}:${y}`, kind: "occasion", month: m, occasion: { id: o.id, name: o.name, year: y, start: null, end: null, tbc: true, text: tbcText(x.month), brands: o.brands, seasonal: o.seasonal },
          suggested_prep: null, plans: [], suggestions: [] });
        continue;
      }
      if (x.end < w.from || x.start > w.to) continue;
      entries.set(`gift:${o.id}:${y}`, { key: `gift:${o.id}:${y}`, kind: "occasion", month: colOf(x.start),
        occasion: { id: o.id, name: o.name, year: y, start: x.start, end: x.end, tbc: false, text: formatRange(x), brands: o.brands, seasonal: o.seasonal },
        suggested_prep: addDays(x.start, -SUGGESTED_PREP_DAYS), plans: [], suggestions: [] });
    }
  }

  // ---- plans this person may see: linked to an occasion above, or with campaign dates in the window
  const params: unknown[] = [w.from, w.to, years];
  const vis = visibleSql(s, params);
  const plans = await query<any>(
    `select p.id, p.name, p.business_id, p.status, p.gift_occasion_id, p.occurrence_year, p.categories, g.name occasion_name,
            to_char(p.prep_start,'YYYY-MM-DD') prep_start, to_char(p.campaign_start,'YYYY-MM-DD') campaign_start, to_char(p.campaign_end,'YYYY-MM-DD') campaign_end
       from marketing_plans p left join gift_occasions g on g.id = p.gift_occasion_id
      where ((p.campaign_end >= $1::date and p.campaign_start <= $2::date) or (p.gift_occasion_id is not null and p.occurrence_year = any($3::int[]))) and ${vis}
      order by p.prep_start, p.name`, params);
  for (const p of plans) {
    if (f.business && p.business_id !== f.business) continue;
    if (f.category && !(p.categories ?? []).some((c: string) => c.toLowerCase() === f.category!.toLowerCase())) continue;
    const view = { id: p.id, name: p.name, business: p.business_id, business_name: BUSINESS_LABEL[p.business_id] ?? p.business_id, categories: p.categories ?? [],
      prep_start: p.prep_start, campaign_start: p.campaign_start, campaign_end: p.campaign_end, ...(owner ? { status: p.status } : {}) };
    const e = p.gift_occasion_id ? entries.get(`gift:${p.gift_occasion_id}:${p.occurrence_year}`) : null;
    if (e) { e.plans.push(view); continue; }
    if (p.campaign_end < w.from || p.campaign_start > w.to) continue;   // linked to an occasion outside the window, campaign outside too
    entries.set(`plan:${p.id}`, { key: `plan:${p.id}`, kind: "plan", month: colOf(p.campaign_start), occasion: p.gift_occasion_id ? { id: p.gift_occasion_id, name: p.occasion_name, year: p.occurrence_year } : null,
      suggested_prep: null, plans: [view], suggestions: [] });
  }

  // ---- the owner's confirmed Slack suggestions, grouped under their occasion (owner only)
  if (owner) {
    const sug = await query<any>(
      `select s.id, s.title, s.status, s.business_id, s.occasion_id, s.occasion_year, s.delivery_status, s.tracker_task_id,
              to_char(s.due_date,'YYYY-MM-DD') due_date, to_char(s.prep_date,'YYYY-MM-DD') prep_date,
              to_char(coalesce(case when r.removed_at is null then r.due_date end, s.tracker_due_date),'YYYY-MM-DD') task_due, s.tracker_assignee_name assignee
         from review_suggestions s left join tracker_task_records r on r.record_id = 'task:' || s.tracker_task_id::text and r.kind = 'task'
        where s.occasion_status = 'confirmed' and s.occasion_year = any($1::int[]) and s.status in ('pending', 'planned', 'approved')
        order by s.posted_at`, [years]);
    const o = trackerOrigin();
    for (const x of sug) {
      if (f.business && x.business_id && x.business_id !== f.business) continue;
      const e = entries.get(`gift:${x.occasion_id}:${x.occasion_year}`);
      if (!e) continue;
      const created = x.delivery_status === "created";
      const prep = created && x.task_due ? { date: x.task_due, kind: "task_due" } : x.due_date ? { date: x.due_date, kind: "task_due" } : x.prep_date ? { date: x.prep_date, kind: "manual" } : null;
      e.suggestions.push({ id: x.id, title: x.title, status: x.status, assignee: x.assignee, prep, task: created, open_url: created && o ? `${o}/#/tasks/${x.tracker_task_id}` : null });
    }
  }

  // With a category filter, only entries holding a plan in that category are left (occasions without one are hidden).
  let list = [...entries.values()];
  if (f.category) list = list.filter((e) => e.plans.length);
  for (const e of list) {
    // The earliest preparation date for the entry: its plans' prep starts, else the suggested one; and the owner's items.
    const dates = [...(e.plans.length ? e.plans.map((p: any) => p.prep_start) : e.suggested_prep ? [e.suggested_prep] : []), ...e.suggestions.map((x: any) => x.prep?.date).filter(Boolean)];
    e.earliest_prep = dates.length ? dates.sort()[0] : null;
    e.start_now = !!e.earliest_prep && e.earliest_prep < w.from;
    e.sort = e.occasion?.start ?? e.plans[0]?.campaign_start ?? `${e.month}-15`;
  }
  list.sort((a, b) => a.sort.localeCompare(b.sort) || (a.occasion?.name ?? a.plans[0]?.name ?? "").localeCompare(b.occasion?.name ?? b.plans[0]?.name ?? ""));
  return { today, window: { from: w.from, to: w.to }, months: w.months, owner, entries: list.map(({ sort, ...e }) => e),
    note: "Occasion dates are all-day U.S. dates. A suggested prep start is seven weeks before the occasion; start a plan to set your own." };
}
