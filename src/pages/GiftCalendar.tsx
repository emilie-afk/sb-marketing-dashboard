// Gift occasions on the Calendar: occasion details, linking promotions, and the promotion form used to create a
// dashboard promotion or edit one's dashboard-owned fields. Occasions give context; the campaign dates are the user's.
import { useState } from "react";
import { useApi, Async, Drawer, api, range, BUSINESS_NAMES } from "../lib";

const GIFT_BRANDS = ["sb", "p2s"];
const STATUSES = ["planned", "preparing", "ready", "launched", "ended", "cancelled"];
export type Role = "viewer" | "editor" | "admin";
const brandList = (ids: string[]) => ids.map((b) => BUSINESS_NAMES[b] ?? b).join(" and ");

/** The occurrence year a campaign starting on `start` most likely leads into (a December campaign can lead into next year). */
export function defaultYear(o: any, start: string | null | undefined, fallback: number) {
  if (!o || o.kind !== "dated" || !o.ranges) return null;
  const years = Object.keys(o.ranges).map(Number).sort();
  if (start) for (const y of years) { const r = o.ranges[y]; const end = r ? r.end : `${y}-12-31`; if (end >= start) return y; }
  return fallback;
}

export function GiftOccasionPicker({ value, year, onChange, business, start, disabled }: {
  value: string | null; year: number | null; business: string; start?: string | null; disabled?: boolean;
  onChange: (v: { id: string | null; year: number | null }) => void;
}) {
  const ref = Number((start ?? new Date().toISOString()).slice(0, 4));
  const s = useApi<any[]>(`/gift-occasions?year=${ref}`, [ref]);
  const list = (s.data ?? []).filter((o) => o.brands.includes(business));
  const sel = list.find((o) => o.id === value);
  const dated = list.filter((o) => o.kind === "dated"), yr = list.filter((o) => o.kind === "year_round");
  const cats = [...new Set(yr.map((o) => o.category))];
  return <div className="row" style={{ alignItems: "flex-start" }}>
    <label style={{ display: "grid", gap: 2 }}>Gift occasion
      <select aria-label="Gift occasion" disabled={disabled} value={value ?? ""} onChange={(e) => {
        const id = e.target.value || null; const o = list.find((x) => x.id === id);
        onChange({ id, year: o?.kind === "dated" ? defaultYear(o, start, ref) : null });
      }}>
        <option value="">None</option>
        <optgroup label="Dated occasions">{dated.map((o) => <option key={o.id} value={o.id}>{o.parent ? "  · " : ""}{o.name} ({o.month})</option>)}</optgroup>
        {cats.map((c) => <optgroup key={c} label={`Year-round · ${c}`}>{yr.filter((o) => o.category === c).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>)}
      </select>
    </label>
    {sel?.kind === "dated" && <label style={{ display: "grid", gap: 2 }}>Occurrence year
      <select aria-label="Occurrence year" disabled={disabled} value={year ?? ""} onChange={(e) => onChange({ id: sel.id, year: Number(e.target.value) })}>
        {Object.keys(sel.dates).map((y) => <option key={y} value={y}>{y}: {sel.dates[y]}</option>)}
      </select>
    </label>}
    {sel && <p className="sub" style={{ flexBasis: "100%", margin: 0 }}>{sel.kind === "dated" ? `${sel.name} ${year}: ${sel.dates[year ?? 0] ?? sel.timing}. The campaign keeps its own start and end dates.` : "Year-round occasion: the promotion's own dates place it on the Calendar."}</p>}
  </div>;
}

/** Create a dashboard promotion, or edit a dashboard promotion's name, offer, dates, status and occasion link. */
export function PromotionForm({ initial, brands, onDone, onCancel }: {
  initial: any; brands: string[]; onDone: (id: string) => void; onCancel: () => void;
}) {
  const editing = !!initial.id;
  const [v, setV] = useState<any>({ business_id: initial.business_id ?? (brands.length === 1 ? brands[0] : ""), title: initial.title ?? "", offer: initial.offer ?? "",
    execution_status: initial.execution_status ?? "planned", start_date: initial.start_date ?? "", end_date: initial.end_date ?? "",
    gift_occasion_id: initial.gift_occasion_id ?? null, gift_occasion_year: initial.gift_occasion_year ?? null });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  const submit = async (e: any) => {
    e.preventDefault(); setErr(null); setSaving(true);
    try {
      const body = { ...v, offer: v.offer || null };
      if (editing) { const { business_id, ...rest } = body; await api(`/promotions/${initial.id}`, { method: "PATCH", json: { ...rest, version: initial.version } }); onDone(initial.id); }
      else onDone((await api<any>("/promotions", { method: "POST", json: body })).id);
    } catch (x: any) { setErr(x.message); } finally { setSaving(false); }
  };
  return <form onSubmit={submit} style={{ display: "grid", gap: 8 }} aria-label={editing ? "Edit promotion" : "Create promotion"}>
    {!editing && <label style={{ display: "grid", gap: 2 }}>Brand
      <select aria-label="Brand" required value={v.business_id} onChange={set("business_id")}>
        {brands.length > 1 && <option value="">Choose a brand</option>}
        {brands.map((b) => <option key={b} value={b}>{BUSINESS_NAMES[b]}</option>)}
      </select></label>}
    <label style={{ display: "grid", gap: 2 }}>Promotion name<input aria-label="Promotion name" required maxLength={300} value={v.title} onChange={set("title")} /></label>
    <div className="row">
      <label style={{ display: "grid", gap: 2 }}>Start<input aria-label="Start date" type="date" required value={v.start_date} onChange={set("start_date")} /></label>
      <label style={{ display: "grid", gap: 2 }}>End<input aria-label="End date" type="date" required value={v.end_date} min={v.start_date || undefined} onChange={set("end_date")} /></label>
      <label style={{ display: "grid", gap: 2 }}>Status<select aria-label="Status" value={v.execution_status} onChange={set("execution_status")}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
    </div>
    <label style={{ display: "grid", gap: 2 }}>Offer<input aria-label="Offer" maxLength={500} value={v.offer} onChange={set("offer")} placeholder="e.g. 15% off gift boxes" /></label>
    {v.business_id && GIFT_BRANDS.includes(v.business_id) && <GiftOccasionPicker business={v.business_id} value={v.gift_occasion_id} year={v.gift_occasion_year} start={v.start_date}
      onChange={(g) => setV({ ...v, gift_occasion_id: g.id, gift_occasion_year: g.year })} />}
    {err && <div className="notice">{err}</div>}
    <div className="row"><button className="btn small primary" disabled={saving}>{editing ? "Save" : "Create promotion"}</button><button type="button" className="btn small" onClick={onCancel}>Cancel</button></div>
  </form>;
}

/** Occasion link editor for any promotion (spreadsheet promotions included: the link is dashboard-owned). */
export function GiftLinkEditor({ p, onSaved }: { p: any; onSaved: () => void }) {
  const [v, setV] = useState({ id: p.gift_occasion_id ?? null, year: p.gift_occasion_year ?? null });
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: { id: string | null; year: number | null }) => {
    setErr(null);
    try { await api(`/promotions/${p.id}`, { method: "PATCH", json: { gift_occasion_id: next.id, gift_occasion_year: next.id ? next.year : null, version: p.version } }); onSaved(); }
    catch (x: any) { setErr(x.message); }
  };
  return <div>
    <GiftOccasionPicker business={p.business_id} value={v.id} year={v.year} start={p.start_date} onChange={setV} />
    <div className="row" style={{ marginTop: 6 }}>
      <button className="btn small primary" onClick={() => save(v)}>Save link</button>
      {p.gift_occasion_id && <button className="btn small" onClick={() => save({ id: null, year: null })}>Clear link</button>}
    </div>
    {err && <div className="notice">{err}</div>}
  </div>;
}

