import { useState } from "react";
import { useApi, Async, Section, Tabs, range, money, fmt, api, Drawer, Unavailable, BUSINESS_NAMES, when } from "../lib";
import { MetricTile, TrendPanel, AdvertisingBlock, PromotionList, WorkBlock, ProductsBlock, VendorTable, PeriodBar, ActivityList } from "../components";
import { periodQuery } from "./Overview";
import { ListingReviews } from "./ListingReviews";
import type { Period } from "../App";

const TABS: Record<string, [string, string][]> = {
  sb: [["summary", "Summary"], ["sales", "Sales & Products"], ["vendors", "Vendors"], ["profitability", "Profitability"], ["advertising", "Advertising"], ["promotions", "Promotions"], ["corporate", "Corporate Gifting"], ["activities", "Marketing Activities"]],
  p2s: [["summary", "Summary"], ["sales", "Sales"], ["advertising", "Advertising"], ["listing-reviews", "Etsy Listing Reviews"], ["promotions", "Promotions"], ["activities", "Marketing Activities"]],
  perksradar: [["summary", "Summary"], ["acquisition", "Acquisition & Engagement"], ["advertising", "Advertising"], ["promotions", "Promotions"], ["outreach", "Outreach & Content"]],
};

export function Business({ id, tab, period, setPeriod, role }: { id: string; tab?: string; period: Period; setPeriod: (p: Period) => void; role: string }) {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const t = tab && TABS[id].some(([k]) => k === tab) ? tab : "summary";
  const detail = parts[2];
  const go = (k: string) => (location.hash = `#/${id}/${k}`);
  return (
    <div>
      <h2 style={{ fontSize: 24, marginBottom: 8 }}>{BUSINESS_NAMES[id]}</h2>
      <Tabs tabs={TABS[id]} value={t} onChange={go} />
      {t === "summary" && <Summary id={id} period={period} setPeriod={setPeriod} />}
      {(t === "sales") && <Sales id={id} period={period} setPeriod={setPeriod} />}
      {t === "vendors" && <Vendors period={period} setPeriod={setPeriod} vendorId={detail} />}
      {t === "profitability" && <Profitability period={period} setPeriod={setPeriod} />}
      {t === "advertising" && <Advertising id={id} period={period} setPeriod={setPeriod} role={role} />}
      {t === "promotions" && <Promotions id={id} openId={detail} role={role} />}
      {t === "corporate" && <Corporate period={period} />}
      {(t === "activities" || t === "outreach") && <Activities id={id} />}
      {t === "listing-reviews" && <ListingReviews runId={detail} role={role} />}
      {t === "acquisition" && <Acquisition period={period} setPeriod={setPeriod} />}
    </div>
  );
}

function usePeriodData(path: string, period: Period) { return useApi<any>(`${path}${periodQuery(period)}`, [period]); }
const Bar = ({ d, setPeriod }: { d: any; setPeriod: (p: Period) => void }) => d.period
  ? <PeriodBar start={d.period.start} end={d.period.end} compare={d.comparison?.kind ?? "previous_period"} onChange={(a, b, c) => setPeriod({ start: a, end: b, compare: c })} note={d.periodLabel ?? d.period.label} /> : null;

function Summary({ id, period, setPeriod }: { id: string; period: Period; setPeriod: (p: Period) => void }) {
  const s = usePeriodData(`/business/${id}/summary`, period);
  return <Async s={s}>{(d) => (
    <>
      {d.empty ? <div className="state unavailable">{d.message}</div> : <>
        <Bar d={d} setPeriod={setPeriod} />
        <Section title="Business figures"><div className="grid g4">{d.metrics.map((m: any) => <MetricTile key={m.key} m={m} />)}</div></Section>
        <Section title="Trends"><TrendPanel trends={d.trends} initial={d.trends.slice(0, 2).map((t: any) => `${t.business}:${t.key}`)} /></Section>
        <Section title="Advertising" right={<a href={`#/${id}/advertising`}>Details</a>}><AdvertisingBlock platforms={d.advertising} showBusiness={false} /></Section>
      </>}
      <Section title="Promotions" right={<a href={`#/${id}/promotions`}>All promotions</a>} sub={d.promotions.note}>
        <PromotionList items={[...d.promotions.current, ...d.promotions.upcoming]} onOpen={(pid) => (location.hash = `#/${id}/promotions/${pid}`)} />
      </Section>
      <Section title="Marketing activities"><WorkBlock work={d.work} /></Section>
      {d.products && <Section title="Products and vendors"><ProductsBlock p={d.products} onVendor={(v) => (location.hash = `#/sb/vendors/${v}`)} /></Section>}
    </>)}</Async>;
}

