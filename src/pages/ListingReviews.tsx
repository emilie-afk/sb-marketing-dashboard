import { useState } from "react";
import { useApi, Async, Section, range, money, api, when } from "../lib";

export function ListingReviews({ runId, role }: { runId?: string; role: string }) {
  const runs = useApi<any>("/listing-reviews");
  return <Async s={runs}>{(r) => {
    if (!r.runs.length) return <div className="state">No listing checks have been received yet. The weekly Etsy Ads check needs to add its results to the intake spreadsheet (see Settings).</div>;
    const current = runId ?? r.runs[0].run_id;
    return <>
      <div className="toolbar">
        <label>Check <select value={current} onChange={(e) => (location.hash = `#/p2s/listing-reviews/${e.target.value}`)}>
          {r.runs.map((x: any) => <option key={x.run_id} value={x.run_id}>{range({ start: x.window_start, end: x.window_end })} ({x.run_id}){x.status !== "active" ? ", superseded" : ""}</option>)}</select></label>
        <span className="sub">{r.note}</span>
      </div>
      <Run id={current} role={role} />
    </>; }}</Async>;
}

function Run({ id, role }: { id: string; role: string }) {
  const s = useApi<any>(`/listing-reviews/${encodeURIComponent(id)}`, [id]);
  return <Async s={s}>{(d) => <>
    <p className="sub">30-day window {range({ start: d.run.window_start, end: d.run.window_end })} ({d.run.timezone}). Collected {when(d.run.collected_at)}. Scope: {d.run.scope_note}.
      {d.run.excluded_listing_ids.length ? ` Excluded listing(s): ${d.run.excluded_listing_ids.join(", ")}.` : ""}{d.previousRunId ? ` Compared with check ${d.previousRunId}.` : ""}</p>
    {d.listings.map((l: any) => <Listing key={l.listing_id} l={l} role={role} reload={s.reload} />)}
    {d.generalFindings.length > 0 && <Section title="General findings"><Findings items={d.generalFindings} role={role} reload={s.reload} /></Section>}
  </>}</Async>;
}

function Listing({ l, role, reload }: { l: any; role: string; reload: () => void }) {
  return (
    <div className="card" style={{ margin: "14px 0" }}>
      <div className="row"><h3 style={{ margin: 0 }}>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.title}</a> : l.title}</h3>
        {l.newSincePrevious && <span className="chip warn">New since previous check</span>}</div>
      <p className="sub">Listing {l.listing_id} · {l.clicks ?? "Missing"} clicks · {l.orders ?? "Missing"} orders · {money(l.spend)} spend (this check's window)</p>
      {l.changesSincePrevious?.length > 0 && <div className="notice">Since the previous check: {l.changesSincePrevious.join("; ")}</div>}
      <div className="grid g2">
        <div>
          <h4>Our options and price position</h4>
          <div className="table-wrap"><table><thead><tr><th>Option</th><th>Format</th><th className="n">Price</th><th>Position (like for like)</th></tr></thead>
            <tbody>{l.options.map((o: any, i: number) => { const p = l.positions[i]; return <tr key={o.option_key}><td>{o.label}{o.pack_qty > 1 ? ` (pack of ${o.pack_qty})` : ""}</td><td>{o.format}{o.pages ? `, ${o.pages} pages` : ""}{o.size ? `, ${o.size}` : ""}</td><td className="n">{money(o.price)}</td>
              <td>{p.position === "no_comparable" ? <span className="na">No comparable competitor option</span> : <><span className={`chip ${p.position === "below" ? "warn" : p.position === "above" ? "muted" : ""}`}>{p.position} market</span> <span className="sub">median {money(p.medianUnit)} of {p.comparableCount}</span></>}</td></tr>; })}</tbody></table></div>
          <h4 style={{ marginTop: 10 }}>Keywords</h4>
          <ul className="list">{l.keywords.map((k: any) => <li key={k.keyword}><b>{k.keyword}</b> <span className={`chip ${k.kind === "reported" ? "" : "warn"}`}>{k.label}</span>
            {k.kind === "reported" && <div className="sub">{k.views ?? "?"} views · {k.clicks ?? "?"} clicks · {k.orders ?? "?"} orders</div>}</li>)}</ul>
          {l.samples.map((m: any) => <p key={m.keyword} className="sub">Market sample: {money(m.min_price)} to {money(m.max_price)}, median {money(m.median_price)}, {m.pct_digital ?? "?"}% digital. {m.label}</p>)}
        </div>
        <div>
          <h4>Competitor options</h4>
          <div className="table-wrap"><table><thead><tr><th>Competitor</th><th>Option</th><th className="n">Price</th></tr></thead>
            <tbody>{l.competitors.map((c: any) => <tr key={c.id}><td><a href={c.competitor_url} target="_blank" rel="noreferrer">{c.competitor_title ?? "Listing"}</a>{c.bestseller && <span className="chip" style={{ marginLeft: 4 }}>Bestseller</span>}{c.review_count != null && <div className="sub">{c.review_count} reviews</div>}</td>
              <td>{c.option_label}<div className="sub">{c.format}{c.pages ? `, ${c.pages} pages` : ""}{c.pack_qty > 1 ? `, pack of ${c.pack_qty}` : ""}{c.addons ? `, ${c.addons}` : ""}</div>{c.price_basis === "from_price" && <span className="chip muted">"From" price, not compared</span>}</td>
              <td className="n">{money(c.price)}{c.original_price ? <div className="sub">was {money(c.original_price)}</div> : null}</td></tr>)}</tbody></table></div>
        </div>
      </div>
      <h4 style={{ marginTop: 12 }}>Findings and proposals</h4>
      <Findings items={l.findings} role={role} reload={reload} />
    </div>
  );
}

