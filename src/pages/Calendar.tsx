import { useState } from "react";
import { useApi, Async, Tabs, range, BUSINESS_NAMES, api } from "../lib";
import { addDays, todayIn, OPERATIONS_TZ } from "../../shared/dates";
import { PromotionDrawer } from "./Business";

const TYPES: [string, string][] = [["occasion", "Occasions"], ["promotion", "Promotions"], ["launch", "Launches and milestones"], ["task", "Task deadlines"]];

function monthGrid(month: string) {
  const first = `${month}-01`;
  const wd = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7;   // Monday first
  const start = addDays(first, -wd);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function CalendarPage() {
  const today = todayIn(OPERATIONS_TZ);
  const [view, setView] = useState("month");
  const [anchor, setAnchor] = useState(today);
  const [business, setBusiness] = useState("");
  const [types, setTypes] = useState(TYPES.map(([k]) => k));
  const [open, setOpen] = useState<string | null>(null);
  const month = anchor.slice(0, 7);
  const days = view === "month" ? monthGrid(month) : view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(anchor, i - ((new Date(anchor + "T00:00:00Z").getUTCDay() + 6) % 7))) : [];
  const from = view === "list" ? anchor : days[0], to = view === "list" ? addDays(anchor, 60) : days[days.length - 1];
  const s = useApi<any>(`/calendar?from=${from}&to=${to}&types=${types.join(",")}${business ? `&business=${business}` : ""}`, [from, to, types, business]);
  const step = (n: number) => setAnchor(view === "month" ? `${addMonthsStr(month, n)}-01` : addDays(anchor, n * (view === "week" ? 7 : 30)));
  const title = view === "month" ? new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : range({ start: from, end: to });
  const openItem = (it: any) => { if (it.type === "promotion" || it.type === "launch" || it.type === "deadline") setOpen(it.id); else if (it.type === "task" && it.source === "tracker" && typeof it.open_url === "string" && it.open_url.startsWith("https://")) window.open(it.open_url, "_blank", "noopener,noreferrer"); else if (it.type === "task") location.hash = "#/tasks"; };
  return (
    <div>
      <Tabs tabs={[["month", "Month"], ["week", "Week"], ["list", "List"]]} value={view} onChange={setView} />
      <div className="toolbar">
        <button className="btn small" onClick={() => step(-1)} aria-label="Previous">Previous</button><b>{title}</b><button className="btn small" onClick={() => step(1)} aria-label="Next">Next</button>
        <button className="btn small" onClick={() => setAnchor(today)}>Today</button>
        <label>Business <select value={business} onChange={(e) => setBusiness(e.target.value)}><option value="">All</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {TYPES.map(([k, l]) => <button key={k} className={`chip ${types.includes(k) ? "on" : ""}`} aria-pressed={types.includes(k)} onClick={() => setTypes(types.includes(k) ? types.filter((x) => x !== k) : [...types, k])}>{l}</button>)}
      </div>
      <Async s={s}>{(d) => <>
        <p className="sub">{d.timezoneNote} An occasion becomes a promotion only when it is selected for use.</p>
        {view === "list" ? <ListView items={d.items} onOpen={openItem} /> : (
          <div className="cal">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => <div key={x} className="dow">{x}</div>)}
            {days.map((day) => {
              const evs = d.items.filter((it: any) => it.start <= day && it.end >= day && (it.type !== "promotion" || it.start === day || day === days[0] || new Date(day + "T00:00:00Z").getUTCDay() === 1));
              return <div key={day} className={`day ${view === "month" && !day.startsWith(month) ? "out" : ""} ${day === today ? "today" : ""}`} style={view === "week" ? { minHeight: 220 } : undefined}>
                <div>{Number(day.slice(8))}</div>
                {evs.slice(0, view === "week" ? 12 : 4).map((it: any, i: number) => <a key={i} href="#" className={`ev ${it.type}`} title={`${it.title} (${range(it)})`} onClick={(e) => { e.preventDefault(); openItem(it); }}>{it.title}</a>)}
                {evs.length > (view === "week" ? 12 : 4) && <div className="sub">+{evs.length - (view === "week" ? 12 : 4)} more</div>}
              </div>; })}
          </div>)}
      </>}</Async>
      {open && <PromotionDrawer id={open} role="editor" onClose={() => setOpen(null)} />}
    </div>
  );
}
const addMonthsStr = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); const i = y * 12 + mo - 1 + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; };

function ListView({ items, onOpen }: { items: any[]; onOpen: (it: any) => void }) {
  if (!items.length) return <div className="state">Nothing scheduled in this range.</div>;
  return <div className="table-wrap"><table><thead><tr><th>Dates</th><th>Type</th><th>Item</th><th>Business</th><th>Status</th><th></th></tr></thead>
    <tbody>{items.map((it, i) => <tr key={i} className="clickable" onClick={() => onOpen(it)}><td>{range(it)}</td><td><span className={`ev ${it.type}`} style={{ display: "inline-block" }}>{it.type}</span></td>
      <td>{it.title}{it.detail ? <span className="sub"> · {it.detail}</span> : null}</td><td>{BUSINESS_NAMES[it.business]}</td><td>{it.status ?? ""}{it.review === "needs_review" ? " (needs review)" : ""}</td>
      <td>{it.type === "occasion" && !it.promotionId && <button className="btn small" onClick={async (e) => { e.stopPropagation(); await api(`/occasions/${it.id}/select`, { method: "POST" }); location.reload(); }}>Use for a promotion</button>}</td></tr>)}</tbody></table></div>;
}
