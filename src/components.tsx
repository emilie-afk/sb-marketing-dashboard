import { useState } from "react";
import { fmt, ChangeText, range, BUSINESS_NAMES, PLATFORM_NAMES, money, when } from "./lib";
import type { Unit } from "../shared/metrics";
import { COMPARISON_LABELS } from "../shared/dates";

export function MetricTile({ m }: { m: any }) {
  const cov = m.coverage;
  return (
    <div className="metric">
      <div className="k">{m.label}</div>
      <div className={`v ${m.value.state !== "value" ? "na" : ""}`} title={m.value.note ?? ""}>{fmt({ ...m.value, flag: undefined }, m.unit)}</div>
      {m.value.flag && <span className="chip warn">{m.value.flag}</span>}
      {m.value.state !== "value" && m.value.note && <div className="sub">{m.value.state === "missing" ? "Unavailable: " : ""}{m.value.note}</div>}
      {m.priorRange && <div className="d"><ChangeText c={m.change} unit={m.unit} /> <span className="sub">vs {range(m.priorRange)}</span></div>}
      {m.covered && <div className="sub">Data: {range(m.covered)}{m.timezone ? ` (${tzShort(m.timezone)})` : ""}</div>}
      {cov?.status === "unsupported" && <div className="sub">{cov.reason}</div>}
      {cov?.status === "gaps" && <div className="sub bad">{cov.note}</div>}
      {m.partialNote && <div className="sub">{m.partialNote}</div>}
    </div>
  );
}
const tzShort = (tz: string) => (tz === "America/Los_Angeles" ? "Pacific" : tz);

export function BusinessPanel({ b }: { b: any }) {
  const anyData = b.metrics.some((m: any) => m.value.state !== "missing" || m.covered);
  return (
    <div className="card">
      <h3>{b.name}</h3>
      {anyData ? <div className="grid g4">{b.metrics.map((m: any) => <MetricTile key={m.key} m={m} />)}</div>
        : <div className="state unavailable">No figures have been reported for this period. Tracking for {b.name} is not connected yet.</div>}
    </div>
  );
}

