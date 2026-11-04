// Parses the free-text dates used in the planning spreadsheets, e.g.
// "Nov 1–12, 2026", "26-Nov", "Jan 12 - 20", "Nov 26–Jan 1", "Nov 26, 2026–Jan 1, 2027", "Fri, Dec 4, 2026",
// "Nov 27 / Nov 30, 2026". A missing year comes from the spreadsheet's registered year.
import { daysInMonth } from "./dates";

const MON: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const monthOf = (s: string) => MON[s.toLowerCase().replace(/\.$/, "")];
const pad = (n: number) => String(n).padStart(2, "0");

export type ParsedDates =
  | { ok: true; start: string; end: string; multiple?: string[] }
  | { ok: false; reason: string };

function mk(y: number, m: number, d: number): string | null {
  if (!m || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

type Tok = { m: number; d: number; y?: number };
const MD = String.raw`([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?`;
const DM = String.raw`(\d{1,2})[\s-]([A-Za-z]{3,9})(?:[\s-](\d{4}))?`;

function token(s: string): Tok | null {
  let m = new RegExp(`^${MD}$`).exec(s);
  if (m && monthOf(m[1])) return { m: monthOf(m[1]), d: Number(m[2]), y: m[3] ? Number(m[3]) : undefined };
  m = new RegExp(`^${DM}$`).exec(s);
  if (m && monthOf(m[2])) return { m: monthOf(m[2]), d: Number(m[1]), y: m[3] ? Number(m[3]) : undefined };
  return null;
}

export function parseDateText(raw: unknown, defaultYear: number): ParsedDates {
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    const s = `${raw.getUTCFullYear()}-${pad(raw.getUTCMonth() + 1)}-${pad(raw.getUTCDate())}`;
    return { ok: true, start: s, end: s };
  }
  let t = String(raw ?? "").trim();
  if (!t) return { ok: false, reason: "empty" };
  t = t.replace(/[\u2013\u2014\u2212]/g, "-").replace(/\s+/g, " ")
    .replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\s+/i, "");

  // Lists such as "Nov 27 / Nov 30, 2026": several separate dates, flagged as multiple.
  if (t.includes("/")) {
    const parts = t.split("/").map((p) => p.trim());
    const toks = parts.map(token);
    if (toks.every(Boolean)) {
      const y = toks.map((k) => k!.y).filter(Boolean).pop() ?? defaultYear;
      const ds = toks.map((k) => mk(k!.y ?? y, k!.m, k!.d));
      if (ds.every(Boolean)) {
        const sorted = (ds as string[]).sort();
        return { ok: true, start: sorted[0], end: sorted[sorted.length - 1], multiple: sorted };
      }
    }
    return { ok: false, reason: "unrecognized list of dates" };
  }

  const single = token(t);
  if (single) {
    const d = mk(single.y ?? defaultYear, single.m, single.d);
    return d ? { ok: true, start: d, end: d } : { ok: false, reason: "invalid day" };
  }

  // Ranges: "<a> - <b>" where b may be just a day number.
  const dash = t.split(/\s*-\s*(?=[A-Za-z]{3,9}\.?\s+\d|\d{1,2}(?:,?\s*\d{4})?$)/);
  if (dash.length === 2) {
    const a = token(dash[0].trim());
    let b = token(dash[1].trim());
    if (a && !b) {
      const m = /^(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(dash[1].trim());
      if (m) b = { m: a.m, d: Number(m[1]), y: m[2] ? Number(m[2]) : undefined };
    }
    if (a && b) {
      let ey = b.y ?? a.y ?? defaultYear;
      let sy = a.y ?? (b.y !== undefined && a.m > b.m ? b.y - 1 : ey);
      if (a.y === undefined && b.y === undefined && a.m > b.m) ey = sy + 1;   // "Nov 26 - Jan 1" crosses the year
      if (a.y !== undefined && b.y === undefined && a.m > b.m) ey = a.y + 1;
      const s = mk(sy, a.m, a.d), e = mk(ey, b.m, b.d);
      if (!s || !e) return { ok: false, reason: "invalid day" };
      if (e < s) return { ok: false, reason: "end before start" };
      return { ok: true, start: s, end: e };
    }
  }
  return { ok: false, reason: "unrecognized date text" };
}

/** Percent from "15%", "15.0%", "0.15" (a spreadsheet percent cell), "10" in a % column, or "17% off". */
export function parsePercent(raw: unknown, assumePercentNumber = false): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw <= 1 && !assumePercentNumber ? round4(raw * 100) : raw;
  const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*(off)?\s*$/i.exec(String(raw));
  if (!m) return null;
  return Number(m[1]);
}
const round4 = (v: number) => Math.round(v * 10000) / 10000;
