// Recurring gift calendar: occasion placement for the Calendar, occasion details, the promotion picker, and the
// rules for linking a promotion to an occasion. Occasions are context: a linked promotion keeps its own dates.
import type { Router } from "../router";
import { query, one } from "../db";
import { badRequest, notFound } from "../http";
import { atLeast } from "../auth";
import { occurrence, tbcText, monthName, type GiftRule } from "../../shared/giftCalendar";
import { formatRange } from "../../shared/dates";

type Occ = { id: string; name: string; kind: "dated" | "year_round"; category: string | null; rule: GiftRule | null; month_label: string; timing_text: string;
  themes: string | null; lead_in: string | null; lead_in_month: number | null; seasonal: boolean; parent_id: string | null; brands: string[] };

const OCC_SQL = `select o.*, coalesce((select array_agg(b.business_id order by b.business_id) from gift_occasion_brands b where b.occasion_id = o.id), '{}') brands
                   from gift_occasions o where o.active`;
const yearsOf = (from: string, to: string) => { const out: number[] = []; for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y); return out; };

async function overridesFor(years: number[]) {
  const rows = await query<any>(`select occasion_id, year, to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e from gift_occasion_overrides where year = any($1::int[])`, [years]);
  return new Map(rows.map((r) => [`${r.occasion_id}:${r.year}`, { start: r.s, end: r.e }]));
}
export const datesText = (o: Pick<Occ, "rule" | "kind">, year: number, ov?: { start: string; end: string } | null) => {
  if (o.kind !== "dated" || !o.rule) return "Year-round";
  const x = occurrence(o.rule, year, ov);
  return x.tbc ? tbcText(x.month) : formatRange(x);
};

/** Calendar entries for gift occasions in [from, to]. One entry per occasion and year, listing every applicable brand. */
export async function giftCalendarItems(from: string, to: string, business: string | null, seasonal: boolean) {
  const all = await query<Occ>(OCC_SQL);
  const parentOf = new Map(all.map((o) => [o.id, o.parent_id ?? o.id]));
  const occs = all.filter((o) => o.kind === "dated" && !o.parent_id && (!business || o.brands.includes(business)) && (seasonal || !o.seasonal));
  const years = yearsOf(from, to);
  const ovs = await overridesFor(years);
  const links = await query<any>(
    `select gift_occasion_id id, gift_occasion_year y, count(*)::int n from promotions
      where gift_occasion_id is not null and gift_occasion_year = any($1::int[]) and ($2::text is null or business_id = $2) group by 1, 2`, [years, business]);
  const linked = new Map<string, number>();   // a child's links (e.g. Teacher Appreciation Day) count on its parent's entry
  for (const l of links) { const k = `${parentOf.get(l.id) ?? l.id}:${l.y}`; linked.set(k, (linked.get(k) ?? 0) + l.n); }
  const items: any[] = [], undated: any[] = [];
  for (const o of occs) for (const y of years) {
    const x = occurrence(o.rule!, y, ovs.get(`${o.id}:${y}`));
    if (x.tbc) {
      const m = `${y}-${String(x.month).padStart(2, "0")}`;
      if (m >= from.slice(0, 7) && m <= to.slice(0, 7)) undated.push({ occasionId: o.id, year: y, title: o.name, text: tbcText(x.month), brands: o.brands });
      continue;
    }
    if (x.end < from || x.start > to) continue;
    items.push({ type: "gift", id: `${o.id}:${y}`, occasionId: o.id, year: y, title: o.name, start: x.start, end: x.end, brands: o.brands, business: null,
      seasonal: o.seasonal, detail: o.themes, linkedPromotions: linked.get(`${o.id}:${y}`) ?? 0 });
  }
  return { items, undated };
}

/** Validates a promotion's occasion link. Dated occasions need the occurrence year; year-round ones take none. */
export async function checkGiftLink(occasionId: string | null | undefined, year: number | null | undefined, business: string) {
  if (!occasionId) { if (year != null) throw badRequest("An occurrence year needs a gift occasion."); return { id: null, year: null }; }
  const o = await one<Occ>(`${OCC_SQL} and o.id = $1`, [occasionId]);
  if (!o) throw badRequest("Unknown gift occasion.");
  if (!o.brands.includes(business)) throw badRequest(`${o.name} is not a gift occasion for this brand.`);
  if (o.kind === "dated") { if (year == null) throw badRequest(`Choose which year of ${o.name} this promotion is for.`); return { id: o.id, year }; }
  if (year != null) throw badRequest(`${o.name} is year-round; it has no occurrence year.`);
  return { id: o.id, year: null };
}

