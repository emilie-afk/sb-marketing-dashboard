// Slack Review: the planning owner's private queue of task suggestions from Slack. The server returns 404 to anyone
// else; this page only shows what it is given. Slack excerpts and links stay here; only the approved fields are sent.
import { useState } from "react";
import { api, useApi, Async, BUSINESS_NAMES, Drawer, when, useHashQuery } from "../lib";

const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
const STATUS: Record<string, string> = { pending: "To review", approved: "Approved", dismissed: "Dismissed" };
const DELIVERY: Record<string, string> = { not_sent: "Not sent", sending: "Sending…", created: "Created in Task Tracker", failed: "Needs retry", unknown: "No answer: retry to settle" };
const TASK: Record<string, string> = { open: "Open", done: "Done", deleted: "Deleted in Task Tracker" };

export function SlackReview({ id }: { id?: string }) {
  if (id) return <SuggestionDetail key={id} id={id} />;
  return <Queue />;
}

function Queue() {
  const [q, setQ] = useHashQuery();
  const status = q.get("status") ?? "pending", search = q.get("q") ?? "";
  const s = useApi<any>(`/review/suggestions?status=${status}${search ? `&q=${encodeURIComponent(search)}` : ""}`, [status, search]);
  return <div>
    <div className="toolbar">
      <b>Slack Review</b>
      <label>Show <select value={status} onChange={(e) => setQ({ status: e.target.value === "pending" ? null : e.target.value })}>
        <option value="pending">To review</option><option value="approved">Approved</option><option value="dismissed">Dismissed</option><option value="all">All</option></select></label>
      <input type="search" placeholder="Search suggestions" defaultValue={search} aria-label="Search suggestions" onKeyDown={(e) => { if (e.key === "Enter") setQ({ q: (e.target as HTMLInputElement).value || null }); }} />
    </div>
    <p className="sub">Private to you. Suggestions found in Slack wait here until you create a task or dismiss them. Only the task fields you approve are sent to Task Tracker; Slack text and links stay here.</p>
    <Async s={s}>{(d) => !d.items.length ? <div className="state">{status === "pending" ? "Nothing to review." : "No suggestions here."}</div> :
      <div className="table-wrap"><table><thead><tr><th>Suggested task</th><th>Posted</th><th>Business</th><th>Assignee</th><th>Deadline</th><th>Review</th><th>Task Tracker</th></tr></thead>
        <tbody>{d.items.map((it: any) => <tr key={it.id} className="clickable" onClick={() => { location.hash = `#/planning/review/${it.id}`; }}>
          <td><a href={`#/planning/review/${it.id}`}><b>{it.fields.title}</b></a>{it.needs.length > 0 && it.status === "pending" && <div className="sub">{it.needs.length} decision{it.needs.length === 1 ? "" : "s"} to make</div>}</td>
          <td>{when(it.source.posted_at)}{it.source.is_reply && <div className="sub">Thread reply</div>}</td>
          <td>{it.fields.business ?? <span className="sub">Not set</span>}</td>
          <td>{it.fields.assignee?.name ?? <span className="sub">Not set</span>}</td>
          <td>{it.fields.due_date ? fmtDate(it.fields.due_date) : it.source.deadline_text ? <span className="sub">“{it.source.deadline_text}”</span> : <span className="sub">Not set</span>}</td>
          <td><span className={`chip ${it.status === "pending" ? "warn" : it.status === "dismissed" ? "muted" : ""}`}>{STATUS[it.status]}</span></td>
          <td>{it.status === "approved" ? <span className={`chip ${["failed", "unknown"].includes(it.delivery.status) ? "bad" : ""}`}>{DELIVERY[it.delivery.status]}</span> : <span className="sub">—</span>}</td>
        </tr>)}</tbody></table></div>}</Async>
  </div>;
}

