import { useState } from "react";
import { useApi, Async, Tabs, BUSINESS_NAMES, api, Drawer, when } from "../lib";

const STATUSES: [string, string][] = [["todo", "To do"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["done", "Done"]];

export function TasksPage({ role }: { role: string }) {
  const [view, setView] = useState("list");
  const [business, setBusiness] = useState("");
  const [owner, setOwner] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const s = useApi<any>(`/tasks?${business ? `business=${business}&` : ""}${owner ? `owner=${encodeURIComponent(owner)}` : ""}`, [business, owner]);
  const setStatus = async (t: any, status: string) => {
    if (t.read_only) return;
    try {
      if (t.occurrence) await api(`/tasks/${t.id}/occurrences/${t.occurrence}`, { method: "PATCH", json: { status } });
      else await api(`/tasks/${t.id}`, { method: "PATCH", json: { status, version: t.version } });
      s.reload();
    } catch (e: any) { alert(e.message); }
  };
  return (
    <div>
      <Tabs tabs={[["list", "List"], ["board", "Board"]]} value={view} onChange={setView} />
      <div className="toolbar">
        <label>Business <select value={business} onChange={(e) => setBusiness(e.target.value)}><option value="">All</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Owner <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Any" /></label>
        <span className="spacer" />{role !== "viewer" && <button className="btn primary small" onClick={() => setCreating(true)}>New task</button>}
        <span className="sub">Dashboard tasks are edited here. Task Tracker tasks are read-only copies; open them in the Task Tracker to change them. Deadlines use Vietnam time.</span>
      </div>
      <Async s={s}>{(d) => {
        const items = d.items.filter((t: any) => t.status !== "cancelled");
        const tr = d.tracker;
        const freshness = tr && tr.status !== "not_configured" ? <p className={`sub ${tr.status === "failing" ? "bad" : ""}`}>Task Tracker copy: {tr.last_success_at ? `last updated ${when(tr.last_success_at)}` : "not read yet"}{tr.status === "failing" ? ` · the latest read failed, showing the last good copy` : ""}.</p> : null;
        return <>{freshness}{view === "list" ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Task name</th><th>Business</th><th>Activity</th><th>Owner</th><th>Status</th><th>Due date</th><th>Related promotion</th></tr></thead>
            <tbody>{items.map((t: any) => <tr key={`${t.id}${t.occurrence ?? ""}`} className="clickable" onClick={() => setOpen(t.id)}>
              <td><b>{t.title}</b>{t.read_only && <span className="chip muted" style={{ marginLeft: 6 }}>Task Tracker</span>}{t.recurrence && <span className="chip muted" style={{ marginLeft: 6 }}>repeats</span>}{t.file_count > 0 && <span className="sub"> · {t.file_count} file(s)</span>}</td>
              <td>{BUSINESS_NAMES[t.business_id]}</td><td>{t.activity}</td><td>{t.owner ?? "Unassigned"}</td>
              <td onClick={(e) => e.stopPropagation()}>{role === "viewer" || t.read_only ? t.status : <select value={t.status} onChange={(e) => setStatus(t, e.target.value)}>{[...STATUSES, ["cancelled", "Cancelled"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</td>
              <td className={t.status !== "done" && t.due_date && t.due_date < d.today ? "bad" : ""}>{t.due_date ?? "Not set"}</td><td>{t.promotion_title ?? ""}</td></tr>)}</tbody>
          </table></div>
        ) : (
          <div className="board">{STATUSES.map(([k, l]) => <div key={k} className="col"><h4>{l}</h4>
            {items.filter((t: any) => t.status === k).map((t: any) => <div key={`${t.id}${t.occurrence ?? ""}`} className="tcard" onClick={() => setOpen(t.id)}>
              <b>{t.title}</b><div className="sub">{BUSINESS_NAMES[t.business_id]} · {t.owner ?? "Unassigned"}{t.due_date ? ` · ${t.due_date}` : ""}</div>
              {role !== "viewer" && !t.read_only && <div className="row" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>{STATUSES.filter(([x]) => x !== k).map(([x, xl]) => <button key={x} className="btn small" onClick={() => setStatus(t, x)}>{xl}</button>)}</div>}
            </div>)}</div>)}</div>
        )}</>; }}</Async>
      {open && <TaskDrawer key={open} id={open} role={role} onClose={() => { setOpen(null); s.reload(); }} />}
      {creating && <NewTask onClose={() => { setCreating(false); s.reload(); }} />}
    </div>
  );
}

function NewTask({ onClose }: { onClose: () => void }) {
  const promos = useApi<any>("/business/sb/promotions");
  const [err, setErr] = useState<string | null>(null);
  return <Drawer onClose={onClose}><h2>New task</h2>
    <form className="grid" onSubmit={async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as any;
      try { await api("/tasks", { method: "POST", json: { title: f.title, business_id: f.business_id, activity: f.activity || null, owner: f.owner || null, status: f.status, due_date: f.due_date || null,
        promotion_id: f.promotion_id || null, recurrence: f.recurrence || null, description: f.description || null, links: f.url ? [{ target_type: "url", url: f.url }] : [] } }); onClose(); }
      catch (x: any) { setErr(x.message + (x.details ? `: ${x.details.map((d: any) => d.message).join(", ")}` : "")); } }}>
      <label>Task name <input name="title" required maxLength={300} style={{ width: "100%" }} /></label>
      <div className="row"><label>Business <select name="business_id">{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Activity <input name="activity" placeholder="e.g. Email" /></label><label>Owner <input name="owner" /></label></div>
      <div className="row"><label>Status <select name="status">{STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label><label>Due date <input type="date" name="due_date" /></label>
        <label>Repeats <select name="recurrence"><option value="">No</option><option value="daily">Daily</option>{[1, 2, 3, 4, 5].map((d) => <option key={d} value={`weekly:${d}`}>Weekly on {["Mon", "Tue", "Wed", "Thu", "Fri"][d - 1]}</option>)}<option value="monthly:1">Monthly on the 1st</option><option value="monthly:last">Monthly on the last day</option></select></label></div>
      <label>Related promotion <select name="promotion_id"><option value="">None</option>{(promos.data?.promotions ?? []).filter((p: any) => p.kind !== "vendor_offer").map((p: any) => <option key={p.id} value={p.id}>{p.title} ({p.start_date})</option>)}</select></label>
      <label>Supporting link <input name="url" placeholder="https://" /></label>
      <label>Notes <textarea name="description" /></label>
      {err && <div className="state error">{err}</div>}
      <div><button className="btn primary">Create task</button></div>
    </form></Drawer>;
}

function TaskDrawer({ id, role, onClose }: { id: string; role: string; onClose: () => void }) {
  const s = useApi<any>(`/tasks/${encodeURIComponent(id)}`, [id]);
  const [comment, setComment] = useState("");
  if (id.startsWith("tracker:")) return <Drawer onClose={onClose}><Async s={s}>{(d) => <>
    <h2>{d.task.title}</h2>
    <p className="sub">From the Task Tracker. Read-only here; the Task Tracker is where this task is edited.</p>
    <dl className="kv"><dt>Business</dt><dd>{BUSINESS_NAMES[d.task.business_id]}</dd><dt>Brand</dt><dd>{d.task.brand_name}{d.task.brand_archived ? " (archived)" : ""}</dd>
      <dt>Owner</dt><dd>{d.task.owner}{d.task.owner_archived ? " (archived)" : ""}</dd><dt>Status</dt><dd>{d.task.status === "done" ? "Done" : "Open"}</dd>
      <dt>Due</dt><dd>{d.task.due_date ?? "Not set"}{d.task.recurrence ? ` (one occurrence of a ${d.task.recurrence} task)` : ""}</dd><dt>Synced</dt><dd>{when(d.task.synced_at)}</dd></dl>
    {typeof d.task.open_url === "string" && d.task.open_url.startsWith("https://") && <a className="btn primary small" href={d.task.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a>}
  </>}</Async></Drawer>;
  return <Drawer onClose={onClose}><Async s={s}>{(d) => <>
    <h2>{d.task.title}</h2>
    <dl className="kv"><dt>Business</dt><dd>{BUSINESS_NAMES[d.task.business_id]}</dd><dt>Owner</dt><dd>{d.task.owner ?? "Unassigned"}</dd><dt>Status</dt><dd>{d.task.status}</dd>
      <dt>Due</dt><dd>{d.task.due_date ?? "Not set"}{d.task.recurrence ? ` (repeats ${d.task.recurrence})` : ""}</dd><dt>Source</dt><dd>{d.task.source === "finding_approval" ? "Created from an approved listing finding" : "Dashboard"}</dd></dl>
    {d.task.description && <p>{d.task.description}</p>}
    <h3 style={{ marginTop: 12 }}>Links</h3>
    {d.links.length ? <ul className="list">{d.links.map((l: any) => <li key={l.id}>{l.target_type}: {l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.label ?? l.url}</a> : (l.label ?? l.target_id)}</li>)}</ul> : <p className="sub">None.</p>}
    <h3 style={{ marginTop: 12 }}>Files</h3>
    {d.files.map((f: any) => <div key={f.id}><a href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a> <span className="sub">{Math.round(f.size_bytes / 1024)} KB</span></div>)}
    {role !== "viewer" && <Upload ownerType="task" ownerId={id} onDone={s.reload} />}
    {role !== "viewer" && <div className="row" style={{ marginTop: 12 }}><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add an update" style={{ flex: 1 }} />
      <button className="btn small" disabled={!comment} onClick={async () => { await api(`/tasks/${id}`, { method: "PATCH", json: { comment, version: d.task.version } }); setComment(""); s.reload(); }}>Add</button></div>}
    <h3 style={{ marginTop: 12 }}>Update history</h3>
    <ul className="list">{d.history.map((h: any, i: number) => <li key={i}><span className="sub">{when(h.at)} · {h.actor}</span>{h.comment && <div>{h.comment}</div>}
      <div className="mono">{Object.entries(h.changes).map(([k, v]: any) => `${k}: ${v.from ?? "none"} to ${v.to}`).join("; ")}</div></li>)}</ul>
  </>}</Async></Drawer>;
}

export function Upload({ ownerType, ownerId, onDone }: { ownerType: string; ownerId: string; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  return <form className="row" style={{ marginTop: 6 }} onSubmit={async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("owner_type", ownerType); fd.set("owner_id", ownerId);
    try { await api("/attachments", { method: "POST", body: fd }); setMsg("Uploaded."); (e.target as HTMLFormElement).reset(); onDone(); } catch (x: any) { setMsg(x.message); } }}>
    <input type="file" name="file" required accept=".png,.jpg,.jpeg,.webp,.pdf,.xlsx,.csv,.zip" /><button className="btn small">Upload</button><span className="sub">{msg || "Private. PNG, JPEG, WebP, PDF, XLSX, CSV or ZIP, up to 15 MB."}</span></form>;
}
