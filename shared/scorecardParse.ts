// Reads the two team spreadsheets that hold correct figures by calendar day and by calendar month:
//   - the Daily Analytics Report: one tab per month ("October  2026"), a row per channel, two columns per day
//     (revenue, then order count);
//   - the EOS scorecard: one tab per year ("2026"), weekly columns plus a "TOTAL (MONTH)" column per month, whose
//     figures include month-end adjustments (returns, Amazon shipping).
// Both are read only. Each month becomes one submission per business; only figures actually present are sent.
import type { Sheet, Cell } from "./calendarParse";
import { daysInMonth } from "./dates";

export type MetricObs = { metric: string; scope: string; scope_label?: string; period_start: string; period_end: string; granularity: "day" | "month"; value: number };
export type MonthBatch = { business: "sb" | "p2s"; month: string; observations: MetricObs[]; notes: string[] };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const label = (c: Cell) => (c === null || c === undefined ? "" : String(c)).replace(/\s+/g, " ").trim();
/** A number from a cell: numbers as they are, "$1,234.50" style text, blanks and errors as null. */
export function amount(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  if (typeof c !== "string") return null;
  const t = c.trim().replace(/[$\s]/g, "");
  if (!/^-?[\d,]*\.?\d+$/.test(t)) return null;
  const v = Number(t.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}
const round2 = (v: number) => Math.round(v * 100) / 100;

export const SCOPE_LABELS = {
  sb_all: "Succulents Box total", p2s_all: "Etsy + KDP",
  "channel:online_store": "Shopify website", "channel:amazon": "Amazon (excl. shipping)", "channel:faire": "Faire",
} as const;

/** "October  2026", "Sep 2024" → { y, m }, or null for other tabs. */
export function monthTab(name: string) {
  const m = /^([A-Za-z]{3,9})\s+(\d{4})$/.exec(name.trim());
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  return mon ? { y: Number(m[2]), m: mon } : null;
}

/**
 * Daily Analytics Report → daily revenue and orders.
 * Succulents Box: every channel row above "Little Sunnie" (its total is "all"; Website, Amazon and Faire are also
 * sent as channels). Little Sunnie is left out. P2S: the rows under "Photostosketches" (Etsy + KDP).
 * A day counts as reported once its Website revenue cell has a number. Blank channel cells on a reported day are 0.
 */
export function parseDailyAnalytics(sheets: Sheet[], opts: { fromYear?: number; through: string }): MonthBatch[] {
  const out: MonthBatch[] = [];
  for (const sh of sheets) {
    const tab = monthTab(sh.name);
    if (!tab || tab.y < (opts.fromYear ?? 2024)) continue;
    const head = sh.rows.findIndex((r) => amount(r?.[1]) === 1 && amount(r?.[3]) === 2);
    if (head < 0) continue;
    type Row = { label: string; cells: Cell[] };
    const sections: Record<"sb" | "ls" | "p2s", Row[]> = { sb: [], ls: [], p2s: [] };
    let sec: "sb" | "ls" | "p2s" = "sb";
    for (let i = head + 1; i < sh.rows.length; i++) {
      const r = sh.rows[i] ?? [], l = label(r[0]);
      if (!l) continue;
      if (/^total$/i.test(l)) break;
      if (/^little sunnie$/i.test(l)) { sec = "ls"; continue; }
      if (/^photostosketches$/i.test(l)) { sec = "p2s"; continue; }
      sections[sec].push({ label: l, cells: r });
    }
    const sbNotes: string[] = [], p2sNotes: string[] = [];
    const sb: MetricObs[] = [], p2s: MetricObs[] = [];
    const ym = `${tab.y}-${pad(tab.m)}`;
    for (let d = 1; d <= daysInMonth(tab.y, tab.m); d++) {
      const day = `${ym}-${pad(d)}`;
      if (day > opts.through) break;
      const col = 1 + (d - 1) * 2;
      const web = sections.sb.find((r) => /^website$/i.test(r.label));
      if (!web || amount(web.cells[col]) === null) continue;
      const sum = (rows: Row[], k: 0 | 1) => round2(rows.reduce((a, r) => a + (amount(r.cells[col + k]) ?? 0), 0));
      const add = (arr: MetricObs[], metric: string, scope: string, value: number, scope_label?: string) =>
        arr.push({ metric, scope, scope_label, period_start: day, period_end: day, granularity: "day", value });
      add(sb, "revenue", "all", sum(sections.sb, 0), SCOPE_LABELS.sb_all);
      add(sb, "orders", "all", sum(sections.sb, 1), SCOPE_LABELS.sb_all);
      const blankOrders = sections.sb.filter((r) => (amount(r.cells[col]) ?? 0) > 0 && amount(r.cells[col + 1]) === null).map((r) => r.label);
      if (blankOrders.length) sbNotes.push(`${day}: no order count for ${blankOrders.join(", ")}`);
      for (const [scope, re] of [["channel:online_store", /^website$/i], ["channel:amazon", /^amazon\b/i], ["channel:faire", /^faire\b/i]] as const) {
        const row = sections.sb.find((r) => re.test(r.label));
        if (!row) continue;
        add(sb, "revenue", scope, round2(amount(row.cells[col]) ?? 0), SCOPE_LABELS[scope]);
        add(sb, "orders", scope, round2(amount(row.cells[col + 1]) ?? 0), SCOPE_LABELS[scope]);
      }
      if (sections.p2s.length && sections.p2s.some((r) => amount(r.cells[col]) !== null)) {
        add(p2s, "revenue", "all", sum(sections.p2s, 0), SCOPE_LABELS.p2s_all);
        add(p2s, "orders", "all", sum(sections.p2s, 1), SCOPE_LABELS.p2s_all);
      }
    }
    if (sb.length) out.push({ business: "sb", month: ym, observations: sb, notes: sbNotes });
    if (p2s.length) out.push({ business: "p2s", month: ym, observations: p2s, notes: p2sNotes });
  }
  return out;
}

/**
 * EOS scorecard → month totals, for months that have ended and have an "All" revenue figure.
 * Revenue (Succulents Box total = All − Little Sunnie − Photostosketches; Website, Amazon, Faire; P2S), the US
 * website funnel rates, and ad spend (Succulents Box total and per platform; P2S). Blank and error cells are skipped,
 * never sent as zero.
 */
export function parseEosMonths(sheets: Sheet[], opts: { fromYear?: number; today: string }): MonthBatch[] {
  const out: MonthBatch[] = [];
  for (const sh of sheets) {
    if (!/^\d{4}$/.test(sh.name.trim())) continue;
    const year = Number(sh.name.trim());
    if (year < (opts.fromYear ?? 2024)) continue;
    const r3 = sh.rows[2] ?? [], r4 = sh.rows[3] ?? [];
    const width = Math.max(r3.length, r4.length);
    for (let c = 0; c < width; c++) {
      if (!/^total\s*\(month\)/i.test(label(r4[c]))) continue;
      const mm = /^([A-Za-z]{3})/.exec(label(r3[c]));
      const mon = mm ? MONTHS[mm[1].toLowerCase()] : undefined;
      if (!mon) continue;
      const start = `${year}-${pad(mon)}-01`, end = `${year}-${pad(mon)}-${pad(daysInMonth(year, mon))}`;
      if (end >= opts.today) continue;                       // the month has not ended: its column is not final
      let section = "";
      const val: Record<string, number | null> = {};
      for (const row of sh.rows) {
        const a = label(row?.[0]), b = label(row?.[1]);
        if (a) section = /^revenue/i.test(a) ? "rev" : /^conversion/i.test(a) ? "conv" : /^human/i.test(a) ? "bot" : /^ads/i.test(a) ? "ads" : /^highlight/i.test(a) ? "hl" : a.toLowerCase();
        if (!b) continue;
        val[`${section}|${b.toLowerCase()}`] = amount(row[c]);
      }
      const all = val["rev|all"];
      if (all === null || all === undefined) continue;
      const sb: MetricObs[] = [], p2s: MetricObs[] = [];
      const add = (arr: MetricObs[], metric: string, scope: string, v: number | null | undefined, scope_label?: string) => {
        if (v === null || v === undefined) return;
        arr.push({ metric, scope, scope_label, period_start: start, period_end: end, granularity: "month", value: metric.endsWith("_rate") ? v : round2(v) });
      };
      const ls = val["rev|little sunnie"] ?? 0, p2sRev = val["rev|photostosketches"];
      // Years before P2S was added have no Photostosketches row (0); a row left blank means the month isn't final.
      if (p2sRev !== null) add(sb, "revenue", "all", all - ls - (p2sRev ?? 0), SCOPE_LABELS.sb_all);
      add(sb, "revenue", "channel:online_store", val["rev|shopify (website)"], SCOPE_LABELS["channel:online_store"]);
      add(sb, "revenue", "channel:amazon", val["rev|amazon (w/o shipping)"], SCOPE_LABELS["channel:amazon"]);
      add(sb, "revenue", "channel:faire", val["rev|faire"], SCOPE_LABELS["channel:faire"]);
      add(sb, "add_to_cart_rate", "all", val["conv|added to cart"]);
      add(sb, "checkout_rate", "all", val["conv|reached check out"]);
      add(sb, "conversion_rate", "all", val["conv|converted"]);
      const g = val["ads|google ads sb"], f = val["ads|facebook ads sb"];
      add(sb, "ad_spend", "platform:google", g, "Google Ads");
      add(sb, "ad_spend", "platform:facebook", f, "Meta (Facebook) Ads");
      // The total row is a formula that shows 0 for an empty month, so it is only used when a platform is filled in.
      if ((g !== null && g !== undefined) || (f !== null && f !== undefined)) add(sb, "ad_spend", "all", val["ads|total ad spent (succulents box)"], SCOPE_LABELS.sb_all);
      add(p2s, "revenue", "all", p2sRev, SCOPE_LABELS.p2s_all);
      add(p2s, "ad_spend", "all", val["ads|photostosketches"], "Etsy Ads");
      const month = start.slice(0, 7);
      if (sb.length) out.push({ business: "sb", month, observations: sb, notes: [] });
      if (p2s.length) out.push({ business: "p2s", month, observations: p2s, notes: [] });
    }
  }
  return out;
}