function Sales({ id, period, setPeriod }: { id: string; period: Period; setPeriod: (p: Period) => void }) {
  const s = usePeriodData(`/business/${id}/sales`, period);
  return <Async s={s}>{(d) => d.empty ? <div className="state unavailable">{d.message}</div> : (
    <>
      <Bar d={d} setPeriod={setPeriod} />
      {!d.products.length ? <div className="state">No product-level sales for {d.periodLabel}. {id === "p2s" ? "P2S sales figures (Etsy and KDP) appear in the Summary tab." : ""}</div> : <>
        <Section title="Best sellers" sub={`${d.scopeLabel}. ${d.periodLabel}.`}>
          <ProductTable rows={d.revenueLeaders} />
        </Section>
        <Section title="New products gaining sales"><ProductTable rows={d.newGaining} empty="No new products with sales in this period." /></Section>
        <div className="grid g2">
          <Section title="Growing"><ProductTable rows={d.growing} /></Section>
          <Section title="Declining"><ProductTable rows={d.declining} /></Section>
        </div>
        <Section title="Categories"><CategoryTable products={d.products} /></Section>
      </>}
    </>)}</Async>;
}

function ProductTable({ rows, empty }: { rows: any[]; empty?: string }) {
  if (!rows.length) return <div className="state">{empty ?? "None."}</div>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Product</th><th>Category</th><th>Vendor</th><th className="n">Revenue</th><th className="n">Units</th><th className="n">Gross profit</th><th className="n">Margin</th><th className="n">Change</th></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.product_id}><td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</td><td>{r.category}{r.genus ? ` · ${r.genus}` : ""}</td><td>{r.vendor}</td>
      <td className="n">{money(r.revenue)}</td><td className="n">{r.units ?? "Missing"}</td><td className="n">{fmt(r.grossProfit, "currency")}</td><td className="n">{fmt(r.margin, "percent")}</td>
      <td className={`n ${r.change.sentiment}`}>{r.dropped ? <span className="chip warn">No sales this period</span> : null} {r.isNew ? "New" : r.change.absolute === null ? "No comparison" : `${r.change.absolute >= 0 ? "+" : "-"}${money(Math.abs(r.change.absolute))}`}</td></tr>)}</tbody>
  </table></div>;
}

function CategoryTable({ products }: { products: any[] }) {
  const by = new Map<string, { rev: number; units: number; n: number }>();
  for (const p of products) { const k = p.category ?? "Uncategorized"; const c = by.get(k) ?? { rev: 0, units: 0, n: 0 }; c.rev += p.revenue ?? 0; c.units += p.units ?? 0; c.n++; by.set(k, c); }
  return <div className="table-wrap"><table><thead><tr><th>Category</th><th className="n">Products</th><th className="n">Revenue</th><th className="n">Units</th></tr></thead>
    <tbody>{[...by].sort((a, b) => b[1].rev - a[1].rev).map(([k, c]) => <tr key={k}><td>{k}</td><td className="n">{c.n}</td><td className="n">{money(c.rev)}</td><td className="n">{c.units}</td></tr>)}</tbody></table></div>;
}