export function GiftDrawer({ occasionId, year, business, role, onClose, onOpenPromotion }: {
  occasionId: string; year: number; business: string; role: Role; onClose: () => void; onOpenPromotion: (id: string) => void;
}) {
  const s = useApi<any>(`/gift-occasions/${occasionId}?year=${year}${business ? `&business=${business}` : ""}`, [occasionId, year, business]);
  const [mode, setMode] = useState<"view" | "create" | "link">("view");
  const canEdit = role !== "viewer";
  return <Drawer onClose={onClose}><Async s={s}>{(d) => {
    const o = d.occasion;
    const brands = business ? o.brands.filter((b: string) => b === business) : o.brands;
    return <>
      <h2>{o.name}</h2>
      <p className="sub">{d.datesText} · {o.timing} · all-day U.S. date</p>
      <dl className="kv">
        <dt>Brands</dt><dd>{brandList(o.brands)}</dd>
        {o.themes && <><dt>Gift themes</dt><dd>{o.themes}</dd></>}
        {o.leadIn && <><dt>Campaign lead-in</dt><dd>{o.leadIn}</dd></>}
        {o.seasonal && <><dt>Window</dt><dd>Seasonal window ({o.month})</dd></>}
      </dl>
      {d.within.length > 0 && <><h3 style={{ marginTop: 14 }}>Within this week</h3>
        <ul className="list">{d.within.map((c: any) => <li key={c.id}><b>{c.name}</b>: {c.datesText} <span className="sub">({c.timing})</span>{c.themes && <div className="sub">{c.themes}</div>}</li>)}</ul></>}
      <h3 style={{ marginTop: 14 }}>Linked promotions for {d.year}</h3>
      {d.promotions.length ? <ul className="list">{d.promotions.map((p: any) => <li key={p.id}>
        <a href="#" onClick={(e) => { e.preventDefault(); onOpenPromotion(p.id); }}><b>{p.title}</b></a> <span className="chip">{BUSINESS_NAMES[p.business]}</span> <span className="chip muted">{p.status}</span>
        {p.occasion !== o.id && <span className="chip muted">{d.within.find((c: any) => c.id === p.occasion)?.name}</span>}
        <div className="sub">Campaign {p.start_date ? range({ start: p.start_date, end: p.end_date }) : "dates not set"}{p.prep_deadline ? ` · prep deadline ${p.prep_deadline}` : ""}</div>
        {p.tasks.length > 0 && <div className="sub">Tasks: {p.tasks.map((t: any) => `${t.title} (${t.status}${t.due_date ? `, due ${t.due_date}` : ""})`).join("; ")}</div>}
      </li>)}</ul> : <p className="sub">No promotions linked to this occasion{business ? ` for ${BUSINESS_NAMES[business]}` : ""} yet.</p>}
      {canEdit && d.canCreate && mode === "view" && <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small primary" onClick={() => setMode("create")}>Create promotion</button>
        <button className="btn small" onClick={() => setMode("link")}>Link an existing promotion</button>
      </div>}
      {mode === "create" && <div className="card flat" style={{ marginTop: 10 }}><h3>New promotion for {o.name} {d.year}</h3>
        <PromotionForm brands={brands} initial={{ gift_occasion_id: o.id, gift_occasion_year: o.kind === "dated" ? d.year : null, title: `${o.name} ${d.year}`, ...(brands.length === 1 ? { business_id: brands[0] } : {}) }}
          onCancel={() => setMode("view")} onDone={() => { setMode("view"); s.reload(); }} /></div>}
      {mode === "link" && <LinkExisting occasion={o} year={d.year} business={business} onDone={() => { setMode("view"); s.reload(); }} onCancel={() => setMode("view")} />}
    </>;
  }}</Async></Drawer>;
}

