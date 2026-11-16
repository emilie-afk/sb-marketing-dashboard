import { useState } from "react";
import { useApi, Async, Tabs, range, BUSINESS_NAMES, api, Drawer, useHashQuery } from "../lib";
import { addDays, todayIn, OPERATIONS_TZ } from "../../shared/dates";
import { PromotionDrawer } from "./Business";
import { GiftDrawer, PromotionForm, type Role } from "./GiftCalendar";

const TYPES: [string, string][] = [["gift", "Gift occasions"], ["occasion", "Occasions"], ["promotion", "Promotions"], ["launch", "Launches and milestones"], ["task", "Task deadlines"]];
const LEGEND: [string, string][] = [["gift", "Gift occasion"], ["occasion", "Spreadsheet occasion"], ["promotion", "Promotion"], ["launch", "Launch or milestone"], ["task", "Task"], ["deadline", "Prep deadline"]];

function monthGrid(month: string) {
  const first = `${month}-01`;
  const wd = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7;   // Monday first
  const start = addDays(first, -wd);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

const VIEWS: [string, string][] = [["agenda", "Upcoming occasions"], ["month", "Month grid"], ["week", "Week"], ["list", "List"]];

export function CalendarPage({ role = "viewer" }: { role?: Role }) {
  const today = todayIn(OPERATIONS_TZ);
  const [q, setQ] = useHashQuery();
  const view = VIEWS.some(([k]) => k === q.get("view")) ? q.get("view")! : "agenda";
  const business = q.get("business") ?? "";
  const seasonal = q.get("seasonal") !== "0";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") ?? "") ? q.get("date")! : today;
  const types = (q.get("types") ?? TYPES.map(([k]) => k).join(",")).split(",").filter(Boolean);
  const [open, setOpen] = useState<string | null>(null);
  const [gift, setGift] = useState<{ id: string; year: number } | null>(null);
  const [sheetOcc, setSheetOcc] = useState<any | null>(null);
  const [dayAgenda, setDayAgenda] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const month = anchor.slice(0, 7);
  const days = view === "month" ? monthGrid(month) : view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(anchor, i - ((new Date(anchor + "T00:00:00Z").getUTCDay() + 6) % 7))) : [];
  const from = view === "list" ? anchor : days[0], to = view === "list" ? addDays(anchor, 60) : days[days.length - 1];
  const s = useApi<any>(view === "agenda" ? null : `/calendar?from=${from}&to=${to}&types=${types.join(",")}${business ? `&business=${business}` : ""}${seasonal ? "" : "&seasonal=0"}`, [view, from, to, types.join(","), business, seasonal]);
  const step = (n: number) => setQ({ date: view === "month" ? `${addMonthsStr(month, n)}-01` : addDays(anchor, n * (view === "week" ? 7 : 30)) });
  const title = view === "month" ? new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : view === "agenda" ? "" : range({ start: from, end: to });
  const openItem = (it: any) => { if (it.type === "gift") setGift({ id: it.occasionId, year: it.year }); else if (it.type === "promotion" || it.type === "launch" || it.type === "deadline") setOpen(it.id); else if (it.type === "task" && it.source === "tracker" && typeof it.open_url === "string" && it.open_url.startsWith("https://")) window.open(it.open_url, "_blank", "noopener,noreferrer"); else if (it.type === "task") location.hash = "#/tasks"; else if (it.type === "occasion") setSheetOcc({ title: it.title, start: it.start, end: it.end, brands: [it.business], ids: [{ id: it.id, business: it.business, selected: !!it.promotionId }], promotions: [] }); };
  const limit = view === "week" ? 12 : 4;
  return (
    <div>
      <Tabs tabs={VIEWS} value={view} onChange={(v) => setQ({ view: v === "agenda" ? null : v }, { push: true })} />
      <div className="toolbar">
        {view !== "agenda" && <><button className="btn small" onClick={() => step(-1)} aria-label="Previous">Previous</button><b>{title}</b><button className="btn small" onClick={() => step(1)} aria-label="Next">Next</button>
          <button className="btn small" onClick={() => setQ({ date: null })}>Today</button></>}
        <label>Business <select value={business} onChange={(e) => setQ({ business: e.target.value || null })}><option value="">All</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {view === "agenda" ? <label>Occasion type <select value={q.get("otype") ?? "all"} onChange={(e) => setQ({ otype: e.target.value === "all" ? null : e.target.value })}><option value="all">All occasions</option><option value="gift">Gift occasions</option><option value="sheet">Spreadsheet occasions</option></select></label>
          : TYPES.map(([k, l]) => <button key={k} className={`chip ${types.includes(k) ? "on" : ""}`} aria-pressed={types.includes(k)} onClick={() => setQ({ types: (types.includes(k) ? types.filter((x) => x !== k) : [...types, k]).join(",") })}>{l}</button>)}
        <button className={`chip ${seasonal ? "on" : ""}`} aria-pressed={seasonal} onClick={() => setQ({ seasonal: seasonal ? "0" : null })} title="Multi-week windows such as wedding season and back to school">Seasonal windows</button>
        {role !== "viewer" && <button className="btn small" onClick={() => setCreating(true)}>New promotion</button>}
      </div>
      {view === "agenda" ? <Agenda q={q} setQ={setQ} today={today} business={business} seasonal={seasonal} onGift={setGift} onSheet={setSheetOcc} onPromotion={setOpen} /> : <>
      <div className="row legend" aria-label="Legend">{LEGEND.map(([k, l]) => <span key={k} className={`ev ${k}`}>{l}</span>)}<span className="ev gift season">Seasonal window</span></div>
      <Async s={s}>{(d) => <>
        <p className="sub">{d.timezoneNote} An occasion becomes a promotion only when it is selected for use.</p>
        {d.undated?.length > 0 && <p className="sub">{d.undated.map((u: any) => <a key={`${u.occasionId}:${u.year}`} href="#" onClick={(e) => { e.preventDefault(); setGift({ id: u.occasionId, year: u.year }); }}>{u.title}: {u.text}</a>)}</p>}
        {view === "list" ? <ListView items={d.items} onOpen={openItem} /> : (
          <div className="cal">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => <div key={x} className="dow">{x}</div>)}
            {days.map((day) => {
              // Multi-day promotions and gift windows show on their first day and at the start of each week, not every day.
              const evs = d.items.filter((it: any) => it.start <= day && it.end >= day && ((it.type !== "promotion" && it.type !== "gift") || it.start === day || day === days[0] || new Date(day + "T00:00:00Z").getUTCDay() === 1));
              return <div key={day} className={`day ${view === "month" && !day.startsWith(month) ? "out" : ""} ${day === today ? "today" : ""}`} style={view === "week" ? { minHeight: 220 } : undefined}>
                <div>{Number(day.slice(8))}</div>
                {evs.slice(0, limit).map((it: any, i: number) => <a key={i} href="#" className={`ev ${it.type}${it.seasonal ? " season" : ""}${it.read_only ? " ro" : ""}`} title={`${TYPE_NAME[it.type] ?? it.type}: ${it.title} (${range(it)})${it.type === "gift" ? ` · ${it.brands.map((b: string) => BUSINESS_NAMES[b]).join(", ")}${it.linkedPromotions ? ` · ${it.linkedPromotions} linked promotion${it.linkedPromotions === 1 ? "" : "s"}` : ""}` : ""}`} onClick={(e) => { e.preventDefault(); openItem(it); }}>{it.title}</a>)}
                {evs.length > limit && <a href="#" className="more" onClick={(e) => { e.preventDefault(); setDayAgenda(day); }}>+{evs.length - limit} more</a>}
              </div>; })}
          </div>)}
        {dayAgenda && <Drawer onClose={() => setDayAgenda(null)}><h2>{new Date(`${dayAgenda}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}</h2>
          <ul className="list">{d.items.filter((it: any) => it.start <= dayAgenda && it.end >= dayAgenda).map((it: any, i: number) => <li key={i}><a href="#" className={`ev ${it.type}${it.seasonal ? " season" : ""}`} style={{ display: "inline-block" }} onClick={(e) => { e.preventDefault(); setDayAgenda(null); openItem(it); }}>{TYPE_NAME[it.type] ?? it.type}</a> <b>{it.title}</b>
            <div className="sub">{range(it)} · {it.type === "gift" ? it.brands.map((b: string) => BUSINESS_NAMES[b]).join(", ") : BUSINESS_NAMES[it.business]}{it.status ? ` · ${({ todo: "To do", in_progress: "In progress", waiting: "Waiting", done: "Done", cancelled: "Cancelled" } as Record<string, string>)[it.status] ?? it.status}` : ""}{it.read_only ? " · Task Tracker (read-only)" : ""}</div></li>)}</ul></Drawer>}
      </>}</Async></>}
      {open && <PromotionDrawer id={open} role={role} onClose={() => { setOpen(null); s.reload(); }} />}
      {gift && !open && <GiftDrawer occasionId={gift.id} year={gift.year} business={business} role={role} onClose={() => { setGift(null); s.reload(); }} onOpenPromotion={(id) => setOpen(id)} />}
      {sheetOcc && !open && <SheetOccasionDrawer occ={sheetOcc} role={role} onClose={() => setSheetOcc(null)} onOpenPromotion={(id) => setOpen(id)} />}
      {creating && <NewPromotion business={business} onClose={() => { setCreating(false); s.reload(); }} />}
    </div>
  );
}

const TYPE_NAME: Record<string, string> = { gift: "Gift occasion", occasion: "Occasion", promotion: "Promotion", launch: "Launch", task: "Task", deadline: "Prep deadline" };
const monthTitle = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function Agenda({ q, setQ, today, business, seasonal, onGift, onSheet, onPromotion }: any) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get("from") ?? "") ? q.get("from") : today;
  const to = addDays(from, 89);
  const otype = q.get("otype") ?? "all";
  const s = useApi<any>(`/occasions/agenda?from=${from}&to=${to}&type=${otype}${business ? `&business=${business}` : ""}${seasonal ? "" : "&seasonal=0"}`, [from, otype, business, seasonal]);
  return <>
    <div className="row" style={{ marginBottom: 6 }}>
      <b>{from === today ? "Next 90 days" : `90 days from ${new Date(`${from}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`}</b>
      <label className="sub">Jump to month <input type="month" value={from.slice(0, 7)} onChange={(e) => e.target.value && setQ({ from: `${e.target.value}-01` })} /></label>
      {from !== today && <button className="btn small" onClick={() => setQ({ from: null })}>Back to next 90 days</button>}
    </div>
    <Async s={s}>{(d) => {
      if (!d.items.length) return <div className="state">No occasions in this range{business ? ` for ${BUSINESS_NAMES[business]}` : ""}. Try another month or occasion type.</div>;
      const months = new Map<string, any[]>();
      for (const it of d.items) { const m = (it.inProgress ? from : it.start).slice(0, 7); months.set(m, [...(months.get(m) ?? []), it]); }
      return <>
        <p className="sub">{d.note} Routine tasks live in Marketing Tasks; preparation tasks for a campaign show inside its occasion.</p>
        {[...months.entries()].map(([m, list]) => <section key={m}>
          <h3 className="agenda-month">{monthTitle(m)}</h3>
          {list.map((it: any) => <div key={it.key} className="agenda-row">
            <div className="when">{it.tbc ? "Dates to be confirmed" : range({ start: it.start, end: it.end })}{it.inProgress ? <div className="sub">In progress</div> : null}</div>
            <div>
              <a href="#" onClick={(e) => { e.preventDefault(); it.kind === "gift" ? onGift({ id: it.occasionId, year: it.year }) : onSheet(it); }}><b>{it.title}</b></a>
              <span className={`ev ${it.kind === "gift" ? "gift" : "occasion"}${it.seasonal ? " season" : ""}`} style={{ display: "inline-block", marginLeft: 6 }}>{it.kind === "gift" ? (it.seasonal ? "Seasonal window" : "Gift occasion") : `Spreadsheet occasion${it.occasionType ? ` · ${it.occasionType}` : ""}`}</span>
              <div className="sub">{it.brands.map((b: string) => BUSINESS_NAMES[b] ?? b).join(" and ")}{it.monthLabel && it.seasonal ? ` · ${it.monthLabel}` : ""}</div>
              {it.leadIn && <div className="lead">{it.title} · {it.monthLabel} · {it.leadIn.replace(/^Start the campaign/, "Start planning")}</div>}
              <div className="sub">{it.promotions.length ? <>Linked: {it.promotions.map((p: any, i: number) => <span key={p.id}>{i ? ", " : ""}<a href="#" onClick={(e) => { e.preventDefault(); onPromotion(p.id); }}>{p.title}</a> ({BUSINESS_NAMES[p.business]}, {p.status})</span>)}</> : "No linked promotion yet"}</div>
            </div>
          </div>)}
        </section>)}
      </>;
    }}</Async>
  </>;
}

function SheetOccasionDrawer({ occ, role, onClose, onOpenPromotion }: { occ: any; role: Role; onClose: () => void; onOpenPromotion: (id: string) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  return <Drawer onClose={onClose}>
    <h2>{occ.title}</h2>
    <p className="sub">{range({ start: occ.start, end: occ.end })} · from the promotion spreadsheet</p>
    <dl className="kv"><dt>Businesses</dt><dd>{occ.brands.map((b: string) => BUSINESS_NAMES[b]).join(" and ")}</dd>{occ.occasionType && <><dt>Type</dt><dd>{occ.occasionType}</dd></>}{occ.note && <><dt>Note</dt><dd>{occ.note}</dd></>}</dl>
    <h3 style={{ marginTop: 14 }}>Linked promotions</h3>
    {occ.promotions.length ? <ul className="list">{occ.promotions.map((p: any) => <li key={p.id}><a href="#" onClick={(e) => { e.preventDefault(); onOpenPromotion(p.id); }}><b>{p.title}</b></a> <span className="chip">{BUSINESS_NAMES[p.business]}</span> <span className="chip muted">{p.status}</span><div className="sub">Open it to see its preparation tasks.</div></li>)}</ul> : <p className="sub">None yet.</p>}
    {role !== "viewer" && occ.ids.filter((x: any) => !x.selected).map((x: any) => <button key={x.id} className="btn small" style={{ marginRight: 6 }} onClick={async () => { try { await api(`/occasions/${x.id}/select`, { method: "POST" }); setMsg(`Promotion created for ${BUSINESS_NAMES[x.business]}.`); } catch (e: any) { setMsg(e.message); } }}>Use for a {BUSINESS_NAMES[x.business]} promotion</button>)}
    {msg && <p className="sub">{msg}</p>}
  </Drawer>;
}

function NewPromotion({ business, onClose }: { business: string; onClose: () => void }) {
  const brands = business ? [business] : Object.keys(BUSINESS_NAMES);
  return <Drawer onClose={onClose}><h2>New promotion</h2><p className="sub">Created in the dashboard. Promotions from the promotion spreadsheets keep syncing as before.</p>
    <PromotionForm brands={brands} initial={brands.length === 1 ? { business_id: brands[0] } : {}} onCancel={onClose} onDone={onClose} /></Drawer>;
}
const addMonthsStr = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); const i = y * 12 + mo - 1 + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; };

function ListView({ items, onOpen }: { items: any[]; onOpen: (it: any) => void }) {
  if (!items.length) return <div className="state">Nothing scheduled in this range.</div>;
  return <div className="table-wrap"><table><thead><tr><th>Dates</th><th>Type</th><th>Item</th><th>Business</th><th>Status</th><th></th></tr></thead>
    <tbody>{items.map((it, i) => <tr key={i} className="clickable" onClick={() => onOpen(it)}><td>{range(it)}</td><td><span className={`ev ${it.type}${it.seasonal ? " season" : ""}`} style={{ display: "inline-block" }}>{it.type === "gift" ? "gift occasion" : it.type}</span></td>
      <td>{it.title}{it.detail ? <span className="sub"> · {it.detail}</span> : null}</td><td>{it.type === "gift" ? it.brands.map((b: string) => BUSINESS_NAMES[b]).join(", ") : BUSINESS_NAMES[it.business]}</td><td>{it.type === "gift" ? (it.linkedPromotions ? `${it.linkedPromotions} linked` : "") : it.status ?? ""}{it.review === "needs_review" ? " (needs review)" : ""}</td>
      <td>{it.type === "occasion" && !it.promotionId && <button className="btn small" onClick={async (e) => { e.stopPropagation(); await api(`/occasions/${it.id}/select`, { method: "POST" }); location.reload(); }}>Use for a promotion</button>}</td></tr>)}</tbody></table></div>;
}