function Vendors({ period, setPeriod, vendorId }: { period: Period; setPeriod: (p: Period) => void; vendorId?: string }) {
  const [f, setF] = useState({ channel: "", category: "" });
  const q = `${periodQuery(period) || "?"}&channel=${f.channel}&category=${encodeURIComponent(f.category)}`;
  const s = useApi<any>(`/business/sb/vendors${q}`, [period, f]);
  const detail = useApi<any>(vendorId ? `/business/sb/vendors${q}&vendor=${vendorId}` : null, [vendorId, period, f]);
  return <Async s={s}>{(d) => d.empty ? <div className="state unavailable">{d.message}</div> : (
    <>
      <Bar d={d} setPeriod={setPeriod} />
      <div className="toolbar">
        <label>Channel <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">All available</option>{d.channels.map((c: string) => <option key={c}>{c}</option>)}</select></label>
        <label>Category <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{d.categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>
        <span className="sub">{d.scopeLabel}. {d.periodLabel}{d.comparison ? `, compared with ${range(d.comparison)}` : ""}.</span>
      </div>
      <Section title="Vendor comparison" sub="Measured results. Missing product costs show as missing, never as zero.">
        <VendorTable vendors={d.vendors} onVendor={(id) => (location.hash = `#/sb/vendors/${id}`)} />
      </Section>
      <Section title="What to promote" sub="Suggestions, kept separate from the measured results above.">
        <div className="card flat"><ul className="list">
          {d.vendors.filter((v: any) => v.change.sentiment === "good" && v.margin.state === "value" && (v.margin.value ?? 0) > 0.3).slice(0, 3).map((v: any) =>
            <li key={v.id}>Suggestion: feature <b>{v.name}</b>, growing with a {fmt(v.margin, "percent")} margin.</li>)}
          {!d.vendors.some((v: any) => v.change.sentiment === "good") && <li className="sub">No growing vendors with known margins this period.</li>}
        </ul></div>
      </Section>
      {vendorId && <Drawer onClose={() => (location.hash = "#/sb/vendors")}>
        <Async s={detail}>{(v) => { const vend = v.vendors[0]; return (<>
          <h2>{vend?.name ?? "Vendor"}</h2><p className="sub">{v.scopeLabel}. {v.periodLabel}.</p>
          {vend && <div className="grid g3" style={{ marginBottom: 12 }}>
            <div className="metric"><div className="k">Revenue</div><div className="v">{fmt(vend.revenue, "currency")}</div></div>
            <div className="metric"><div className="k">Gross profit</div><div className="v">{fmt(vend.grossProfit, "currency")}</div></div>
            <div className="metric"><div className="k">Margin</div><div className="v">{fmt(vend.margin, "percent")}</div></div></div>}
          <div className="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th className="n">Revenue</th><th className="n">Units</th><th className="n">Gross profit</th><th className="n">Margin</th><th className="n">Change</th></tr></thead>
            <tbody>{v.products.map((r: any) => <tr key={r.product_id}><td>{r.title}</td><td>{r.category}</td><td className="n">{money(r.revenue)}</td><td className="n">{r.units}</td>
              <td className="n">{fmt(r.grossProfit, "currency")}</td><td className="n">{fmt(r.margin, "percent")}</td><td className={`n ${r.change.sentiment}`}>{r.isNew ? "New" : r.change.absolute === null ? "N/A" : `${r.change.absolute >= 0 ? "+" : "-"}${money(Math.abs(r.change.absolute))}`}</td></tr>)}</tbody></table></div>
        </>); }}</Async>
      </Drawer>}
    </>)}</Async>;
}

function Profitability({ period, setPeriod }: { period: Period; setPeriod: (p: Period) => void }) {
  const s = usePeriodData("/business/sb/profitability", period);
  return <Async s={s}>{(d) => d.empty ? <div className="state unavailable">{d.message}</div> : (
    <>
      <Bar d={d} setPeriod={setPeriod} />
      {d.source?.status === "blocked" && <div className="notice">Live connection to the Gross Profit application is not available yet: {d.source.blocked_reason} Figures below come only from submitted saved results. The dashboard does not recalculate profit.</div>}
      <Section title="Gross profit and costs"><div className="grid g4">{d.metrics.map((m: any) => <MetricTile key={m.key} m={m} />)}</div></Section>
      <Section title="Trends"><TrendPanel trends={d.trends} initial={d.trends.map((t: any) => `${t.business}:${t.key}`)} /></Section>
      <Section title="Cost coverage"><div className="card flat">{d.products.costCoverage.products ? `${d.products.costCoverage.products - d.products.costCoverage.missingCost} of ${d.products.costCoverage.products} products have a known cost. ${d.products.costCoverage.missingCost} are missing cost and are excluded from gross profit and margin (not counted as zero).` : "No product-level results for this period."}</div></Section>
      <Section title="By vendor"><VendorTable vendors={d.products.vendors} /></Section>
    </>)}</Async>;
}

function Advertising({ id, period, setPeriod, role }: { id: string; period: Period; setPeriod: (p: Period) => void; role: string }) {
  const [zero, setZero] = useState(false);
  const s = useApi<any>(`/business/${id}/advertising${periodQuery(period) || "?"}&zero=${zero ? 1 : 0}`, [period, zero]);
  return <Async s={s}>{(d) => d.empty ? <div className="state unavailable">{d.message}</div> : (
    <>
      <Bar d={d} setPeriod={setPeriod} />
      <div className="toolbar"><label><input type="checkbox" checked={zero} onChange={(e) => setZero(e.target.checked)} /> Include zero-spend campaigns</label>
        <span className="sub">Historical performance for {d.period.label}. Current status is shown with the time it was observed.</span></div>
      <AdvertisingBlock platforms={d.platforms} showBusiness={false} />
      {role !== "viewer" && zero && <ZeroSpendIncluder platforms={d.platforms} />}
    </>)}</Async>;
}

function ZeroSpendIncluder({ platforms }: { platforms: any[] }) {
  const zero = platforms.flatMap((p) => p.campaigns.filter((c: any) => (c.spend.value ?? 0) === 0));
  if (!zero.length) return null;
  return <div className="card flat" style={{ marginTop: 10 }}><h3>Zero-spend campaigns</h3><p className="sub">Include a new active campaign so it appears in performance tables with zero spend.</p>
    <ul className="list">{zero.map((c: any) => <li key={c.id} className="row"><span>{c.name}</span><span className="spacer" />
      <button className="btn small" onClick={async () => { await api(`/settings/campaigns/${c.id}/include`, { method: "POST", json: { include: !c.explicitlyIncluded } }); location.reload(); }}>{c.explicitlyIncluded ? "Stop including" : "Include"}</button></li>)}</ul></div>;
}

function Promotions({ id, openId, role }: { id: string; openId?: string; role: string }) {
  const s = useApi<any>(`/business/${id}/promotions`, [id]);
  const [kind, setKind] = useState("promotion");
  return <Async s={s}>{(d) => {
    const items = d.promotions.filter((p: any) => kind === "all" || p.kind === kind || (kind === "promotion" && p.kind === "launch"));
    return <>
      <div className="toolbar">
        <label>Show <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="promotion">Customer promotions</option><option value="vendor_offer">Vendor offers and terms</option><option value="special_collection">Special collections</option><option value="all">Everything</option></select></label>
        <span className="sub">Dates, offers, codes and vendor terms come from the planning spreadsheets. Execution status, owners and tasks are managed here.</span>
      </div>
      {kind === "vendor_offer" ? <VendorTerms items={items} /> : <PromotionList items={items} onOpen={(pid) => (location.hash = `#/${id}/promotions/${pid}`)} />}
      {openId && <PromotionDrawer id={openId} role={role} onClose={() => (location.hash = `#/${id}/promotions`)} />}
    </>; }}</Async>;
}

function VendorTerms({ items }: { items: any[] }) {
  if (!items.length) return <div className="state">No vendor offers.</div>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Vendor</th><th>Regular offer period</th><th className="n">Vendor cost reduction</th><th className="n">Customer discount</th><th>Special (BF/CM) dates</th><th className="n">Special cost reduction</th><th className="n">Special customer discount</th><th>Terms</th></tr></thead>
    <tbody>{items.map((p) => <tr key={p.id}><td><b>{p.vendor}</b>{p.review_state === "needs_review" && <div className="chip warn">Needs review</div>}</td>
      <td>{p.start_date ? range({ start: p.start_date, end: p.end_date }) : p.date_text}</td>
      <td className="n">{p.vendor_cost_reduction ?? "None"}{p.vendor_cost_reduction != null ? "%" : ""}</td><td className="n">{p.customer_discount ?? ""}{p.customer_discount != null ? "%" : ""}</td>
      <td>{p.special_dates_text ?? ""}</td><td className="n">{p.special_cost_reduction != null ? `${p.special_cost_reduction}%` : ""}</td><td className="n">{p.special_customer_discount != null ? `${p.special_customer_discount}%` : ""}</td>
      <td className="sub">{p.terms}</td></tr>)}</tbody></table>
    <div className="sub" style={{ padding: 8 }}>Vendor cost reductions are what vendors give Succulents Box. Customer discounts are what shoppers get. They are kept separate.</div></div>;
}

export function PromotionDrawer({ id, role, onClose }: { id: string; role: string; onClose: () => void }) {
  const s = useApi<any>(`/promotions/${id}`, [id]);
  const [saving, setSaving] = useState(false);
  return <Drawer onClose={onClose}><Async s={s}>{(d) => { const p = d.promotion; return (<>
    <h2>{p.title}</h2>
    <p className="sub">{p.start_date ? range({ start: p.start_date, end: p.end_date }) : `Dates not recognised: "${p.date_text}"`} · from {d.sources.map((x: any) => x.label).join(", ") || "dashboard"}</p>
    {d.reviews.map((r: any) => <div key={r.id} className="notice">{r.kind.replace(/_/g, " ")}: {r.details.message}</div>)}
    <dl className="kv">
      <dt>Offer</dt><dd>{p.offer ?? "None"}</dd><dt>Code</dt><dd className="mono">{p.code ?? "None"}</dd>
      {p.vendor && <><dt>Vendor</dt><dd>{p.vendor}</dd></>}
      {p.vendor_cost_reduction != null && <><dt>Vendor cost reduction</dt><dd>{p.vendor_cost_reduction}%</dd></>}
      {p.customer_discount != null && <><dt>Customer discount</dt><dd>{p.customer_discount}%</dd></>}
      {p.special_dates_text && <><dt>Special terms</dt><dd>{p.special_dates_text}: {p.special_customer_discount}% customer, {p.special_cost_reduction}% vendor</dd></>}
      {p.channels && <><dt>Channels</dt><dd>{p.channels}</dd></>}{p.materials && <><dt>Creative assets</dt><dd>{p.materials}</dd></>}
      {p.collection_url && <><dt>Collection</dt><dd><a href={p.collection_url} target="_blank" rel="noreferrer">{p.collection_url}</a></dd></>}
      {p.terms && <><dt>Terms / notes</dt><dd>{p.terms}</dd></>}
    </dl>
    <h3 style={{ marginTop: 14 }}>Execution (managed here)</h3>
    {role === "viewer" ? <p>{p.execution_status}{p.owner ? `, owner ${p.owner}` : ""}</p> :
      <form className="row" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); setSaving(true);
        try { await api(`/promotions/${id}`, { method: "PATCH", json: { execution_status: f.get("status"), owner: f.get("owner") || null, version: p.version } }); s.reload(); } catch (err: any) { alert(err.message); } finally { setSaving(false); } }}>
        <select name="status" defaultValue={p.execution_status}>{["planned", "preparing", "ready", "launched", "ended", "cancelled"].map((x) => <option key={x}>{x}</option>)}</select>
        <input name="owner" placeholder="Owner" defaultValue={p.owner ?? ""} />
        <button className="btn small primary" disabled={saving}>Save</button>
      </form>}
    <h3 style={{ marginTop: 14 }}>Preparation tasks</h3>
    {d.tasks.length ? <ul className="list">{d.tasks.map((t: any) => <li key={t.id}><b>{t.title}</b> <span className="chip muted">{t.status}</span><div className="sub">{t.owner ?? "No owner"} · due {t.due_date ?? "not set"}</div></li>)}</ul> : <p className="sub">No tasks linked. Create one in Marketing Tasks and choose this promotion.</p>}
    <h3 style={{ marginTop: 14 }}>Change history</h3>
    <ul className="list">{d.history.map((h: any, i: number) => <li key={i}><span className="sub">{when(h.changed_at)} · {h.changed_by}</span><div className="mono">{Object.entries(h.changes).map(([k, v]: any) => `${k}: ${JSON.stringify(v.from ?? null)} to ${JSON.stringify(v.to)}`).join("; ")}</div></li>)}</ul>
  </>); }}</Async></Drawer>;
}

