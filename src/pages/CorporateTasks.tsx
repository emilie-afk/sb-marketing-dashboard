// Corporate Gifts tasks: the planning owner's queue of tasks from the Corporate Gifts app (explicit, open actions for
// its marketplaces). Drafts arrive with the default assignee (if one is set); the owner can assign several at once and send
// them to Task Tracker, where they appear in Marketing Tasks. The server returns 404 to anyone else.
// The "To review" status is a button: Resolve, Dismiss or Add to task happen in place, and the row updates where it is.
import { useEffect, useMemo, useState } from "react";
import { api, useApi, Async, when, Drawer } from "../lib";
import { StatusMenu } from "./ReviewParts";

const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
const STATUS: Record<string, string> = { pending: "To review", approved: "Approved", resolved: "Resolved", dismissed: "Dismissed" };
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
  const [addTask, setAddTask] = useState<any | null>(null);
  // Rows changed in place since the list was read: they stay where they are (with their new status) until the filter changes.
  const [patched, setPatched] = useState<Record<string, any>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string } | null>(null);
  const patch = (d: any, text?: string) => { setPatched((p) => ({ ...p, [d.id]: d })); if (text) setRowMsg({ id: d.id, text }); window.dispatchEvent(new Event("corporate-tasks-changed")); };
  const rowAct = async (it: any, fn: () => Promise<any>, text: string) => {
    setRowBusy(it.id); setRowMsg(null);
    try { patch((await fn()).draft, text); }
    catch (e: any) {
      // Refused (e.g. the task already exists in Task Tracker): show the row as it is now (status and link), with the reason.
      if (e.status === 409) { try { patch((await api<any>(`/review/corporate/${it.id}`)).draft); } catch { /* keep the old row */ } }
      setRowMsg({ id: it.id, text: e.message });
    } finally { setRowBusy(null); }
  };
  const people = useMemo(() => {
    const d = dir.data;
    if (!d) return [];
    const sb = d.brands.filter((b: any) => b.business_id === "sb").map((b: any) => b.id);
    return d.people.filter((p: any) => p.brand_ids.some((x: string) => sb.includes(x)));
  }, [dir.data]);
  const items: any[] = (s.data?.items ?? []).map((i: any) => patched[i.id] ?? i);
  const selectable = items.filter((i) => ["not_sent", "failed", "unknown"].includes(i.delivery.status) && !["dismissed", "resolved", "moved"].includes(i.status));
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = async (f: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg(await f()); s.reload(); window.dispatchEvent(new Event("corporate-tasks-changed")); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const ids = [...sel].filter((id) => selectable.some((i) => i.id === id));
  return <div>
    <div className="toolbar">
      <b>Corporate Gifts tasks</b>
      <label>Show <select value={status} onChange={(e) => { setStatus(e.target.value); setSel(new Set()); setPatched({}); setRowMsg(null); }}>
        <option value="pending">To review</option><option value="approved">Sent</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option><option value="all">All</option></select></label>
      <button className="btn small" disabled={busy} onClick={() => run(async () => { const r = await api("/review/corporate/refresh", { method: "POST" });
        return r.outcome === "done" ? `Read from Corporate Gifts: ${r.added} new, ${r.updated} updated.` : r.error ?? "Corporate Gifts is not connected."; })}>Refresh from Corporate Gifts</button>
    </div>
    <p className="sub">Private to you. Marketing tasks from the Corporate Gifts app. Each arrives with the default assignee; change the assignee or due date (one at a time or in bulk), then send. Sent tasks appear in Marketing Tasks with the Corporate Gifts tag. Sending again never creates a duplicate. Resolve closes a draft (it is then never sent) or completes the task in Task Tracker; it works the same in Corporate Gifts.</p>
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
      <div className="table-wrap"><table className="review-table"><thead><tr><th /><th>Task</th><th>Marketplaces</th><th>Assignee</th><th>Due</th><th>Status</th><th /></tr></thead>
        <tbody>{items.map((it: any) => {
          const can = selectable.some((x) => x.id === it.id);
          return <tr key={it.id}>
            <td>{can && <input type="checkbox" aria-label={`Select ${it.fields.title}`} checked={sel.has(it.id)} onChange={() => toggle(it.id)} />}</td>
            <td><b>{it.fields.title}</b>{it.source.owner_hint && <div className="sub">Owner in Slack: {it.source.owner_hint}</div>}
              {it.needs.length > 0 && <div className="sub bad">{it.needs.join("; ")}</div>}
              {it.delivery.error && ["failed", "unknown"].includes(it.delivery.status) && <div className="sub bad">{it.delivery.error}</div>}
              {rowMsg?.id === it.id && <div className="sub" role="status">{rowMsg?.text}</div>}</td>
            <td>{(it.source.partners ?? []).map((p: any, n: number) => <span key={n}>{n > 0 && ", "}<a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a></span>)}</td>
            <td>{it.task?.assignee ?? it.fields.assignee?.name ?? <span className="sub">Not set</span>}</td>
            <td>{fmtDate(it.task?.due_date ?? it.fields.due_date) || <span className="sub">Not set</span>}</td>
            <td>{it.status === "pending" ? <StatusMenu label="To review" busy={rowBusy === it.id} actions={[
                { label: "Resolve", hint: "Handled; no task", onClick: () => rowAct(it, () => api(`/review/corporate/${it.id}/resolve`, { method: "POST", json: { version: it.version } }), "Resolved.") },
                { label: "Dismiss", hint: "No action needed", onClick: () => rowAct(it, () => api(`/review/corporate/${it.id}/dismiss`, { method: "POST", json: { version: it.version } }), "Dismissed.") },
                { label: "Add to task", hint: "Confirm the fields, send to Task Tracker", onClick: () => setAddTask(it) },
              ]} /> : <span className={`chip ${["dismissed", "resolved"].includes(it.status) ? "muted" : ""}`}>{STATUS[it.status]}{it.resolved_in === "corporate_gifts" ? " in Corporate Gifts" : ""}</span>}
              {it.cg_state === "resolved" && it.status !== "resolved" && !it.task && <div className="sub">Resolved in Corporate Gifts: closes here once Task Tracker confirms no task.</div>}
              {!["pending", "dismissed", "resolved"].includes(it.status) && <> <span className={`chip ${["failed", "unknown"].includes(it.delivery.status) ? "bad" : it.delivery.status === "sending" ? "warn" : ""}`}>{DELIVERY[it.delivery.status]}</span></>}
              {it.task && <> <span className="chip muted">{TASK[it.task.status] ?? it.task.status}</span></>}
              {it.task && it.resolution?.state === "resolved" && <> <span className="chip">Resolved {fmtDate(it.resolution.completed_on)}</span></>}
              {it.resolution?.state === "requested" && <> <span className={`chip ${it.resolution.error ? "bad" : ""}`}>{it.resolution.error ? `Resolve failed: ${it.resolution.error}` : "Resolving in Task Tracker…"}</span></>}</td>
            <td>{it.task?.open_url ? <><a href={it.task.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a>
                {resolvable(it) && <> <button className="btn small" disabled={rowBusy === it.id} title="Completes the task in Task Tracker" onClick={() => rowAct(it, async () => {
                  const r = await api<any>(`/review/corporate/${it.id}/resolve`, { method: "POST", json: { version: it.version } });
                  if (r.message) setTimeout(() => setRowMsg({ id: it.id, text: `Not completed yet: ${r.message}` }));
                  return r; }, "Completed in Task Tracker.")}>Resolve</button></>}</>
              : it.status === "approved" && ["failed", "unknown", "sending"].includes(it.delivery.status) ? <><button className="btn small" disabled={rowBusy === it.id} onClick={() => rowAct(it, async () => {
                  await api("/review/corporate/send", { method: "POST", json: { ids: [it.id] } }); return api(`/review/corporate/${it.id}`); }, "Checked with Task Tracker.")}>Retry</button> <button className="btn small" disabled={rowBusy === it.id} title="Handled without a task (Task Tracker is checked first)" onClick={() => rowAct(it, () => api(`/review/corporate/${it.id}/resolve`, { method: "POST", json: { version: it.version } }), "Resolved.")}>Resolve</button></>
              : can && !["dismissed", "resolved"].includes(it.status) && <button className="btn small" onClick={() => setEdit(it)}>Edit</button>}</td>
          </tr>;
        })}</tbody></table></div>}</Async>
    {edit && <EditDraft it={edit} people={people} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); patch(d); }} />}
    {addTask && <EditDraft it={addTask} people={people} send onClose={() => setAddTask(null)} onSaved={(d, text) => { setAddTask(null); patch(d, text); }} />}
    <Checkoffs />
  </div>;
}

