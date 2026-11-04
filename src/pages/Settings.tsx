import { useState } from "react";
import { useApi, Async, Section, when, api, BUSINESS_NAMES } from "../lib";

const STATUS_LABEL: Record<string, string> = { ok: "Connected", failing: "Failing", blocked: "Needs a source change", not_configured: "Not configured" };

export function SettingsPage({ role }: { role: string }) {
  const s = useApi<any>("/settings");
  const reviews = useApi<any>("/review-items");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const refresh = async (id: string) => { setBusy(id); try { setResult(await api(`/settings/sheet-sources/${id}/refresh`, { method: "POST" })); s.reload(); reviews.reload(); } catch (e: any) { setResult({ outcome: "failed", error: e.message }); } finally { setBusy(null); } };
  return <Async s={s}>{(d) => <div>
    <Section title="Planning and intake spreadsheets" sub="One-way sync: spreadsheet to dashboard. The dashboard never writes to a spreadsheet. A failed read keeps the last successful data.">
      {!d.sheetReaderConfigured && <div className="notice">Spreadsheet reading is not configured on the server yet (Google read-only credential missing). Registered sheets cannot sync until it is set.</div>}
      <div className="table-wrap"><table><thead><tr><th>Spreadsheet</th><th>Role</th><th>Business / year</th><th>Last successful sync</th><th>Last problem</th><th></th></tr></thead>
        <tbody>{d.sheets.map((x: any) => <tr key={x.id}><td><b>{x.label}</b>{!x.active && <span className="chip muted"> paused</span>}</td><td>{x.role.replace(/_/g, " ")}</td><td>{BUSINESS_NAMES[x.business_id]} {x.year ?? ""}</td>
          <td>{when(x.last_success_at)}</td><td className={x.last_error ? "bad" : "sub"}>{x.last_error ?? "None"}</td>
          <td>{role !== "viewer" && <button className="btn small" disabled={busy === x.id} onClick={() => refresh(x.id)}>{busy === x.id ? "Reading…" : "Refresh from spreadsheet"}</button>}</td></tr>)}
          {!d.sheets.length && <tr><td colSpan={6} className="sub">No spreadsheets registered.</td></tr>}</tbody></table></div>
      {result && <div className={`state ${result.outcome === "failed" ? "error" : ""}`} style={{ marginTop: 8 }}>{result.outcome === "failed" ? `Sync failed: ${result.error}. Previous data is unchanged.` : `Sync ${result.outcome}: ${result.created ?? 0} new, ${result.updated ?? 0} updated, ${result.unchanged ?? 0} unchanged, ${result.reviews ?? 0} for review.`}
        {result.receipts && <ul className="list">{result.receipts.map((r: any, i: number) => <li key={i}>{r.label}: {r.outcome}. {r.message}</li>)}</ul>}</div>}
      {role === "admin" && <RegisterSheet onDone={s.reload} />}
    </Section>

    <Section title="Needs review" sub="Conflicts, rows missing from a spreadsheet, unrecognised dates and findings whose facts changed. Nothing is deleted or merged automatically.">
      <Async s={reviews}>{(items) => items.length ? <ul className="list">{items.map((r: any) => <li key={r.id}>
        <div className="row"><span className="chip warn">{r.kind.replace(/_/g, " ")}</span><b>{r.promotion_title ?? r.finding_statement ?? r.details.identity ?? ""}</b><span className="spacer" />
          {role !== "viewer" && <button className="btn small" onClick={async () => { const resolution = prompt("How was this resolved?"); if (resolution) { await api(`/review-items/${r.id}/resolve`, { method: "POST", json: { resolution } }); reviews.reload(); } }}>Resolve</button>}</div>
        <div className="sub">{r.details.message} {r.details.source ? `(${r.details.source}${r.details.tab ? `, tab ${r.details.tab}` : ""}${r.details.row ? `, row ${r.details.row}` : ""})` : ""} {r.details.fields ? `Fields: ${r.details.fields.join(", ")}` : ""}{r.details.dateText ? ` Date text: "${r.details.dateText}"` : ""}</div>
      </li>)}</ul> : <div className="state">Nothing to review.</div>}</Async>
    </Section>

    <Section title="Data sources" sub="What each source provides today. Blocked sources need a change in that application first.">
      <div className="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Last success</th><th>Data collected</th><th>Notes</th></tr></thead>
        <tbody>{d.sources.map((x: any) => <tr key={x.id}><td><b>{x.label}</b></td><td><span className={`chip ${x.status === "ok" ? "" : x.status === "failing" ? "bad" : "warn"}`}>{STATUS_LABEL[x.status]}</span></td>
          <td>{when(x.last_success_at)}</td><td>{when(x.last_collected)}</td><td className="sub">{x.blocked_reason ?? x.last_error ?? ""}</td></tr>)}</tbody></table></div>
    </Section>

    <Section title="Recent imports" sub="Every submission gets a receipt. Rejected and failed imports never replace earlier data.">
      <div className="table-wrap"><table><thead><tr><th>Received</th><th>Source</th><th>Submission</th><th>Period</th><th>Outcome</th><th className="n">Accepted</th><th className="n">Rejected</th></tr></thead>
        <tbody>{d.imports.map((r: any) => <tr key={r.id}><td>{when(r.received_at)}</td><td>{r.source_id}</td><td className="mono">{r.submission_id}{r.revision > 1 ? ` (r${r.revision})` : ""}{r.status === "superseded" ? " superseded" : ""}</td>
          <td>{r.period_start} to {r.period_end}</td><td><span className={`chip ${r.outcome === "accepted" ? "" : r.outcome === "unchanged" ? "muted" : "bad"}`}>{r.outcome}</span>{r.outcome === "rejected" && <div className="sub">{r.errors?.[0]?.message}</div>}</td>
          <td className="n">{r.accepted_count}</td><td className="n">{r.rejected_count}</td></tr>)}</tbody></table></div>
    </Section>

    {role === "admin" && <Section title="Scheduled submissions (automation tokens)" sub="Each scheduled task gets its own token, limited to its sources and businesses. Tokens are stored hashed and shown once.">
      <AutomationClients clients={d.clients} reload={s.reload} />
    </Section>}

    <Section title="Scope rules" sub="Set privately on the server (EXCLUDED_BRANDS, TRACKED_CHANNELS). Not stored in the code.">
      <dl className="kv">
        <dt>Excluded brands</dt><dd>{d.scopeRules.excludedBrands.length ? d.scopeRules.excludedBrands.join(", ") : <span className="bad">None configured. Every brand in the data is shown.</span>}</dd>
        <dt>Tracked channels</dt><dd>{Object.values(d.scopeRules.trackedChannels).length ? Object.values(d.scopeRules.trackedChannels).join(", ") : <span className="bad">None configured. Only reported totals are shown.</span>}</dd>
      </dl>
    </Section>

    <Section title="Team access"><p className="sub">Members and roles (viewer, editor, admin) are set privately on the server in the TEAM_MEMBERS setting. Changes apply on the next request.</p></Section>
  </div>}</Async>;
}