/** Small, readable line chart. Each point keeps its own period; incomplete points are hollow. */
export function LineChart({ t, height = 150 }: { t: any; height?: number }) {
  const pts = t.points.filter((p: any) => p.value.value !== null);
  const W = 520, H = height, L = 52, R = 10, T = 12, B = 30;
  if (!pts.length) return <div className="state">No data for this metric.</div>;
  const vals = pts.map((p: any) => p.value.value as number);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 + 1; hi += Math.abs(hi) * 0.1 + 1; }
  lo = Math.min(lo, 0) < 0 ? lo : Math.max(0, lo - (hi - lo) * 0.15);
  const x = (i: number) => L + (t.points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (t.points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const pctDp = hi - lo < 0.002 ? 2 : 1;
  const label = (v: number) => (t.unit === "percent" ? `${(v * 100).toFixed(pctDp)}%` : t.unit === "currency" ? `$${Math.round(v).toLocaleString()}` : t.unit === "multiple" ? `${v.toFixed(1)}x` : Math.round(v).toLocaleString());
  const segs: string[] = []; let cur = "";
  t.points.forEach((p: any, i: number) => { if (p.value.value === null) { if (cur) segs.push(cur); cur = ""; } else cur += `${cur ? "L" : "M"}${x(i)},${y(p.value.value)}`; });
  if (cur) segs.push(cur);
  const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${t.label} trend`}>
      {[0, 0.5, 1].map((f) => { const v = lo + (hi - lo) * f; return <g key={f}><line className="grid-l" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 6} y={y(v) + 3} textAnchor="end">{label(v)}</text></g>; })}
      {segs.map((d, i) => <path key={i} className="line" d={d} />)}
      {t.points.map((p: any, i: number) => p.value.value === null ? null : (
        <circle key={i} className={`pt ${p.value.state !== "value" ? "incomplete" : ""}`} cx={x(i)} cy={y(p.value.value)} r={3.5}>
          <title>{`${range(p)}: ${fmt(p.value, t.unit as Unit)}`}</title>
        </circle>))}
      {t.points.map((p: any, i: number) => (i % Math.ceil(t.points.length / 6) === 0 || i === t.points.length - 1) &&
        <text key={`l${i}`} x={x(i)} y={H - 10} textAnchor="middle">{short(p.end)}</text>)}
    </svg>
  );
}

export function TrendPanel({ trends, initial }: { trends: any[]; initial: string[] }) {
  const keyOf = (t: any) => `${t.business}:${t.key}`;
  const [sel, setSel] = useState<string[]>(initial.filter((k) => trends.some((t) => keyOf(t) === k)));
  const [open, setOpen] = useState(false);
  if (!trends.length) return <div className="state">No trend data yet.</div>;
  const shown = trends.filter((t) => sel.includes(keyOf(t)));
  return (
    <div>
      <div className="grid g2">
        {shown.map((t) => (
          <div className="card flat" key={keyOf(t)}>
            <div className="row"><b>{BUSINESS_NAMES[t.business]} · {t.label}</b><span className="spacer" />
              {t.key === "cpa" || t.key === "bot_sessions" ? <span className="chip muted">Lower is better</span> : null}</div>
            <LineChart t={t} />
            <div className="sub">{t.points.length ? `${range({ start: t.points[0].start, end: t.points[t.points.length - 1].end })}, ${t.granularity === "day" ? "7-day blocks from daily data" : `${t.granularity}ly periods as reported`}` : ""}{t.timezone ? `, ${tzShort(t.timezone)} time` : ""}. Hollow points are incomplete.</div>
          </div>))}
      </div>
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 10 }}>
        <summary>Choose metrics ({trends.length} available)</summary>
        <div className="row" style={{ marginTop: 8 }}>
          {trends.map((t) => { const k = keyOf(t), on = sel.includes(k);
            return <button key={k} className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setSel(on ? sel.filter((x) => x !== k) : [...sel, k])}>{BUSINESS_NAMES[t.business]} · {t.label}</button>; })}
        </div>
      </details>
    </div>
  );
}

export function AdvertisingBlock({ platforms, showBusiness = true }: { platforms: any[]; showBusiness?: boolean }) {
  if (!platforms.length) return <div className="state">No advertising results with spend for this period.</div>;
  const byBiz = new Map<string, any[]>();
  for (const p of platforms) byBiz.set(p.business, [...(byBiz.get(p.business) ?? []), p]);
  return (
    <div className="grid">
      {[...byBiz].map(([b, ps]) => (
        <div key={b}>
          {showBusiness && <h3 style={{ margin: "6px 0" }}>{BUSINESS_NAMES[b]}</h3>}
          <div className="grid g4" style={{ marginBottom: 10 }}>
            {ps.map((p) => (
              <div key={p.platform} className="metric">
                <div className="k">{PLATFORM_NAMES[p.platform] ?? p.platform}</div>
                <div className="v">{fmt(p.totals.spend, "currency")}</div>
                <div className="sub">CPA {fmt(p.totals.cpa, "currency")} · ROAS {fmt(p.totals.roas, "multiple")}</div>
              </div>))}
          </div>
          {ps.map((p) => (
            <details key={p.platform} open={!showBusiness}>
              <summary>{PLATFORM_NAMES[p.platform] ?? p.platform}: {p.campaigns.length} campaign{p.campaigns.length === 1 ? "" : "s"}</summary>
              {p.reportedPeriods?.length > 1 && <p className="sub" style={{ margin: "4px 0 0" }}>Added up from weekly results: {p.reportedPeriods.map((r: any) => range(r)).join(", ")}. Budget/day is the latest reported.</p>}
              <div className="table-wrap" style={{ margin: "8px 0 12px" }}>
                <table>
                  <thead><tr><th>Campaign name</th><th>Status</th><th className="n">Budget/day</th><th className="n">Cost</th><th className="n">CPA</th><th className="n">ROAS</th></tr></thead>
                  <tbody>{p.campaigns.map((c: any) => (
                    <tr key={c.id}><td>{c.name}{c.explicitlyIncluded && <span className="chip warn" style={{ marginLeft: 6 }}>New, shown with zero spend</span>}</td>
                      <td><span className={`chip ${c.status === "Active" ? "" : "muted"}`}>{c.status}</span><div className="sub">as of {when(c.statusObservedAt)}</div></td>
                      <td className="n">{fmt(c.dailyBudget, "currency")}{c.dailyBudget?.note && <div className="sub">{c.dailyBudget.note}</div>}</td>
                      <td className="n">{fmt(c.spend, "currency")}</td><td className="n">{fmt(c.cpa, "currency")}</td><td className="n">{fmt(c.roas, "multiple")}</td></tr>))}
                  </tbody>
                </table>
              </div>
              <div className="sub" style={{ marginBottom: 10 }}>Period {range(p.period)}. Acquisition event: purchase. Attribution: {[...new Set(p.campaigns.map((c: any) => c.attribution))].join("; ") || "not stated"}. Zero-spend campaigns are hidden unless included in Settings; zero spend does not mean inactive.</div>
            </details>))}
        </div>))}
    </div>
  );
}

export function PromotionList({ items, onOpen }: { items: any[]; onOpen?: (id: string) => void }) {
  if (!items.length) return <div className="state">None.</div>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Promotion</th><th>Dates</th><th>Offer / code</th><th>Execution</th><th className="n">Prep tasks</th></tr></thead>
      <tbody>{items.map((p) => (
        <tr key={p.id} className={onOpen ? "clickable" : ""} onClick={() => onOpen?.(p.id)}>
          <td><b>{p.title}</b>{p.review_state === "needs_review" && <span className="chip warn" style={{ marginLeft: 6 }}>Needs review</span>}{p.missing_from_source_since && <span className="chip bad" style={{ marginLeft: 6 }}>Not in spreadsheet</span>}</td>
          <td>{p.start_date ? range({ start: p.start_date, end: p.end_date }) : <span className="na">Date not recognised</span>}</td>
          <td>{p.offer ?? ""}{p.code && <div className="mono">{p.code}</div>}</td>
          <td><span className={`chip ${p.execution_status === "launched" ? "" : p.execution_status === "cancelled" ? "bad" : "muted"}`}>{p.execution_status}</span>{p.owner && <div className="sub">{p.owner}</div>}</td>
          <td className="n">{p.task_count ? `${p.task_done}/${p.task_count}` : "None"}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

export function WorkBlock({ work }: { work: any }) {
  const T = ({ items, empty }: { items: any[]; empty: string }) => items.length
    ? <ul className="list">{items.slice(0, 8).map((t: any) => <li key={`${t.id}${t.due_date}`}><b>{t.title}</b>{t.source === "tracker" && <span className="chip muted" style={{ marginLeft: 6 }}>Task Tracker</span>}<div className="sub">{BUSINESS_NAMES[t.business_id]}{t.owner ? ` · ${t.owner}` : ""}{t.due_date ? ` · due ${t.due_date}` : ""}</div></li>)}</ul>
    : <div className="sub">{empty}</div>;
  return (
    <div className="grid g4">
      <div className="card flat"><h3>In progress</h3><T items={work.inProgress} empty="Nothing in progress." /></div>
      <div className="card flat"><h3>Due in 7 days</h3>{work.overdue.length > 0 && <div className="chip bad">{work.overdue.length} overdue</div>}<T items={work.dueSoon} empty="No deadlines this week." /></div>
      <div className="card flat"><h3>Waiting</h3><T items={work.waiting} empty="Nothing waiting." /></div>
      <div className="card flat"><h3>Recently completed</h3><T items={work.recentlyCompleted} empty="No completed tasks in the last 14 days." />
        {work.activities.length > 0 && <><h3 style={{ marginTop: 10 }}>Activities</h3><ActivityList items={work.activities.slice(0, 6)} /></>}</div>
    </div>
  );
}

export function ActivityList({ items }: { items: any[] }) {
  return <ul className="list">{items.map((a: any, i: number) => (
    <li key={i}><b>{a.name}</b>{a.count !== null && a.count !== undefined && <span>: {a.count} {a.count_unit}</span>}
      <div className="sub">{range({ start: a.period_start, end: a.period_end })}{a.prorated && <> · {a.prorated.days_inside} of its {a.prorated.days_total} days in this period, so {a.count} of {a.prorated.full_count} counted</>}{a.link && <> · <a href={a.link} target="_blank" rel="noreferrer">link</a></>}</div></li>))}</ul>;
}

export function ProductsBlock({ p, onVendor }: { p: any; onVendor?: (id: string) => void }) {
  if (!p || !p.products.length) return <div className="state">No product results for this period.</div>;
  const PT = ({ rows, value }: { rows: any[]; value: (r: any) => string }) => rows.length
    ? <ul className="list">{rows.slice(0, 6).map((r: any) => <li key={r.product_id}>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : <b>{r.title}</b>}<span className="spacer" /> <span style={{ float: "right" }}>{value(r)}</span><div className="sub">{r.vendor}</div></li>)}</ul>
    : <div className="sub">None.</div>;
  return (
    <div>
      <div className="sub" style={{ marginBottom: 8 }}>{p.scopeLabel}. Of {p.costCoverage.products} products, {p.costCoverage.missingCost} have no cost (no gross profit shown, never zero) and {p.costCoverage.partialCost} have partial costs (profit labelled incomplete). Profit leaders rank complete figures only.</div>
      <div className="grid g4">
        <div className="card flat"><h3>Revenue leaders</h3><PT rows={p.revenueLeaders} value={(r) => money(r.revenue)} /></div>
        <div className="card flat"><h3>Profit leaders</h3><PT rows={p.profitLeaders} value={(r) => fmt(r.grossProfit, "currency")} /></div>
        <div className="card flat"><h3>Growing</h3><PT rows={p.growing} value={(r) => `+${money(r.change.absolute)}`} /></div>
        <div className="card flat"><h3>Declining</h3><PT rows={p.declining} value={(r) => `-${money(Math.abs(r.change.absolute))}${r.dropped ? " (no sales now)" : ""}`} /></div>
      </div>
      <h3 style={{ margin: "14px 0 6px" }}>Vendor performance</h3>
      <VendorTable vendors={p.vendors.slice(0, 8)} onVendor={onVendor} />
    </div>
  );
}

export function VendorTable({ vendors, onVendor }: { vendors: any[]; onVendor?: (id: string) => void }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Vendor</th><th className="n">Revenue</th><th className="n">Orders</th><th className="n">Units</th><th className="n">Gross profit</th><th className="n">Margin</th><th className="n">Abs change</th><th className="n">% change</th></tr></thead>
      <tbody>{vendors.map((v) => (
        <tr key={v.id ?? v.name} className={onVendor && v.id ? "clickable" : ""} onClick={() => v.id && onVendor?.(v.id)}>
          <td><b>{v.name}</b>{v.missingCostProducts > 0 && <div className="sub">{v.missingCostProducts} product(s) with missing or partial cost</div>}{v.droppedProducts > 0 && <div className="sub">{v.droppedProducts} product(s) with no sales this period</div>}</td>
          <td className="n">{fmt(v.revenue, "currency")}</td><td className="n">{fmt(v.orders, "count")}</td><td className="n">{fmt(v.units, "count")}</td>
          <td className="n">{fmt(v.grossProfit, "currency")}</td><td className="n">{fmt(v.margin, "percent")}</td>
          <td className={`n ${v.change.sentiment}`}>{v.change.absolute === null ? "No comparison" : `${v.change.absolute >= 0 ? "+" : "-"}${money(Math.abs(v.change.absolute))}`}</td>
          <td className={`n ${v.change.sentiment}`}>{v.change.percent === null ? (v.change.label === "new" ? "New" : "N/A") : `${v.change.percent >= 0 ? "+" : ""}${v.change.percent.toFixed(1)}%`}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

export function PeriodBar({ start, end, compare, onChange, note }: { start: string; end: string; compare: string; onChange: (s: string, e: string, c: string) => void; note?: string }) {
  const [s, setS] = useState(start), [e, setE] = useState(end);
  return (
    <div className="toolbar">
      <label>From <input type="date" value={s} onChange={(x) => setS(x.target.value)} /></label>
      <label>To <input type="date" value={e} onChange={(x) => setE(x.target.value)} /></label>
      <label>Compare <select value={compare} onChange={(x) => onChange(s, e, x.target.value)}>
        {Object.entries(COMPARISON_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}<option value="none">No comparison</option>
      </select></label>
      <button className="btn small" onClick={() => onChange(s, e, compare)} disabled={!s || !e || e < s}>Apply</button>
      {note && <span className="sub">{note}</span>}
    </div>
  );
}
