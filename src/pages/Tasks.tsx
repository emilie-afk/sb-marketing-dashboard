import { useState, useEffect, useRef } from "react";
import { useApi, Async, BUSINESS_NAMES, api, Drawer, when, useHashQuery } from "../lib";

const STATUSES: [string, string][] = [["todo", "To do"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["done", "Done"]];

const VIEWS: [string, string][] = [["needs_attention", "Needs attention"], ["this_week", "This week"], ["upcoming", "Upcoming"], ["completed", "Completed"], ["all", "All tasks"]];
const STATUS_LABEL: Record<string, string> = { todo: "To do", in_progress: "In progress", waiting: "Waiting", done: "Done", cancelled: "Cancelled" };
const UNASSIGNED = "__unassigned__";
const FILTER_KEYS = ["q", "business", "assignee", "status", "activity", "source", "kind", "from", "to"];
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** "Today", "Tomorrow", "3 days overdue", "In 5 days", always next to the actual date. */
/** URL parameters that open one row: a dashboard occurrence is named by its date, so each occurrence has its own link. */
export function taskLinkParams(t: { id: string; source: string; occurrence: string | null }) {
  return { task: t.id, occ: t.source === "dashboard" && t.occurrence ? t.occurrence : null };
}
export function deadlineLabel(due: string | null, today: string, status: string) {
  if (!due) return { text: "No due date", tone: "" };
  const diff = dayNum(due) - dayNum(today), open = status !== "done" && status !== "cancelled";
  const rel = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? (open ? "1 day overdue" : "Yesterday") : diff < 0 ? (open ? `${-diff} days overdue` : `${-diff} days ago`) : `In ${diff} days`;
  return { text: `${rel} · ${shortDate(due)}`, tone: open && diff < 0 ? "bad" : open && diff === 0 ? "warn" : "" };
}

export function TasksPage({ role }: { role: string }) {
  const [q, setQ] = useHashQuery();
  const view = VIEWS.some(([k]) => k === q.get("view")) ? q.get("view")! : "needs_attention";
  const layout = q.get("layout") === "board" ? "board" : "list";
  const openId = q.get("task");
  const openOcc = q.get("occ");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(q.get("q") ?? "");
  useEffect(() => { setSearch(q.get("q") ?? ""); }, [q.get("q")]);
  useEffect(() => { const t = setTimeout(() => { if ((q.get("q") ?? "") !== search) setQ({ q: search || null }); }, 300); return () => clearTimeout(t); }, [search]);
  const apiQuery = new URLSearchParams({ view });
  for (const k of FILTER_KEYS) { const v = q.get(k); if (v) apiQuery.set(k, v); }
  const s = useApi<any>(`/tasks?${apiQuery}`, [apiQuery.toString()]);
  const setStatus = async (t: any, status: string) => {
    if (t.read_only) return;
    try {
      if (t.occurrence) await api(`/tasks/${t.id}/occurrences/${t.occurrence}`, { method: "PATCH", json: { status } });
      else await api(`/tasks/${t.id}`, { method: "PATCH", json: { status, version: t.version } });
      s.reload();
    } catch (e: any) { alert(e.message); }
  };
  const pushedOpen = useRef(false);
  // The link names the occurrence too, so two occurrences of one routine open (and bookmark) separately.
  const openTask = (t: any) => { pushedOpen.current = true; setQ(taskLinkParams(t), { push: true }); };
  const statuses = (q.get("status") ?? "").split(",").filter(Boolean);
  const chips: [string, string][] = [];
  if (q.get("q")) chips.push(["q", `Search: “${q.get("q")}”`]);
  if (q.get("business")) chips.push(["business", BUSINESS_NAMES[q.get("business")!] ?? q.get("business")!]);
  if (q.get("assignee")) chips.push(["assignee", q.get("assignee") === UNASSIGNED ? "Unassigned" : q.get("assignee")!]);
  if (statuses.length) chips.push(["status", `Status: ${statuses.map((x) => STATUS_LABEL[x] ?? x).join(", ")}`]);
  if (q.get("activity")) chips.push(["activity", `Activity: ${q.get("activity")}`]);
  if (q.get("source")) chips.push(["source", q.get("source") === "tracker" ? "Task Tracker only" : "Dashboard only"]);
  if (q.get("kind")) chips.push(["kind", q.get("kind") === "recurring" ? "Recurring" : "One-off"]);
  if (q.get("from") || q.get("to")) chips.push(["from", `Due ${q.get("from") ?? "…"} to ${q.get("to") ?? "…"}`]);
  const clearAll = () => setQ(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])));
  const scopeText = [BUSINESS_NAMES[q.get("business") ?? ""], q.get("assignee") ? (q.get("assignee") === UNASSIGNED ? "Unassigned" : q.get("assignee")) : null, VIEWS.find(([k]) => k === view)![1]].filter(Boolean).join(" · ");
  const counts = s.data?.counts;
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Task views">
        {VIEWS.map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => setQ({ view: k, from: null, to: null }, { push: true })}>
          {l}{k === "needs_attention" && counts ? <span className={`chip ${counts.needs_attention ? "bad" : "muted"}`} style={{ marginLeft: 6 }}>{counts.needs_attention}</span> : null}
          {k === "this_week" && counts ? <span className="chip muted" style={{ marginLeft: 6 }}>{counts.this_week}</span> : null}</button>)}
        <span className="spacer" style={{ flex: 1 }} />
        <div role="group" aria-label="Layout" className="row">{[["list", "List"], ["board", "Board"]].map(([k, l]) => <button key={k} className={`btn small ${layout === k ? "primary" : ""}`} aria-pressed={layout === k} onClick={() => setQ({ layout: k === "list" ? null : k })}>{l}</button>)}</div>
      </div>
      <div className="toolbar">
        <label>Search tasks <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Task, activity or promotion" /></label>
        <label>Business <select value={q.get("business") ?? ""} onChange={(e) => setQ({ business: e.target.value || null })}><option value="">All</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <AssigneePicker value={q.get("assignee")} people={s.data?.assignees ?? []} onChange={(v) => setQ({ assignee: v })} />
        <span className="spacer" />{role !== "viewer" && <button className="btn primary small" onClick={() => setCreating(true)}>New task</button>}
        <details className="more-filters" open={["status", "activity", "source", "kind", "from", "to"].some((k) => q.get(k))}>
          <summary>More filters</summary>
          <div className="row" style={{ marginTop: 8, alignItems: "flex-start" }}>
            <fieldset><legend>Status</legend>{Object.entries(STATUS_LABEL).map(([k, l]) => <label key={k}><input type="checkbox" checked={statuses.includes(k)} onChange={(e) => setQ({ status: (e.target.checked ? [...statuses, k] : statuses.filter((x) => x !== k)).join(",") || null })} />{l}</label>)}</fieldset>
            <label>Activity <select value={q.get("activity") ?? ""} onChange={(e) => setQ({ activity: e.target.value || null })}><option value="">Any</option>{(s.data?.activities ?? []).map((a: string) => <option key={a}>{a}</option>)}</select></label>
            <label>Source <select value={q.get("source") ?? ""} onChange={(e) => setQ({ source: e.target.value || null })}><option value="">Both</option><option value="dashboard">Dashboard</option><option value="tracker">Task Tracker</option></select></label>
            <label>Recurring / one-off <select value={q.get("kind") ?? ""} onChange={(e) => setQ({ kind: e.target.value || null })}><option value="">Both</option><option value="recurring">Recurring</option><option value="oneoff">One-off</option></select></label>
            <label>Custom due dates <input type="date" aria-label="Due from" value={q.get("from") ?? ""} onChange={(e) => setQ({ from: e.target.value || null })} /> to <input type="date" aria-label="Due to" value={q.get("to") ?? ""} onChange={(e) => setQ({ to: e.target.value || null })} /></label>
          </div>
        </details>
      </div>
      {chips.length > 0 && <div className="row" style={{ marginBottom: 10 }} aria-label="Active filters">{chips.map(([k, l]) => <button key={k} className="chip" onClick={() => setQ(k === "from" ? { from: null, to: null } : { [k]: null })} aria-label={`Remove filter ${l}`}>{l} ×</button>)}
        <button className="btn small" onClick={clearAll}>Clear filters</button></div>}
      <Async s={s}>{(d) => {
        const tr = d.tracker;
        const freshness = tr && tr.status !== "not_configured" ? <span className={tr.status === "failing" ? "bad" : ""}> Task Tracker copy {tr.last_success_at ? `updated ${when(tr.last_success_at)}` : "not read yet"}{tr.status === "failing" ? "; the latest read failed, showing the last good copy" : ""}.</span> : null;
        const windowText = view === "needs_attention" ? `Overdue or due today (${shortDate(d.today)})` : view === "this_week" ? `Due ${shortDate(d.window.week.from)} – ${shortDate(d.window.week.to)}` :
          view === "completed" ? `Completed ${shortDate(d.window.from)} – ${shortDate(d.window.to)}` : `Due ${shortDate(d.window.from)} – ${shortDate(d.window.to)}${view === "all" ? ", plus tasks with no due date" : ""}`;
        return <>
          <p className="sub" role="status"><b>{d.total} task{d.total === 1 ? "" : "s"}</b> · {scopeText} · {windowText}. Deadlines use Vietnam time.{freshness}{d.trackerHistoryNote ? ` ${d.trackerHistoryNote}` : ""}
            {view === "upcoming" && <> <button className="btn small" onClick={() => setQ({ to: addDaysStr(d.window.to, 28) })}>Look 4 more weeks ahead</button></>}
            {view === "completed" && <> <button className="btn small" onClick={() => setQ({ from: addDaysStr(d.window.from, -30) })}>Show 30 more days</button></>}</p>
          {d.items.length === 0 ? <div className="state">{view === "needs_attention" ? "Nothing is overdue or due today" : view === "completed" ? "No completed tasks" : "No tasks"} for {scopeText.split(" · ").slice(0, -1).join(" · ") || "everyone"} in this view.{chips.length ? " Try clearing filters or another view." : view === "needs_attention" ? " See This week for what's coming up." : ""}</div>
            : layout === "list" ? <TaskList items={d.items} view={view} today={d.today} role={role} onOpen={openTask} onStatus={setStatus} />
            : <TaskBoard items={d.items} today={d.today} role={role} onOpen={openTask} onStatus={setStatus} />}
        </>; }}</Async>
      {openId && <TaskDrawer key={`${openId}|${openOcc ?? ""}`} id={openId} occurrence={openOcc} role={role} onClose={() => { if (pushedOpen.current) { pushedOpen.current = false; history.back(); } else setQ({ task: null, occ: null }); s.reload(); }} />}
      {creating && <NewTask onClose={() => { setCreating(false); s.reload(); }} />}
    </div>
  );
}

