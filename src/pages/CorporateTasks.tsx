// Corporate Gifts tasks: the planning owner's queue of tasks from the Corporate Gifts app (explicit, open actions for
// its marketplaces). Drafts arrive with the default assignee (if one is set); the owner can assign several at once and send
// them to Task Tracker, where they appear in Marketing Tasks. The server returns 404 to anyone else.
import { useMemo, useState } from "react";
import { api, useApi, Async, when, Drawer } from "../lib";

const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
const STATUS: Record<string, string> = { pending: "To review", approved: "Approved", dismissed: "Dismissed" };
const DELIVERY: Record<string, string> = { not_sent: "Not sent", sending: "Sending…", created: "In Task Tracker", failed: "Needs retry", unknown: "No answer: retry to settle" };
const TASK: Record<string, string> = { open: "Open", done: "Done", deleted: "Deleted in Task Tracker" };

export function CorporateTasks() {
  const [status, setStatus] = useState("pending");
  const s = useApi<any>(`/review/corporate?status=${status}`, [status]);
  const dir = useApi<any>("/planning/directory");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const people = useMemo(() => {
    const d = dir.data;
    if (!d) return [];
    const sb = d.brands.filter((b: any) => b.business_id === "sb").map((b: any) => b.id);
    return d.people.filter((p: any) => p.brand_ids.some((x: string) => sb.includes(x)));
  }, [dir.data]);
  const items: any[] = s.data?.items ?? [];
  const selectable = items.filter((i) => ["not_sent", "failed", "unknown"].includes(i.delivery.status) && i.status !== "dismissed");
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = async (f: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg(await f()); s.reload(); window.dispatchEvent(new Event("corporate-tasks-changed")); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const ids = [...sel].filter((id) => selectable.some((i) => i.id === id));
  return <div>
    <div className="toolbar">
      <b>Corporate Gifts tasks</b>
      <label>Show <select value={status} onChange={(e) => { setStatus(e.target.value); setSel(new Set()); }}>
        <option value="pending">To review</option><option value="approved">Sent</option><option value="dismissed">Dismissed</option><option value="all">All</option></select></label>
      <button className="btn small" disabled={busy} onClick={() => run(async () => { const r = await api("/review/corporate/refresh", { method: "POST" });
        return r.outcome === "done" ? `Read from Corporate Gifts: ${r.added} new, ${r.updated} updated.` : r.error ?? "Corporate Gifts is not connected."; })}>Refresh from Corporate Gifts</button>
    </div>
    <p className="sub">Private to you. Explicit Corporate Gifts actions from the Corporate Gifts app. Each arrives with the default assignee; change the assignee or due date (one at a time or in bulk), then send. Sent tasks appear in Marketing Tasks with the Corporate Gifts tag. Sending again never creates a duplicate.</p>
    {s.data?.last_sync && !s.data.last_sync.ok && <div className="notice">Last read from Corporate Gifts failed ({when(s.data.last_sync.at)}): {s.data.last_sync.message}</div>}
    {s.data && !s.data.tracker_connected && <div className="notice">Task Tracker is not connected for planning; tasks can be reviewed but not sent.</div>}
    {selectable.length > 0 && <div className="toolbar" aria-label="Bulk actions">
      <span className="sub">{ids.length} selected</span>
      <button className="btn small" onClick={() => setSel(ids.length === selectable.length ? new Set() : new Set(selectable.map((i) => i.id)))}>{ids.length === selectable.length ? "Clear" : "Select all"}</button>
      <label>Assign to <select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">(keep)</option>
        {people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Due <input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <button className="btn small" disabled={busy || !ids.length || (!assignee && !due)} onClick={() => run(async () => {
        const r = await api("/review/corporate/bulk-assign", { method: "POST", json: { ids, ...(assignee ? { tracker_assignee_id: assignee } : {}), ...(due ? { due_date: due } : {}) } });
        return `Updated ${r.changed} draft(s)${r.skipped ? `; ${r.skipped} already sent or dismissed were left as they are` : ""}.`;
      })}>Apply to selected</button>
      <button className="btn small primary" disabled={busy || !ids.length} onClick={() => run(async () => {
        const r = await api("/review/corporate/send", { method: "POST", json: { ids } });
        setSel(new Set());
        const n = (o: string) => r.results.filter((x: any) => x.outcome === o).length;
        const skipped = r.results.filter((x: any) => x.outcome === "skipped");
        return `Sent: ${n("created")} created in Task Tracker${n("failed") ? `, ${n("failed")} need a retry` : ""}${n("unknown") ? `, ${n("unknown")} got no answer (retry settles them)` : ""}${skipped.length ? `, ${skipped.length} not ready (${skipped[0].message})` : ""}.`;
      })}>Send selected to Task Tracker</button>
    </div>}
    {msg && <div className="notice" role="status">{msg}</div>}
    <Async s={s}>{(d) => !d.items.length ? <div className="state">{status === "pending" ? "Nothing to review." : "No tasks here."}</div> :
      <div className="table-wrap"><table><thead><tr><th /><th>Task</th><th>Marketplaces</th><th>Assignee</th><th>Due</th><th>Status</th><th /></tr></thead>
        <tbody>{d.items.map((it: any) => {
          const can = selectable.some((x) => x.id === it.id);
          return <tr key={it.id}>
            <td>{can && <input type="checkbox" aria-label={`Select ${it.fields.title}`} checked={sel.has(it.id)} onChange={() => toggle(it.id)} />}</td>
            <td><b>{it.fields.title}</b>{it.source.owner_hint && <div className="sub">Owner in Slack: {it.source.owner_hint}</div>}
              {it.needs.length > 0 && <div className="sub bad">{it.needs.join("; ")}</div>}
              {it.delivery.error && ["failed", "unknown"].includes(it.delivery.status) && <div className="sub bad">{it.delivery.error}</div>}</td>
            <td>{(it.source.partners ?? []).map((p: any, n: number) => <span key={n}>{n > 0 && ", "}<a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a></span>)}</td>
            <td>{it.task?.assignee ?? it.fields.assignee?.name ?? <span className="sub">Not set</span>}</td>
            <td>{fmtDate(it.task?.due_date ?? it.fields.due_date) || <span className="sub">Not set</span>}</td>
            <td><span className={`chip ${it.status === "pending" ? "warn" : it.status === "dismissed" ? "muted" : ""}`}>{STATUS[it.status]}</span>
              {it.status !== "pending" && it.status !== "dismissed" && <> <span className={`chip ${["failed", "unknown"].includes(it.delivery.status) ? "bad" : ""}`}>{DELIVERY[it.delivery.status]}</span></>}
              {it.task && <> <span className="chip muted">{TASK[it.task.status] ?? it.task.status}</span></>}</td>
            <td>{it.task?.open_url ? <a href={it.task.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a>
              : can && <><button className="btn small" onClick={() => setEdit(it)}>Edit</button> <button className="btn small" disabled={busy} onClick={() => run(async () => {
                await api(`/review/corporate/${it.id}/dismiss`, { method: "POST", json: { version: it.version } }); return "Dismissed."; })}>Dismiss</button></>}</td>
          </tr>;
        })}</tbody></table></div>}</Async>
    {edit && <EditDraft it={edit} people={people} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); s.reload(); }} />}
  </div>;
}

function EditDraft({ it, people, onClose, onSaved }: { it: any; people: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ title: it.fields.title, brief: it.fields.brief ?? "", assignee: it.fields.assignee?.id ?? "", due: it.fields.due_date ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/review/corporate/${it.id}`, { method: "PATCH", json: { version: it.version, title: f.title, brief: f.brief || null, tracker_assignee_id: f.assignee || null, due_date: f.due || null } });
      onSaved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <Drawer onClose={onClose}>
    <h2>Edit task</h2>
    <p className="sub">Task Tracker receives the title, this note with the marketplace links, the assignee and the due date.</p>
    {err && <div className="notice" role="alert">{err}</div>}
    <label>Title <input value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
    <label>Note <textarea rows={4} maxLength={1500} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} /></label>
    <label>Assignee <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}><option value="">Not set</option>
      {people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>Due date <input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
    <pre className="sub">{it.sent_brief}</pre>
    <div className="row"><button className="btn primary" disabled={busy} onClick={save}>Save</button> <button className="btn" onClick={onClose}>Cancel</button></div>
  </Drawer>;
}
