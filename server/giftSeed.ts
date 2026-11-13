// Seeds the recurring gift calendar from shared/giftCalendar.ts. Safe to rerun: occasions are upserted by their
// stable id (so promotion links survive), brands are reconciled, and per-year date overrides are only inserted
// when missing, so a date confirmed later in the database is never overwritten.
import type pg from "pg";
import { GIFT_OCCASIONS, GIFT_OVERRIDES } from "../shared/giftCalendar";

export async function seedGiftOccasions(db: pg.Pool | pg.PoolClient) {
  const exists = (await db.query("select to_regclass('public.gift_occasions') is not null as ok")).rows[0].ok;
  if (!exists) return;
  const brands = new Set((await db.query("select id from businesses")).rows.map((r: any) => r.id));
  // Parents first so parent_id references resolve.
  const ordered = [...GIFT_OCCASIONS].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
  for (const o of ordered) {
    await db.query(
      `insert into gift_occasions (id, name, kind, category, rule, month_label, timing_text, themes, lead_in, lead_in_month, seasonal, parent_id, sort_order, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
       on conflict (id) do update set name = excluded.name, kind = excluded.kind, category = excluded.category, rule = excluded.rule,
         month_label = excluded.month_label, timing_text = excluded.timing_text, themes = excluded.themes, lead_in = excluded.lead_in,
         lead_in_month = excluded.lead_in_month, seasonal = excluded.seasonal, parent_id = excluded.parent_id, sort_order = excluded.sort_order`,
      [o.id, o.name, o.kind, o.category ?? null, o.rule ? JSON.stringify(o.rule) : null, o.month, o.timing, o.themes ?? null, o.leadIn ?? null,
        o.leadInMonth ?? null, !!o.seasonal, o.parent ?? null, GIFT_OCCASIONS.indexOf(o)]);
    const want = o.brands.filter((b) => brands.has(b));
    await db.query("delete from gift_occasion_brands where occasion_id = $1 and not (business_id = any($2::text[]))", [o.id, want]);
    for (const b of want) await db.query("insert into gift_occasion_brands (occasion_id, business_id) values ($1,$2) on conflict do nothing", [o.id, b]);
  }
  for (const v of GIFT_OVERRIDES)
    await db.query("insert into gift_occasion_overrides (occasion_id, year, start_date, end_date, note) values ($1,$2,$3,$4,$5) on conflict do nothing",
      [v.occasion, v.year, v.start, v.end, v.note ?? null]);
}