const addDaysStr = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function AssigneePicker({ value, people, onChange }: { value: string | null; people: any[]; onChange: (v: string | null) => void }) {
  const [text, setText] = useState(value === UNASSIGNED ? "Unassigned" : value ?? "");
  useEffect(() => { setText(value === UNASSIGNED ? "Unassigned" : value ?? ""); }, [value]);
  const names = people.map((p) => (p.name === UNASSIGNED ? "Unassigned" : p.name));
  const commit = (t: string) => { const v = t.trim(); if (!v) return onChange(null); if (v === "Unassigned") return onChange(UNASSIGNED); onChange(v); };
  return <label>Assignee <input list="assignee-options" value={text} placeholder="Anyone" onChange={(e) => { setText(e.target.value); if (names.includes(e.target.value) || !e.target.value) commit(e.target.value); }} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)} />
    <datalist id="assignee-options">{people.map((p) => <option key={p.name} value={p.name === UNASSIGNED ? "Unassigned" : p.name}>{`${p.count} task${p.count === 1 ? "" : "s"}${p.archived ? " · no longer on the team" : ""}`}</option>)}<option value="Unassigned" /></datalist></label>;
}

function StatusCell({ t, role, onStatus }: { t: any; role: string; onStatus: (t: any, s: string) => void }) {
  if (role === "viewer" || t.read_only) return <span className={`chip ${t.status === "done" ? "" : "muted"}`}>{STATUS_LABEL[t.status] ?? t.status}</span>;
  return <select aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => onStatus(t, e.target.value)}>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
}