function LinkExisting({ occasion, year, business, onDone, onCancel }: { occasion: any; year: number; business: string; onDone: () => void; onCancel: () => void }) {
  const s = useApi<any[]>(`/gift-occasions/${occasion.id}/candidates?year=${year}${business ? `&business=${business}` : ""}`, [occasion.id, year, business]);
  const [err, setErr] = useState<string | null>(null);
  const link = async (p: any) => {
    setErr(null);
    try {
      const cur = await api<any>(`/promotions/${p.id}`);
      await api(`/promotions/${p.id}`, { method: "PATCH", json: { gift_occasion_id: occasion.id, gift_occasion_year: occasion.kind === "dated" ? year : null, version: cur.promotion.version } });
      onDone();
    } catch (x: any) { setErr(x.message); }
  };
  return <div className="card flat" style={{ marginTop: 10 }}><h3>Link an existing promotion to {occasion.name} {year}</h3>
    <Async s={s}>{(rows) => rows.length ? <ul className="list">{rows.map((p) => <li key={p.id} className="row" style={{ justifyContent: "space-between" }}>
      <span><b>{p.title}</b> <span className="chip">{BUSINESS_NAMES[p.business]}</span><div className="sub">{p.start_date ? range({ start: p.start_date, end: p.end_date }) : "No dates"}{p.gift_occasion_name ? ` · now linked to ${p.gift_occasion_name}${p.gift_occasion_year ? ` ${p.gift_occasion_year}` : ""}` : ""}</div></span>
      <button className="btn small" onClick={() => link(p)}>{p.gift_occasion_name ? "Change link" : "Link"}</button></li>)}</ul> : <p className="sub">No promotions around this occasion to link.</p>}</Async>
    {err && <div className="notice">{err}</div>}
    <button className="btn small" style={{ marginTop: 8 }} onClick={onCancel}>Cancel</button>
  </div>;
}