function Corporate({ period }: { period: Period }) {
  const s = usePeriodData("/business/sb/corporate", period);
  return <Async s={s}>{(d) => <>
    {d.source?.status === "blocked" && <Unavailable title="Corporate Gifting connection" reason={d.source.blocked_reason} />}
    <p className="sub">{d.note}</p>
    {d.metrics.length > 0 && <div className="grid g4">{d.metrics.map((m: any) => <MetricTile key={m.key} m={{ ...m, label: "Corporate revenue" }} />)}</div>}
    <p>Marketplace outreach, proposals, requirements and follow-ups are edited in the <a href="https://sb-corporate-gifts.netlify.app/" target="_blank" rel="noreferrer">Corporate Gifting app</a>.</p>
  </>}</Async>;
}

function Activities({ id }: { id: string }) {
  const s = useApi<any>(`/business/${id}/activities`, [id]);
  return <Async s={s}>{(d) => <>
    <Section title="Recent activities" sub="Imported activity counts keep their meaning and never become individual completed tasks.">
      {d.work.activities.length ? <ActivityList items={d.work.activities} /> : <div className="state">No activities reported yet.</div>}
    </Section>
    <Section title="Tasks"><WorkBlock work={d.work} /></Section>
  </>}</Async>;
}

function Acquisition({ period, setPeriod }: { period: Period; setPeriod: (p: Period) => void }) {
  const s = usePeriodData("/business/perksradar/summary", period);
  return <Async s={s}>{(d) => d.empty ? <div className="state unavailable">{d.message}</div> : <>
    <Bar d={d} setPeriod={setPeriod} />
    <div className="grid g4">{d.metrics.map((m: any) => <MetricTile key={m.key} m={m} />)}</div>
    {d.metrics.every((m: any) => m.value.state === "missing") && <div className="notice" style={{ marginTop: 12 }}>No sign-up, card or email tracking has been connected. Figures are not estimated from outreach activity.</div>}
  </>}</Async>;
}