function TaskRowView({ t, view, today, role, onOpen, onStatus, extra }: any) {
  const dl = deadlineLabel(t.due_date, today, t.status);
  return <tr>
    <td><a href="#" onClick={(e) => { e.preventDefault(); onOpen(t); }}><b>{t.title}</b></a>{t.read_only && <span className="chip muted" style={{ marginLeft: 6 }}>Task Tracker</span>}{t.recurring && <span className="chip muted" style={{ marginLeft: 6 }}>Recurring</span>}{t.file_count > 0 && <span className="sub"> · {t.file_count} file(s)</span>}
      {t.read_only && t.open_url && <> · <a href={t.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a></>}{extra}</td>
    <td>{BUSINESS_NAMES[t.business_id]}</td><td>{t.activity}</td><td>{t.owner ?? "Unassigned"}{t.owner_archived ? <span className="sub"> (no longer on the team)</span> : null}</td>
    <td onClick={(e) => e.stopPropagation()}><StatusCell t={t} role={role} onStatus={onStatus} /></td>
    <td className={dl.tone}>{view === "completed" ? (t.completed_basis === "completion" ? `Completed ${shortDate(t.completed_on)}` : `Due ${shortDate(t.completed_on)} (completion time not recorded)`) : dl.text}</td>
    <td>{t.promotion_title ?? ""}</td></tr>;
}

function TaskList({ items, view, today, role, onOpen, onStatus }: any) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const head = <thead><tr><th>Task</th><th>Business</th><th>Activity</th><th>Assignee</th><th>Status</th><th>{view === "completed" ? "Completed" : "Deadline"}</th><th>Related promotion</th></tr></thead>;
  const rows = (list: any[]) => list.map((t: any) => <TaskRowView key={t.key} t={t} view={view} today={today} role={role} onOpen={onOpen} onStatus={onStatus} />);
  if (view !== "needs_attention") return <div className="table-wrap"><table>{head}<tbody>{rows(items)}</tbody></table></div>;
  const overdue = items.filter((t: any) => t.due_date < today), dueToday = items.filter((t: any) => t.due_date === today);
  // Several older overdue occurrences of one routine collapse behind a count; each stays openable with its own assignee, status and date.
  const groups = new Map<string, any[]>();
  for (const t of overdue) { const k = t.series_key ?? t.key; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const overdueRows = [...groups.entries()].sort((a, b) => a[1][0].due_date.localeCompare(b[1][0].due_date)).flatMap(([k, list]) => {
    if (list.length < 2) return rows(list);
    const latest = list[list.length - 1], older = list.slice(0, -1), open = expanded.has(k);
    return [<TaskRowView key={latest.key} t={latest} view={view} today={today} role={role} onOpen={onOpen} onStatus={onStatus}
      extra={<div><button className="btn small" aria-expanded={open} onClick={() => setExpanded((s) => { const n = new Set(s); open ? n.delete(k) : n.add(k); return n; })}>{open ? "Hide" : "Show"} {older.length} older overdue occurrence{older.length === 1 ? "" : "s"}</button></div>} />,
      ...(open ? rows(older) : [])];
  });
  return <>
    {overdue.length > 0 && <><h3>Overdue <span className="chip bad">{overdue.length}</span></h3><div className="table-wrap"><table>{head}<tbody>{overdueRows}</tbody></table></div></>}
    {dueToday.length > 0 && <><h3 style={{ marginTop: 14 }}>Today <span className="chip warn">{dueToday.length}</span></h3><div className="table-wrap"><table>{head}<tbody>{rows(dueToday)}</tbody></table></div></>}
  </>;
}

function TaskBoard({ items, today, role, onOpen, onStatus }: any) {
  const cols = ["todo", "in_progress", ...(items.some((t: any) => t.status === "waiting") ? ["waiting"] : []), "done", ...(items.some((t: any) => t.status === "cancelled") ? ["cancelled"] : [])];
  return <div className="board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))` }}>{cols.map((k) => { const list = items.filter((t: any) => t.status === k);
    return <div key={k} className="col"><h4>{STATUS_LABEL[k]} <span className="chip muted">{list.length}</span></h4>
      {list.map((t: any) => { const dl = deadlineLabel(t.due_date, today, t.status);
        return <div key={t.key} className="tcard"><a href="#" onClick={(e) => { e.preventDefault(); onOpen(t); }}><b>{t.title}</b></a>
          <div className="sub">{BUSINESS_NAMES[t.business_id]} · {t.owner ?? "Unassigned"}{t.read_only ? " · Task Tracker" : ""}{t.recurring ? " · Recurring" : ""}</div>
          <div className={`sub ${dl.tone}`}>{dl.text}</div>
          {t.read_only && t.open_url && <a className="sub" href={t.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a>}
          {role !== "viewer" && !t.read_only && <div className="row" style={{ marginTop: 4 }}>{["todo", "in_progress", "done"].filter((x) => x !== k).map((x) => <button key={x} className="btn small" onClick={() => onStatus(t, x)}>{STATUS_LABEL[x]}</button>)}</div>}
        </div>; })}</div>; })}</div>;
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