/** Open unless resolved, dismissed, or a delivery that isn't settled yet. */
const resolvable = (it: any) => it.status !== "dismissed" && it.status !== "resolved" && it.resolution?.state !== "resolved"
  && !["sending", "unknown"].includes(it.delivery.status) && !(it.resolution?.state === "requested" && !it.resolution.error) && it.task?.status !== "done";

/**
 * Check-off items (Corporate Gifts work owned outside Marketing) and items waiting for a routing decision. The same
 * records as in Corporate Gifts → Marketplace Resources → Corporate Gifts tasks; actions are applied there.
 */
function Checkoffs() {
  const [status, setStatus] = useState("open");
  const s = useApi<any>(`/review/corporate-checkoffs?status=${status}`, [status]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { const h = () => s.reload(); window.addEventListener("corporate-tasks-changed", h); return () => window.removeEventListener("corporate-tasks-changed", h); }, []);
  const items: any[] = s.data?.items ?? [];
  const routing = items.filter((i) => i.state === "open" && i.route === "review");
  const checks = items.filter((i) => i.route !== "review" || i.state !== "open");
  const openChecks = checks.filter((i) => i.state === "open");
  const ids = [...sel].filter((id) => openChecks.some((i) => i.id === id));
  const run = async (f: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg(await f()); s.reload(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const markDone = (list: string[]) => run(async () => {
    const r = await api("/review/corporate-checkoffs/mark-done", { method: "POST", json: { ids: list } });
    const failed = r.results.filter((x: any) => x.outcome === "failed");
    setSel(new Set(failed.map((x: any) => x.id)));   // failed ones stay selected for a retry
    return `${r.results.length - failed.length} marked done${failed.length ? `; ${failed.length} failed (${failed[0].message ?? "error"}) and stay selected` : ""}.`;
  });
  const parts = (it: any) => (it.partners ?? []).map((p: any, n: number) => <span key={n}>{n > 0 && ", "}<a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a></span>);
  return <div style={{ marginTop: 20 }}>
    <div className="toolbar"><b>Check-off items</b>
      <label>Show <select value={status} onChange={(e) => { setStatus(e.target.value); setSel(new Set()); }}><option value="open">Open</option><option value="done">Done</option><option value="all">All</option></select></label>
      {openChecks.length > 0 && <><button className="btn small" onClick={() => setSel(ids.length === openChecks.length ? new Set() : new Set(openChecks.map((i) => i.id)))}>{ids.length === openChecks.length ? "Clear" : "Select all"}</button>
        <button className="btn small primary" disabled={busy || !ids.length} onClick={() => markDone(ids)}>Mark done ({ids.length})</button></>}
    </div>
    <p className="sub">Corporate Gifts work owned outside Marketing (including partners). No Task Tracker task is created; marking one done here also marks it done in Corporate Gifts, and the weekly report lists it once.</p>
    {msg && <div className="notice" role="status">{msg}</div>}
    {routing.length > 0 && <><h4>Needs routing ({routing.length})</h4><div className="table-wrap"><table><thead><tr><th>Action</th><th>Marketplaces</th><th>Why</th><th /></tr></thead>
      <tbody>{routing.map((it) => <tr key={it.id}><td><b>{it.title}</b>{it.owner && <div className="sub">Owner in Slack: {it.owner}</div>}</td><td>{parts(it)}</td><td className="sub">{it.route_reason}</td>
        <td><button className="btn small" disabled={busy} onClick={() => run(async () => { await api(`/review/corporate-checkoffs/${it.id}/route`, { method: "POST", json: { route: "marketing", version: it.version } }); window.dispatchEvent(new Event("corporate-tasks-changed")); return "Assigned as a Marketing task: it is now a draft above."; })}>Assign as Marketing task</button>{" "}
          <button className="btn small" disabled={busy} onClick={() => run(async () => { await api(`/review/corporate-checkoffs/${it.id}/route`, { method: "POST", json: { route: "checkoff", version: it.version } }); return "Tracked as a check-off item."; })}>Track as check-off</button></td></tr>)}</tbody></table></div></>}
    <Async s={s}>{() => !checks.length ? <div className="state">{status === "open" ? "No open check-off items." : "None."}</div> :
      <div className="table-wrap"><table><thead><tr><th /><th>Action</th><th>Marketplaces</th><th>Owner</th><th>Due</th><th>Status</th><th /></tr></thead>
        <tbody>{checks.map((it) => <tr key={it.id}>
          <td>{it.state === "open" && <input type="checkbox" aria-label={`Select ${it.title}`} checked={sel.has(it.id)} onChange={() => setSel((x) => { const n = new Set(x); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })} />}</td>
          <td><b>{it.title}</b></td><td>{parts(it)}</td><td>{it.owner ?? <span className="sub">Not set</span>}</td><td>{fmtDate(it.due_date) || <span className="sub">—</span>}</td>
          <td>{it.state === "done" ? <span className="chip">Resolved {fmtDate(it.completed_on)}{it.completion_source === "slack" ? " (Slack)" : ""}</span> : it.state === "closed" ? <span className="chip muted">Closed</span> : <span className="chip warn">Open</span>}</td>
          <td>{it.state === "open" && <button className="btn small" disabled={busy} onClick={() => markDone([it.id])}>Resolve</button>}</td></tr>)}</tbody></table></div>}</Async>
  </div>;
}


/** Edit a draft, or (send) confirm its fields and send it as one Task Tracker task. Retries and double clicks never duplicate it. */
function EditDraft({ it, people, onClose, onSaved, send = false }: { it: any; people: any[]; onClose: () => void; onSaved: (d: any, text?: string) => void; send?: boolean }) {
  const [f, setF] = useState({ title: it.fields.title, brief: it.fields.brief ?? "", assignee: it.fields.assignee?.id ?? "", due: it.fields.due_date ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const save = async () => {
    setBusy("Saving…"); setErr(null);
    try {
      let d = (await api<any>(`/review/corporate/${it.id}`, { method: "PATCH", json: { version: it.version, title: f.title, brief: f.brief || null, tracker_assignee_id: f.assignee || null, due_date: f.due || null } })).draft;
      if (!send) return onSaved(d);
      setBusy("Sending…");
      const r = await api<any>("/review/corporate/send", { method: "POST", json: { ids: [it.id] } });
      const out = r.results[0];
      d = (await api<any>(`/review/corporate/${it.id}`)).draft;
      onSaved(d, out?.outcome === "created" ? (out.existing ? "Linked the existing Task Tracker task." : "Sent to Task Tracker.") : out?.message ?? "Needs a retry.");
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  return <Drawer onClose={onClose}>
    <h2>{send ? "Add to task" : "Edit task"}</h2>
    <p className="sub">{send ? "Creates one task in Task Tracker for Succulents Box, shown in Marketing Tasks under the assignee. " : ""}Task Tracker receives the title, this note with the marketplace links, the assignee and the due date.</p>
    {err && <div className="notice" role="alert">{err}</div>}
    {send && <p><b>Business:</b> Succulents Box</p>}
    <label>Title <input value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
    <label>Note <textarea rows={4} maxLength={1500} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} /></label>
    <label>Assignee <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}><option value="">Not set</option>
      {people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>Due date <input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
    <pre className="sub">{it.sent_brief}</pre>
    <div className="row"><button className="btn primary" disabled={!!busy || (send && (!f.title.trim() || !f.assignee || !f.due))} onClick={save}>{busy ?? (send ? "Send to Task Tracker" : "Save")}</button> <button className="btn" onClick={onClose}>Cancel</button></div>
  </Drawer>;
}
