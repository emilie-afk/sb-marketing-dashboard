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

const VIEWS: [string, string][] = [["year", "Year at a glance"], ["agenda", "Agenda"], ["month", "Month grid"], ["week", "Week"], ["list", "List"]];

export function CalendarPage({ role = "viewer", planningOwner = false }: { role?: Role; planningOwner?: boolean }) {
  const today = todayIn(OPERATIONS_TZ);
  const [q, setQ] = useHashQuery();
  const view = VIEWS.some(([k]) => k === q.get("view")) ? q.get("view")! : "year";
  const occasionView = view === "year" || view === "agenda";
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
  const s = useApi<any>(occasionView ? null : `/calendar?from=${from}&to=${to}&types=${types.join(",")}${business ? `&business=${business}` : ""}${seasonal ? "" : "&seasonal=0"}`, [view, from, to, types.join(","), business, seasonal]);
  const step = (n: number) => setQ({ date: view === "month" ? `${addMonthsStr(month, n)}-01` : addDays(anchor, n * (view === "week" ? 7 : 30)) });
  const title = view === "month" ? new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : occasionView ? "" : range({ start: from, end: to });
  const openItem = (it: any) => { if (it.type === "gift") setGift({ id: it.occasionId, year: it.year }); else if (it.type === "promotion" || it.type === "launch" || it.type === "deadline") setOpen(it.id); else if (it.type === "task" && it.source === "tracker" && typeof it.open_url === "string" && it.open_url.startsWith("https://")) window.open(it.open_url, "_blank", "noopener,noreferrer"); else if (it.type === "task") location.hash = "#/tasks"; else if (it.type === "occasion") setSheetOcc({ title: it.title, start: it.start, end: it.end, brands: [it.business], ids: [{ id: it.id, business: it.business, selected: !!it.promotionId }], promotions: [] }); };
  const limit = view === "week" ? 12 : 4;
  return (
    <div>
      <Tabs tabs={VIEWS} value={view} onChange={(v) => setQ({ view: v === "year" ? null : v }, { push: true })} />
      <div className="toolbar">
        {!occasionView && <><button className="btn small" onClick={() => step(-1)} aria-label="Previous">Previous</button><b>{title}</b><button className="btn small" onClick={() => step(1)} aria-label="Next">Next</button>
          <button className="btn small" onClick={() => setQ({ date: null })}>Today</button></>}
        <label>Business <select value={business} onChange={(e) => setQ({ business: e.target.value || null })}><option value="">All</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {occasionView ? <label>Occasion type <select value={q.get("otype") ?? "all"} onChange={(e) => setQ({ otype: e.target.value === "all" ? null : e.target.value })}><option value="all">All occasions</option><option value="gift">Gift occasions</option><option value="sheet">Spreadsheet occasions</option></select></label>
          : TYPES.map(([k, l]) => <button key={k} className={`chip ${types.includes(k) ? "on" : ""}`} aria-pressed={types.includes(k)} onClick={() => setQ({ types: (types.includes(k) ? types.filter((x) => x !== k) : [...types, k]).join(",") })}>{l}</button>)}
        <button className={`chip ${seasonal ? "on" : ""}`} aria-pressed={seasonal} onClick={() => setQ({ seasonal: seasonal ? "0" : null })} title="Multi-week windows such as wedding season and back to school">Seasonal windows</button>
        {role !== "viewer" && <button className="btn small" onClick={() => setCreating(true)}>New promotion</button>}
      </div>
      {view === "year" ? <YearGlance q={q} setQ={setQ} today={today} business={business} seasonal={seasonal} onGift={setGift} onSheet={(it: any) => setSheetOcc({ ...it, owner: planningOwner })} />
        : view === "agenda" ? <Agenda q={q} setQ={setQ} today={today} business={business} seasonal={seasonal} owner={planningOwner} onGift={setGift} onSheet={setSheetOcc} onPromotion={setOpen} /> : <>
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

/** Planning badges for one occasion: the owner sees No plan / Draft / Published and can start a plan; others see only plans they may see. */
export function PlanBadges({ plans, owner, newHref }: { plans: any[]; owner: boolean; newHref: string | null }) {
  if (!plans.length) return owner ? <div className="sub plan-badges"><span className="chip muted">No plan</span>{newHref && <> <a className="btn small" href={newHref}>Plan this occasion</a></>}</div> : null;
  return <div className="sub plan-badges">{plans.map((p: any) => <span key={p.id} style={{ marginRight: 8 }}>
    <a href={`#/planning/${p.id}`}><b>{p.name}</b></a> <span className="chip">{BUSINESS_NAMES[p.business] ?? p.business}</span> <span className={`chip ${p.status === "draft" ? "muted" : ""}`}>{p.status === "draft" ? "Draft" : "Published"}</span> <span className="sub">{p.task_count} assigned task{p.task_count === 1 ? "" : "s"}</span></span>)}
    {owner && newHref && <a className="btn small" href={newHref}>Plan this occasion</a>}</div>;
}
const planHref = (it: any, business: string) => it.kind === "gift" ? `#/planning/new?gift=${it.occasionId}&year=${it.year}${business ? `&business=${business}` : ""}`
  : it.ids?.length ? `#/planning/new?sheet=${it.ids[0].id}&business=${it.ids[0].business}` : null;

function Agenda({ q, setQ, today, business, seasonal, owner, onGift, onSheet, onPromotion }: any) {
  const thisYear = Number(today.slice(0, 4));
  const next90 = q.get("range") === "next90";
  const year = /^\d{4}$/.test(q.get("year") ?? "") ? Number(q.get("year")) : thisYear;
  const from = next90 ? today : `${year}-01-01`, to = next90 ? addDays(today, 89) : `${year}-12-31`;
  const otype = q.get("otype") ?? "all";
  const s = useApi<any>(`/occasions/agenda?from=${from}&to=${to}&type=${otype}${business ? `&business=${business}` : ""}${seasonal ? "" : "&seasonal=0"}`, [from, to, otype, business, seasonal]);
  return <>
    <div className="row" style={{ marginBottom: 6 }}>
      <b>{next90 ? "Next 90 days" : `January to December ${year}`}</b>
      <label className="sub">Year <select aria-label="Year" value={next90 ? "" : year} onChange={(e) => setQ({ year: e.target.value === String(thisYear) ? null : e.target.value, range: null })}>
        {next90 && <option value="">Choose</option>}{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
      {next90 ? <button className="btn small" onClick={() => setQ({ range: null })}>Full year</button> : <button className="btn small" onClick={() => setQ({ range: "next90", year: null })}>Next 90 days</button>}
      {!next90 && <a className="sub" href="#" onClick={(e) => { e.preventDefault(); document.getElementById(`m-${today.slice(0, 7)}`)?.scrollIntoView({ behavior: "smooth" }); }}>Jump to this month</a>}
    </div>
    <Async s={s}>{(d) => {
      if (!d.items.length) return <div className="state">No occasions in this range{business ? ` for ${BUSINESS_NAMES[business]}` : ""}. Try another year or occasion type.</div>;
      const months = new Map<string, any[]>();
      for (const it of d.items) { const m = (it.inProgress ? from : it.start).slice(0, 7); months.set(m, [...(months.get(m) ?? []), it]); }
      return <>
        <p className="sub">{d.note} Routine tasks live in Marketing Tasks; a campaign's planned tasks show on its plan.</p>
        {[...months.entries()].map(([m, list]) => <section key={m} id={`m-${m}`}>
          <h3 className="agenda-month">{monthTitle(m)}</h3>
          {list.map((it: any) => <div key={it.key} className="agenda-row">
            <div className="when">{it.tbc ? "Dates to be confirmed" : range({ start: it.start, end: it.end })}{it.inProgress ? <div className="sub">In progress</div> : null}</div>
            <div>
              <a href="#" onClick={(e) => { e.preventDefault(); it.kind === "gift" ? onGift({ id: it.occasionId, year: it.year }) : onSheet({ ...it, owner }); }}><b>{it.title}</b></a>
              <span className={`ev ${it.kind === "gift" ? "gift" : "occasion"}${it.seasonal ? " season" : ""}`} style={{ display: "inline-block", marginLeft: 6 }}>{it.kind === "gift" ? (it.seasonal ? "Seasonal window" : "Gift occasion") : `Spreadsheet occasion${it.occasionType ? ` · ${it.occasionType}` : ""}`}</span>
              <div className="sub">{it.brands.map((b: string) => BUSINESS_NAMES[b] ?? b).join(" and ")}{it.monthLabel && it.seasonal ? ` · ${it.monthLabel}` : ""}</div>
              {it.leadIn && <div className="lead">{it.title} · {it.monthLabel} · {it.leadIn.replace(/^Start the campaign/, "Start planning")}</div>}
              <div className="sub">{it.promotions.length ? <>Linked promotions: {it.promotions.map((p: any, i: number) => <span key={p.id}>{i ? ", " : ""}<a href="#" onClick={(e) => { e.preventDefault(); onPromotion(p.id); }}>{p.title}</a> ({BUSINESS_NAMES[p.business]}, {p.status})</span>)}</> : "No linked promotion yet"}</div>
              <PlanBadges plans={it.plans ?? []} owner={owner} newHref={owner && !it.tbc ? planHref(it, business) : null} />
            </div>
          </div>)}
        </section>)}
      </>;
    }}</Async>
    {!next90 && <YearRound business={business} year={year} />}
  </>;
}

const QUARTER_MONTHS = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
const MONTH_LIMIT = 4;
const shortRange = (it: any) => it.tbc ? "Dates TBC" : it.start === it.end ? new Date(`${it.start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : range({ start: it.start, end: it.end }).replace(/, \d{4}/g, "");

/**
 * Year at a glance: four quarters of three months, every month shown (quiet ones too), occasion dates and names only.
 * Seasonal windows show as date ranges; an occasion shared by several brands shows once with its brands. Promotions
 * and preparation tasks are in the occasion's drawer and its plan, not here. Busy months expand in place.
 */
function YearGlance({ q, setQ, today, business, seasonal, onGift, onSheet }: any) {
  const thisYear = Number(today.slice(0, 4));
  const year = /^\d{4}$/.test(q.get("year") ?? "") ? Number(q.get("year")) : thisYear;
  const otype = q.get("otype") ?? "all";
  const [open, setOpen] = useState<Set<string>>(new Set());
  const s = useApi<any>(`/occasions/agenda?from=${year}-01-01&to=${year}-12-31&type=${otype}${business ? `&business=${business}` : ""}${seasonal ? "" : "&seasonal=0"}`, [year, otype, business, seasonal]);
  return <>
    <div className="row" style={{ marginBottom: 6 }}>
      <b>{year} at a glance</b>
      <label className="sub">Year <select aria-label="Year" value={year} onChange={(e) => { setOpen(new Set()); setQ({ year: e.target.value === String(thisYear) ? null : e.target.value }); }}>
        {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
      <span className="row legend" aria-label="Legend"><span className="ev gift">Gift occasion</span><span className="ev gift season">Seasonal window</span><span className="ev occasion">Spreadsheet occasion</span></span>
    </div>
    <Async s={s}>{(d) => {
      const byMonth = new Map<number, any[]>();
      for (const it of d.items) { const m = it.inProgress ? 1 : Number(it.start.slice(5, 7)); byMonth.set(m, [...(byMonth.get(m) ?? []), it]); }
      return <div className="year-glance">{QUARTER_MONTHS.map((qm, qi) => <section key={qi} className="quarter" aria-label={`Quarter ${qi + 1}`}>
        <h3 className="quarter-title">Q{qi + 1} <span className="sub">{monthTitle(`${year}-${String(qm[0]).padStart(2, "0")}`).split(" ")[0]} – {monthTitle(`${year}-${String(qm[2]).padStart(2, "0")}`)}</span></h3>
        <div className="q-months">{qm.map((m) => {
          const key = `${year}-${String(m).padStart(2, "0")}`, list = byMonth.get(m) ?? [], all = open.has(key);
          return <div key={m} className={`month-card ${key === today.slice(0, 7) ? "now" : ""}`} id={`y-${key}`}>
            <h4>{monthTitle(key).split(" ")[0]} {list.length > 0 && <span className="sub">{list.length}</span>}</h4>
            {!list.length ? <p className="sub quiet">No occasions</p> : <ul className="glance">{(all ? list : list.slice(0, MONTH_LIMIT)).map((it: any) => <li key={it.key}>
              <span className="when">{shortRange(it)}</span>
              <a href="#" className={`ev ${it.kind === "gift" ? "gift" : "occasion"}${it.seasonal ? " season" : ""}`} title={`${it.title} · ${it.brands.map((b: string) => BUSINESS_NAMES[b] ?? b).join(" and ")}`}
                onClick={(e) => { e.preventDefault(); it.kind === "gift" ? onGift({ id: it.occasionId, year: it.year }) : onSheet(it); }}>{it.title}</a>
              {!business && it.brands.length > 0 && <span className="brands sub">{it.brands.map((b: string) => BUSINESS_NAMES[b] ?? b).join(" · ")}</span>}
            </li>)}</ul>}
            {list.length > MONTH_LIMIT && <button type="button" className="btn small link" aria-expanded={all} onClick={() => setOpen((o) => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n; })}>
              {all ? "Show fewer" : `Show all ${list.length}`}</button>}
          </div>; })}</div>
      </section>)}</div>;
    }}</Async>
    <p className="sub">{"Gift occasions are all-day U.S. dates. Open an occasion for its linked plans and promotions; preparation tasks live in its plan."}</p>
    <YearRound business={business} year={year} />
  </>;
}

/** Year-round gift ideas: not tied to a date, so they sit apart from the dated agenda. */
function YearRound({ business, year }: { business: string; year: number }) {
  const s = useApi<any[]>(`/gift-occasions?year=${year}`, [year]);
  const list = (s.data ?? []).filter((o) => o.kind === "year_round" && (!business || o.brands.includes(business)));
  if (!list.length) return null;
  const cats = [...new Set(list.map((o) => o.category))];
  return <section className="card flat" style={{ marginTop: 20 }}>
    <h3 style={{ marginTop: 0 }}>Year-round gift ideas</h3>
    <p className="sub">Not tied to a date. A campaign built on one of these uses its own dates.</p>
    {cats.map((c) => <div key={c} style={{ marginBottom: 8 }}><b>{c}</b>
      <div className="sub">{list.filter((o) => o.category === c).map((o) => `${o.name} (${o.brands.map((b: string) => BUSINESS_NAMES[b] ?? b).join(" and ")})`).join(" · ")}</div></div>)}
  </section>;
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
    {occ.plans && <><h3 style={{ marginTop: 14 }}>Plans</h3><PlanBadges plans={occ.plans} owner={!!occ.owner} newHref={occ.owner && occ.ids?.length ? `#/planning/new?sheet=${occ.ids[0].id}&business=${occ.ids[0].business}` : null} /></>}
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
