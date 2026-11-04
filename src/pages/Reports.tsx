import { useState } from "react";
import { useApi, Async, Tabs, range, BUSINESS_NAMES, api, fmt, when, Section } from "../lib";
import { MetricTile, AdvertisingBlock, PromotionList, ActivityList, VendorTable } from "../components";
import { Upload } from "./Tasks";

export function ReportsPage({ role }: { role: string }) {
  const id = location.hash.replace(/^#\/?/, "").split("/")[1];
  const [kind, setKind] = useState("weekly");
  const [business, setBusiness] = useState("");
  const s = useApi<any>(`/reports?kind=${kind}${business ? `&business=${business}` : ""}`, [kind, business]);
  if (id) return <ReportView id={id} role={role} />;
  return (
    <div>
      <Tabs tabs={[["weekly", "Weekly"], ["monthly", "Monthly"]]} value={kind} onChange={setKind} />
      <div className="toolbar"><label>Business <select value={business} onChange={(e) => setBusiness(e.target.value)}><option value="">Any</option><option value="all">All businesses</option>
        {Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
      {role !== "viewer" && <NewReport kind={kind} onDone={(rid) => (location.hash = `#/reports/${rid}`)} />}
      <Async s={s}>{(rows) => rows.length ? <div className="table-wrap" style={{ marginTop: 12 }}><table>
        <thead><tr><th>Report</th><th>Business</th><th>Period</th><th>Revisions</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.id} className="clickable" onClick={() => (location.hash = `#/reports/${r.id}`)}><td><b>{r.title}</b></td><td>{r.business_id ? BUSINESS_NAMES[r.business_id] : "All businesses"}</td>
          <td>{range({ start: r.period_start, end: r.period_end })}</td><td>{(r.revisions ?? []).map((v: any) => <span key={v.revision} className={`chip ${v.state === "published" ? "" : "muted"}`} style={{ marginRight: 4 }}>r{v.revision} {v.state}</span>)}</td></tr>)}</tbody>
      </table></div> : <div className="state" style={{ marginTop: 12 }}>No {kind} reports yet.</div>}</Async>
    </div>
  );
}

function NewReport({ kind, onDone }: { kind: string; onDone: (id: string) => void }) {
  const [err, setErr] = useState("");
  return <details><summary>Create a {kind} report</summary>
    <form className="toolbar" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as any;
      try { const r = await api("/reports", { method: "POST", json: { kind, business_id: f.business || null, period_start: f.start, period_end: f.end } }); onDone(r.id); } catch (x: any) { setErr(x.message); } }}>
      <label>Business <select name="business"><option value="">All businesses</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>From <input type="date" name="start" required /></label><label>To <input type="date" name="end" required /></label>
      <button className="btn small primary">Create draft</button>{err && <span className="bad">{err}</span>}
      <span className="sub">The draft freezes the saved figures for this period. Publish it when ready.</span>
    </form></details>;
}

function ReportView({ id, role }: { id: string; role: string }) {
  const [rev, setRev] = useState<number | null>(null);
  const s = useApi<any>(`/reports/${id}${rev ? `?revision=${rev}` : ""}`, [id, rev]);
  const act = async (fn: () => Promise<any>) => { try { await fn(); s.reload(); } catch (e: any) { alert(e.message); } };
  return <Async s={s}>{(d) => { const v = d.revision; const c = v?.content; return <div>
    <a href="#/reports">All reports</a>
    <h2 style={{ fontSize: 22, margin: "6px 0" }}>{d.report.title}</h2>
    <div className="toolbar">
      <label>Revision <select value={v?.revision ?? ""} onChange={(e) => setRev(Number(e.target.value))}>{d.revisions.map((x: any) => <option key={x.revision} value={x.revision}>r{x.revision} ({x.state}{x.corrects_revision ? `, corrects r${x.corrects_revision}` : ""})</option>)}</select></label>
      {v && <span className={`chip ${v.state === "published" ? "" : "warn"}`}>{v.state === "published" ? `Published ${when(v.published_at)}` : "Draft"}</span>}
      {v?.correction_note && <span className="sub">Correction: {v.correction_note}</span>}
      <span className="spacer" />
      {role !== "viewer" && v?.state === "draft" && <><button className="btn small primary" onClick={() => act(() => api(`/reports/${id}/publish`, { method: "POST" }))}>Publish</button>
        <button className="btn small" onClick={() => act(() => api(`/reports/${id}/draft`, { method: "DELETE" }))}>Discard draft</button></>}
      {role !== "viewer" && v?.state === "published" && <button className="btn small" onClick={() => { const note = prompt("What does the new revision correct?"); if (note) act(() => api(`/reports/${id}/revisions`, { method: "POST", json: { note } })); }}>Create correction revision</button>}
    </div>
    <p className="sub">Figures are frozen in this revision from {v?.source_runs?.length ?? 0} import run(s). Later data or task changes do not alter it; a correction creates a new revision.</p>
    {c && <>
      <Section title="Performance and trends" sub={c.period.label}>{c.performance.map((b: any) => <div key={b.business} className="card flat" style={{ marginBottom: 10 }}><h3>{BUSINESS_NAMES[b.business]}</h3><div className="grid g4">{b.metrics.map((m: any) => <MetricTile key={m.key} m={m} />)}</div></div>)}</Section>
      <Section title="Advertising"><AdvertisingBlock platforms={c.advertising} /></Section>
      <Section title="Promotions" sub="Promotions whose dates overlap this period.">
        <PromotionList items={[...c.promotions.current, ...c.promotions.upcoming]} /></Section>
      <Section title="Activities" sub="Activities reported for periods inside this report period.">{c.activities.length ? <ActivityList items={c.activities} /> : <div className="state">None reported.</div>}</Section>
      {c.products && c.products.vendors?.length > 0 && <Section title="Product and vendor details" sub={c.products.scopeLabel}><VendorTable vendors={c.products.vendors.slice(0, 10)} /></Section>}
    </>}
    <Section title="Files" sub="Original images, PDFs, spreadsheets and report packs. Images are attached as files only; they never feed charts.">
      {d.files.length ? <ul className="list">{d.files.map((f: any) => <li key={f.id}><a href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a> <span className="sub">{f.content_type} · {Math.round(f.size_bytes / 1024)} KB · {f.uploaded_by}</span></li>)}</ul> : <div className="sub">No files.</div>}
      {role !== "viewer" && v?.state === "draft" && <Upload ownerType="report_revision" ownerId={v.id} onDone={s.reload} />}
    </Section>
  </div>; }}</Async>;
}
export { fmt };