function TaskDrawer({ id, occurrence, role, onClose }: { id: string; occurrence?: string | null; role: string; onClose: () => void }) {
  const s = useApi<any>(`/tasks/${encodeURIComponent(id)}${occurrence && !id.startsWith("tracker:") ? `?occurrence=${occurrence}` : ""}`, [id, occurrence]);
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
    {d.occurrence ? <>
      <p className="sub">One occurrence of a repeating task. Status changes here apply to this occurrence only; links, files and updates below belong to the whole routine.</p>
      <dl className="kv"><dt>Business</dt><dd>{BUSINESS_NAMES[d.task.business_id]}</dd>
        <dt>Assignee</dt><dd>{d.occurrence.owner ?? "Unassigned"}{d.occurrence.owner_is_series_owner ? <span className="sub"> (the routine's owner)</span> : <span className="sub"> (this occurrence; the routine's owner is {d.task.owner ?? "unassigned"})</span>}</dd>
        <dt>Status</dt><dd>{role !== "viewer" ? <select aria-label="Occurrence status" value={d.occurrence.status} onChange={async (e) => { await api(`/tasks/${id}/occurrences/${d.occurrence.due_date}`, { method: "PATCH", json: { status: e.target.value } }); s.reload(); }}>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select> : (STATUS_LABEL[d.occurrence.status] ?? d.occurrence.status)}</dd>
        <dt>Due</dt><dd>{shortDate(d.occurrence.due_date)}</dd>{d.occurrence.completed_at && <><dt>Completed</dt><dd>{when(d.occurrence.completed_at)}</dd></>}</dl>
    </> :
    <dl className="kv"><dt>Business</dt><dd>{BUSINESS_NAMES[d.task.business_id]}</dd><dt>Assignee</dt><dd>{d.task.owner ?? "Unassigned"}</dd><dt>Status</dt><dd>{STATUS_LABEL[d.task.status] ?? d.task.status}</dd>
      <dt>Due</dt><dd>{d.task.due_date ?? "Not set"}{d.task.recurrence ? ` (repeats ${d.task.recurrence})` : ""}</dd><dt>Source</dt><dd>{d.task.source === "finding_approval" ? "Created from an approved listing finding" : "Dashboard"}</dd></dl>}
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