export function registerGifts(r: Router) {
  // Picker list (dated and year-round), with each dated occasion's dates for the years asked for.
  r.get("/gift-occasions", async ({ url }) => {
    const y = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
    const years = [y - 1, y, y + 1];
    const ovs = await overridesFor(years);
    return (await query<Occ>(`${OCC_SQL} order by o.sort_order`)).map((o) => ({
      id: o.id, name: o.name, kind: o.kind, category: o.category, month: o.month_label, timing: o.timing_text, brands: o.brands, parent: o.parent_id,
      seasonal: o.seasonal, dates: o.kind === "dated" ? Object.fromEntries(years.map((yy) => [yy, datesText(o, yy, ovs.get(`${o.id}:${yy}`))])) : null,
      // Placement per year (null when the dates are not confirmed), so a form can pick the occurrence a campaign leads into.
      ranges: o.kind === "dated" ? Object.fromEntries(years.map((yy) => { const x = occurrence(o.rule!, yy, ovs.get(`${o.id}:${yy}`)); return [yy, x.tbc ? null : { start: x.start, end: x.end }]; })) : null,
    }));
  });

  // Promotions that could be linked to this occasion: applicable brands, dated around the occurrence, not linked to it yet.
  r.get("/gift-occasions/:id/candidates", async ({ url, params }) => {
    const o = await one<Occ>(`${OCC_SQL} and o.id = $1`, [params.id]);
    if (!o) throw notFound("Gift occasion");
    const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
    const business = url.searchParams.get("business") || null;
    return query(
      `select p.id, p.title, p.business_id business, p.execution_status status, to_char(p.start_date,'YYYY-MM-DD') start_date, to_char(p.end_date,'YYYY-MM-DD') end_date,
              p.gift_occasion_id, p.gift_occasion_year, g.name gift_occasion_name
         from promotions p left join gift_occasions g on g.id = p.gift_occasion_id
        where p.business_id = any($1::text[]) and ($2::text is null or p.business_id = $2) and p.kind = 'promotion'
          and p.start_date between make_date($3 - 1, 7, 1) and make_date($3, 12, 31)
          and not (p.gift_occasion_id is not distinct from $4 and (p.gift_occasion_year is not distinct from $5))
        order by p.start_date desc limit 200`, [o.brands, business, year, o.id, o.kind === "dated" ? year : null]);
  });

  r.get("/gift-occasions/:id", async ({ url, params, session }) => {
    const o = await one<Occ>(`${OCC_SQL} and o.id = $1`, [params.id]);
    if (!o) throw notFound("Gift occasion");
    const business = url.searchParams.get("business") || null;
    const yParam = url.searchParams.get("year");
    const year = yParam ? Number(yParam) : null;
    if (o.kind === "dated" && (!year || year < 2000 || year > 2100)) throw badRequest("year is required for a dated occasion");
    const ovs = year ? await overridesFor([year]) : new Map();
    const x = o.kind === "dated" && year ? occurrence(o.rule!, year, ovs.get(`${o.id}:${year}`)) : null;
    const children = await query<Occ>(`${OCC_SQL} and o.parent_id = $1 order by o.sort_order`, [o.id]);
    const ids = [o.id, ...children.map((c) => c.id)];
    const promos = await query<any>(
      `select p.id, p.title, p.business_id business, p.execution_status status, p.gift_occasion_id occasion, p.gift_occasion_year occasion_year,
              to_char(p.start_date,'YYYY-MM-DD') start_date, to_char(p.end_date,'YYYY-MM-DD') end_date, to_char(p.prep_deadline,'YYYY-MM-DD') prep_deadline,
              coalesce((select json_agg(json_build_object('title', t.title, 'status', t.status, 'due_date', to_char(t.due_date,'YYYY-MM-DD')) order by t.due_date nulls last)
                          from tasks t where t.promotion_id = p.id and t.status <> 'cancelled'), '[]') tasks
         from promotions p
        where p.gift_occasion_id = any($1::text[]) and ($2::int is null or p.gift_occasion_year = $2 or (p.gift_occasion_year is null and extract(year from p.start_date) = $2))
          and ($3::text is null or p.business_id = $3)
        order by p.start_date nulls last, p.business_id`, [ids, year, business]);
    return {
      occasion: { id: o.id, name: o.name, kind: o.kind, category: o.category, month: o.month_label, timing: o.timing_text, themes: o.themes,
        leadIn: o.lead_in, leadInMonth: o.lead_in_month ? monthName(o.lead_in_month) : null, seasonal: o.seasonal, brands: o.brands },
      year, dates: x && !x.tbc ? { start: x.start, end: x.end } : null, datesText: year ? datesText(o, year, ovs.get(`${o.id}:${year}`)) : "Year-round",
      within: children.map((c) => ({ id: c.id, name: c.name, timing: c.timing_text, themes: c.themes, datesText: year ? datesText(c, year) : null })),
      promotions: promos, canCreate: atLeast(session, "editor"),
    };
  });
}