function RegisterSheet({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState("");
  return <details style={{ marginTop: 10 }}><summary>Register a spreadsheet</summary>
    <form className="toolbar" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as any;
      try { await api("/settings/sheet-sources", { method: "POST", json: { business_id: f.business_id, year: f.role === "intake" ? null : Number(f.year), role: f.role, label: f.label, file: f.file, file_kind: f.file_kind, sync_interval_minutes: Number(f.interval) } });
        setMsg("Registered. Use Refresh to read it now."); onDone(); } catch (x: any) { setMsg(x.message); } }}>
      <label>Label <input name="label" required placeholder="2027 annual calendar" /></label>
      <label>Role <select name="role"><option value="annual_calendar">Annual calendar</option><option value="seasonal_program">Seasonal program</option><option value="intake">Intake (task results)</option></select></label>
      <label>Business <select name="business_id">{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Year <input name="year" type="number" defaultValue={new Date().getFullYear()} style={{ width: 90 }} /></label>
      <label>Link <input name="file" required placeholder="Google Sheets or Drive link" style={{ minWidth: 260 }} /></label>
      <label>Type <select name="file_kind"><option value="google_sheet">Google Sheet</option><option value="xlsx">Excel file in Drive</option></select></label>
      <label>Sync every <select name="interval" defaultValue="360"><option value="60">hour</option><option value="360">6 hours</option><option value="1440">day</option></select></label>
      <button className="btn small primary">Register</button><span className="sub">{msg}</span>
    </form></details>;
}

function AutomationClients({ clients, reload }: { clients: any[]; reload: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  return <>
    {token && <div className="notice">New token (copy it now, it will not be shown again): <span className="mono">{token}</span></div>}
    <div className="table-wrap"><table><thead><tr><th>Label</th><th>Sources</th><th>Businesses</th><th>Token</th><th>Created</th><th></th></tr></thead>
      <tbody>{clients.map((c) => <tr key={c.id}><td>{c.label}</td><td className="mono">{c.allowed_sources.join(", ")}</td><td>{c.allowed_businesses.join(", ")}</td><td className="mono">…{c.token_hint}</td>
        <td>{when(c.created_at)}</td><td>{c.revoked_at ? <span className="chip muted">revoked</span> : <button className="btn small" onClick={async () => { await api(`/settings/automation-clients/${c.id}/revoke`, { method: "POST" }); reload(); }}>Revoke</button>}</td></tr>)}
        {!clients.length && <tr><td colSpan={6} className="sub">No automation tokens.</td></tr>}</tbody></table></div>
    <form className="toolbar" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as any;
      const r = await api("/settings/automation-clients", { method: "POST", json: { label: f.label, sources: String(f.sources).split(",").map((x: string) => x.trim()).filter(Boolean), businesses: String(f.businesses).split(",").map((x: string) => x.trim()).filter(Boolean) } });
      setToken(r.token); reload(); }}>
      <label>Label <input name="label" required placeholder="Weekly report task" /></label>
      <label>Sources <input name="sources" required placeholder="weekly_report, ads" /></label>
      <label>Businesses <input name="businesses" required defaultValue="sb, p2s" /></label>
      <button className="btn small primary">Create token</button></form>
  </>;
}