function SuggestionDetail({ id }: { id: string }) {
  const s = useApi<any>(`/review/suggestions/${id}`, [id]);
  const dir = useApi<any>("/planning/directory");
  const [edit, setEdit] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (s.error?.status === 404) return <div className="state">Page not found.</div>;
  return <Async s={s}>{(d) => {
    const it = d.suggestion, f = it.fields;
    const run = async (fn: () => Promise<any>, done?: string) => { setBusy(true); setMsg(null); try { await fn(); if (done) setMsg(done); s.reload(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
    const brands = (dir.data?.brands ?? []).filter((b: any) => !edit?.business_id || b.business_id === edit.business_id);
    const people = (dir.data?.people ?? []).filter((p: any) => edit?.tracker_brand_id && p.brand_ids.includes(edit.tracker_brand_id));
    return <div>
      <p><a href="#/planning/review">← Slack Review</a></p>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div><h2 style={{ margin: 0 }}>{f.title}</h2><div className="sub">Posted {when(it.source.posted_at)}{it.source.is_reply ? " · thread reply" : ""}</div></div>
          <div className="row">
            <span className={`chip ${it.status === "pending" ? "warn" : it.status === "dismissed" ? "muted" : ""}`} title="Review status">{STATUS[it.status]}</span>
            {it.status === "approved" && <span className={`chip ${["failed", "unknown"].includes(it.delivery.status) ? "bad" : ""}`} title="Task Tracker delivery">{DELIVERY[it.delivery.status]}</span>}
          </div>
        </div>
        <h3>From Slack <span className="sub">(private)</span></h3>
        <blockquote className="card flat" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{it.source.excerpt}</blockquote>
        <div className="row sub" style={{ marginTop: 6 }}>
          {it.source.message_url && <a href={it.source.message_url} target="_blank" rel="noopener noreferrer">Open the message in Slack</a>}
          {it.source.thread_url && <a href={it.source.thread_url} target="_blank" rel="noopener noreferrer">Open the thread</a>}
        </div>
        {it.source.followups.length > 0 && <><h4>Follow-ups</h4><ul className="list">{it.source.followups.map((x: any, i: number) => <li key={i}><span className="sub">{when(x.posted_at)}</span> {x.excerpt} {x.message_url && <a href={x.message_url} target="_blank" rel="noopener noreferrer">Open</a>}</li>)}</ul></>}
        {it.source.scanner_note && <p className="sub">Scanner note: {it.source.scanner_note}</p>}
        {it.needs.length > 0 && it.status !== "dismissed" && <div className="notice">Decisions to make: {it.needs.join("; ")}.</div>}

        <h3>Task</h3>
        {!edit ? <dl className="kv">
          <dt>Title</dt><dd>{f.title}</dd>
          <dt>Brief</dt><dd style={{ whiteSpace: "pre-wrap" }}>{f.brief || <span className="sub">None</span>}</dd>
          <dt>Business</dt><dd>{f.business ?? <span className="sub">Not set</span>}{!f.business_id && it.suggested.business ? <span className="sub"> (suggested: {BUSINESS_NAMES[it.suggested.business]})</span> : null}</dd>
          <dt>Assignee</dt><dd>{f.assignee ? `${f.assignee.name} (${f.brand?.name})` : <span className="sub">Not set</span>}{!f.assignee && it.suggested.assignee ? <span className="sub"> (Slack mentions: {it.suggested.assignee})</span> : null}</dd>
          <dt>Deadline</dt><dd>{f.due_date ? fmtDate(f.due_date) : <span className="sub">Not set{it.source.deadline_text ? ` (Slack said “${it.source.deadline_text}”)` : ""}</span>}</dd>
        </dl> : <form className="card flat stack-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/review/suggestions/${id}`, { method: "PATCH", json: { version: it.version, ...edit, brief: edit.brief || null, business_id: edit.business_id || null, tracker_brand_id: edit.tracker_brand_id || null, tracker_assignee_id: edit.tracker_assignee_id || null, due_date: edit.due_date || null } }); setEdit(null); }, "Saved."); }}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          <label style={{ gridColumn: "1 / -1" }}>Title<input aria-label="Title" required maxLength={300} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          <label style={{ gridColumn: "1 / -1" }}>Brief (sent with the task)<textarea aria-label="Brief" rows={3} maxLength={1500} value={edit.brief} onChange={(e) => setEdit({ ...edit, brief: e.target.value })} /></label>
          <label>Business<select aria-label="Business" value={edit.business_id} onChange={(e) => setEdit({ ...edit, business_id: e.target.value, tracker_brand_id: "", tracker_assignee_id: "" })}>
            <option value="">Choose</option>{Object.entries(BUSINESS_NAMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Task Tracker brand<select aria-label="Task Tracker brand" value={edit.tracker_brand_id} onChange={(e) => setEdit({ ...edit, tracker_brand_id: e.target.value, tracker_assignee_id: "" })}>
            <option value="">Choose</option>{brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label>Assignee<select aria-label="Assignee" value={edit.tracker_assignee_id} onChange={(e) => setEdit({ ...edit, tracker_assignee_id: e.target.value })}>
            <option value="">Choose</option>{people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Deadline<input aria-label="Deadline" type="date" value={edit.due_date} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} /></label>
          {dir.error && <div className="notice" style={{ gridColumn: "1 / -1" }}>Task Tracker's people list could not be read: {dir.error.message}</div>}
          <div className="row" style={{ gridColumn: "1 / -1" }}><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
        </form>}

        {it.task && <p>Task Tracker: <span className="chip">{TASK[it.task.status] ?? it.task.status}</span> {it.task.as_of && <span className="sub">as of {when(it.task.as_of)}</span>} {it.task.open_url && <a href={it.task.open_url} target="_blank" rel="noopener noreferrer">Open the task</a>}</p>}
        {it.delivery.error && it.status === "approved" && <div className="notice">{it.delivery.error}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          {!it.locked && it.status !== "dismissed" && !edit && <button className="btn small" onClick={() => setEdit({ title: f.title, brief: f.brief ?? "", business_id: f.business_id ?? it.suggested.business ?? "", tracker_brand_id: f.brand?.id ?? "", tracker_assignee_id: f.assignee?.id ?? "", due_date: f.due_date ?? "" })}>Review and edit</button>}
          {it.status !== "dismissed" && it.delivery.status !== "created" && <button className="btn small primary" disabled={busy} onClick={() => run(async () => setPreview(await api(`/review/suggestions/${id}/preview`, { method: "POST" })))}>
            {["failed", "unknown", "sending"].includes(it.delivery.status) ? "Retry creating the task" : "Create task"}</button>}
          {!it.locked && it.status !== "dismissed" && <button className="btn small" disabled={busy} onClick={() => { if (confirm("Dismiss this suggestion? It won't come back in later scans.")) run(() => api(`/review/suggestions/${id}/dismiss`, { method: "POST", json: { version: it.version } }), "Dismissed."); }}>Dismiss</button>}
          {(it.delivery.status === "created" || it.delivery.status === "unknown") && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/review/suggestions/${id}/refresh`, { method: "POST" }), "Checked Task Tracker.")}>Check Task Tracker</button>}
        </div>
        {msg && <div className="notice">{msg}</div>}
      </div>
      {preview && <Drawer onClose={() => setPreview(null)}>
        <h2>Create task</h2>
        <p className="sub">This exact task is created in Task Tracker. Nothing from Slack is sent. Creating it again never makes a second task.</p>
        <dl className="kv"><dt>Title</dt><dd><b>{preview.send.title}</b></dd><dt>Business</dt><dd>{preview.send.business ?? "—"}</dd><dt>Brand</dt><dd>{preview.send.brand ?? "—"}</dd>
          <dt>Assignee</dt><dd>{preview.send.assignee ?? "—"}</dd><dt>Due date</dt><dd>{fmtDate(preview.send.due_date) || "—"}</dd><dt>Brief</dt><dd style={{ whiteSpace: "pre-wrap" }}>{preview.send.brief || "—"}</dd></dl>
        {preview.problems.length > 0 && <div className="notice">Before creating it: {preview.problems.join("; ")}.</div>}
        {!preview.tracker_connected && <div className="notice">Task Tracker is not connected.</div>}
        <div className="row"><button className="btn primary" disabled={busy || preview.problems.length > 0} onClick={() => run(async () => {
          const r = await api<any>(`/review/suggestions/${id}/create`, { method: "POST", json: { version: preview.version } });
          setPreview(null);
          setMsg(r.outcome === "created" ? (r.existing ? "Linked the existing Task Tracker task." : "Task created in Task Tracker.") : r.message ?? "The task needs a retry.");
        })}>Create task</button><button className="btn" onClick={() => setPreview(null)}>Cancel</button></div>
      </Drawer>}
    </div>;
  }}</Async>;
}