function Findings({ items, role, reload }: { items: any[]; role: string; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return <div className="sub">No findings.</div>;
  const act = async (id: string, fn: () => Promise<any>) => { setBusy(id); try { await fn(); reload(); } catch (e: any) { alert(e.message); } finally { setBusy(null); } };
  return <ul className="list">{items.map((f: any) => {
    const approved = (f.decisions ?? []).find((x: any) => x.decision === "approved");
    return <li key={f.id} style={{ opacity: f.state === "superseded" ? 0.6 : 1 }}>
      <div className="row"><span className={`chip ${f.label.startsWith("Proposal") ? "warn" : ""}`}>{f.label}</span><span className="chip muted">{f.category}</span>
        {f.state === "superseded" && <span className="chip bad">Superseded by correction</span>}{f.state === "needs_review" && <span className="chip bad">Needs review: an underlying fact changed</span>}</div>
      <div style={{ textDecoration: f.state === "superseded" ? "line-through" : "none" }}>{f.statement}</div>
      {(f.corrections ?? []).map((c: any, i: number) => <div key={i} className="sub">Correction: {c.reason} ({c.corrected_by})</div>)}
      {(f.decisions ?? []).map((x: any, i: number) => <div key={i} className="sub">{x.decision} by {x.decided_by} on {when(x.decided_at)}{x.task_id ? " · task created" : ""}{x.implemented_at ? ` · implemented ${when(x.implemented_at)}: ${x.implementation_note}` : ""}</div>)}
      {role !== "viewer" && f.state === "active" && !approved && <div className="row" style={{ marginTop: 4 }}>
        <button className="btn small primary" disabled={busy === f.id} onClick={() => { const title = prompt("Approve and create a task. Task name:", f.statement.slice(0, 120)); if (title) act(f.id, () => api(`/findings/${f.id}/decision`, { method: "POST", json: { decision: "approved", create_task: { title } } })); }}>Approve and create task</button>
        <button className="btn small" disabled={busy === f.id} onClick={() => act(f.id, () => api(`/findings/${f.id}/decision`, { method: "POST", json: { decision: "rejected" } }))}>Reject</button>
        <button className="btn small" disabled={busy === f.id} onClick={() => { const reason = prompt("What is wrong with this finding?"); if (reason) act(f.id, () => api(`/findings/${f.id}/correct`, { method: "POST", json: { reason } })); }}>Correct</button>
      </div>}
      {role !== "viewer" && approved && !approved.implemented_at && <button className="btn small" style={{ marginTop: 4 }} onClick={() => { const note = prompt("What was changed on the listing?"); if (note) act(f.id, () => api(`/findings/${f.id}/implemented`, { method: "POST", json: { note } })); }}>Mark implemented</button>}
    </li>; })}</ul>;
}
