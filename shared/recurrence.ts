// Occurrences of a recurring task inside a window. The task stays one record; occurrences are computed.
import { addDays, daysInMonth, DateRange } from "./dates";

export type Recurrence = string | null; // 'daily' | 'weekly:<1-7, ISO Monday=1>' | 'monthly:<1-31|last>'

export function occurrences(rule: Recurrence, anchor: string, window: DateRange, until?: string | null): string[] {
  if (!rule) return anchor >= window.start && anchor <= window.end ? [anchor] : [];
  const out: string[] = [];
  const end = until && until < window.end ? until : window.end;
  const first = anchor > window.start ? anchor : window.start;
  if (rule === "daily") { for (let d = first; d <= end; d = addDays(d, 1)) out.push(d); return out; }
  let m = /^weekly:([1-7])$/.exec(rule);
  if (m) {
    const target = Number(m[1]);
    for (let d = first; d <= end; d = addDays(d, 1)) {
      const wd = new Date(d + "T00:00:00Z").getUTCDay() || 7;
      if (wd === target) out.push(d);
    }
    return out;
  }
  m = /^monthly:(\d{1,2}|last)$/.exec(rule);
  if (m) {
    let y = Number(first.slice(0, 4)), mo = Number(first.slice(5, 7));
    for (let i = 0; i < 400; i++) {
      const dim = daysInMonth(y, mo);
      const day = m[1] === "last" ? dim : Math.min(Number(m[1]), dim);   // the 31st becomes the month's last day
      const d = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (d > end) break;
      if (d >= first) out.push(d);
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    return out;
  }
  throw new Error(`unknown recurrence ${rule}`);
}
