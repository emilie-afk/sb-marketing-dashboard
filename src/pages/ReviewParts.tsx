// Pieces shared by the private review queues (Slack Review and Corporate Gifts): the status button that opens the
// row's actions in place, and the searchable occasion picker. Nothing here navigates away from the queue.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useApi, Drawer, BUSINESS_NAMES } from "../lib";

export type MenuAction = { label: string; hint?: string; onClick: () => void; disabled?: boolean };

/** "To review ▾": a button that opens the row's actions in place (Escape or a click outside closes it). */
export function StatusMenu({ label, tone = "warn", actions, busy }: { label: string; tone?: string; actions: MenuAction[]; busy?: boolean }) {
  // The menu is placed against the window (not the table), so it is never clipped by the scrolling table; it opens
  // upwards near the bottom of the screen, and closes on Escape, a click outside, or scrolling.
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const open = !!pos;
  const setOpen = (v: boolean) => {
    if (!v) return setPos(null);
    const r = ref.current!.getBoundingClientRect();
    const right = Math.max(8, innerWidth - r.right);
    setPos(r.bottom + 280 > innerHeight && r.top > 280 ? { bottom: innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  };
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : e.type === "scroll" || !ref.current?.contains(e.target as Node)) setPos(null); };
    addEventListener("mousedown", close); addEventListener("keydown", close); addEventListener("scroll", close, true);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", close); removeEventListener("scroll", close, true); };
  }, [open]);
  return <span className="status-menu" ref={ref}>
    <button type="button" className={`chip ${tone} action`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
      {busy ? "Working…" : label} <span aria-hidden="true">▾</span></button>
    {open && <span className="menu" role="menu" style={pos!}>{actions.map((a) => <button key={a.label} type="button" role="menuitem" disabled={a.disabled}
      onClick={(e) => { e.stopPropagation(); setOpen(false); a.onClick(); }}><b>{a.label}</b>{a.hint && <span className="sub">{a.hint}</span>}</button>)}</span>}
  </span>;
}

export const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");

/** Searchable picker of dated occasions across last, this and next year: name, dates and year on every choice. */
export function OccasionPicker({ title, business, current, prepDate, onPick, onClear, onClose, busy, error }: {
  title: string; business?: string | null; current?: { id: string; year: number } | null; prepDate?: string | null;
  onPick: (o: { id: string; year: number }, prepDate: string | null) => void; onClear: (prepDate: string | null) => void; onClose: () => void; busy?: boolean; error?: string | null;
}) {
  const thisYear = new Date().getUTCFullYear();
  const s = useApi<any[]>(`/gift-occasions?year=${thisYear}`, [thisYear]);
  const [q, setQ] = useState("");
  const [prep, setPrep] = useState(prepDate ?? "");
  const options = useMemo(() => {
    const out: { id: string; year: number; name: string; dates: string; start: string }[] = [];
    for (const o of s.data ?? []) {
      if (o.kind !== "dated" || o.parent || (business && !o.brands.includes(business))) continue;
      for (const y of Object.keys(o.dates ?? {}).map(Number)) out.push({ id: o.id, year: y, name: o.name, dates: o.dates[y], start: o.ranges?.[y]?.start ?? `${y}-12-31` });
    }
    const n = q.trim().toLowerCase();
    return out.filter((x) => !n || `${x.name} ${x.year}`.toLowerCase().includes(n)).sort((a, b) => a.start.localeCompare(b.start));
  }, [s.data, q, business]);
  return <Drawer onClose={onClose}>
    <h2>Set occasion</h2>
    <p className="sub">For “{title}”. Linking an occasion only classifies the suggestion: it publishes nothing and creates no task. Later scans keep your choice.</p>
    {error && <div className="notice" role="alert">{error}</div>}
    <label className="stack-form" style={{ display: "block" }}><span>Prep date (optional, used when there is no task deadline)</span>
      <input type="date" aria-label="Prep date" value={prep} onChange={(e) => setPrep(e.target.value)} /></label>
    <input type="search" autoFocus placeholder="Search occasions, e.g. Black Friday or 2027" aria-label="Search occasions" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", margin: "8px 0" }} />
    {business && <p className="sub">Occasions for {BUSINESS_NAMES[business] ?? business}.</p>}
    <ul className="list picker" role="listbox" aria-label="Occasions">
      {options.map((o) => { const on = current?.id === o.id && current.year === o.year;
        return <li key={`${o.id}:${o.year}`}><button type="button" role="option" aria-selected={on} className={`pick ${on ? "on" : ""}`} disabled={busy} onClick={() => onPick({ id: o.id, year: o.year }, prep || null)}>
          <b>{o.name}</b> <span className="chip muted">{o.year}</span><span className="sub">{o.dates}</span></button></li>; })}
      {s.data && !options.length && <li className="sub">No occasion matches “{q}”.</li>}
    </ul>
    <div className="row" style={{ marginTop: 10 }}>
      {current && <button type="button" className="btn small" disabled={busy} onClick={() => onClear(prep || null)}>Clear the occasion</button>}
      <button type="button" className="btn small" onClick={onClose}>Cancel</button>
    </div>
  </Drawer>;
}
