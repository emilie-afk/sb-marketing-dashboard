// Slack Review: the planning owner's private queue of task suggestions from Slack. The server returns 404 to anyone
// else; this page only shows what it is given. Slack excerpts and links stay here; only the approved fields are sent.
// Every action (status, occasion, Add to task, Add to plan) happens in place: the queue, its filters and its scroll
// position stay as they are, and the changed row updates where it is.
import { useMemo, useState } from "react";
import { api, useApi, Async, BUSINESS_NAMES, Drawer, when, useHashQuery } from "../lib";
import { StatusMenu, OccasionPicker, fmtDate, type MenuAction } from "./ReviewParts";

const STATUS: Record<string, string> = { pending: "To review", planned: "In a plan", approved: "Approved", resolved: "Resolved", dismissed: "Dismissed" };
const DELIVERY: Record<string, string> = { not_sent: "Not sent", sending: "Sending…", created: "Sent", failed: "Needs retry", unknown: "No answer: retry to settle" };
const TASK: Record<string, string> = { open: "Open", done: "Done", deleted: "Deleted in Task Tracker" };
const changed = () => window.dispatchEvent(new Event("slack-review-changed"));

export function SlackReview({ id }: { id?: string }) {
  if (id) return <SuggestionDetail key={id} id={id} />;
  return <Queue />;
}

function Queue() {
  const [q, setQ] = useHashQuery();
  const status = q.get("status") ?? "pending", search = q.get("q") ?? "", occ = q.get("occasion") ?? "all";
  const s = useApi<any>(`/review/suggestions?status=${status}${occ !== "all" ? `&occasion=${occ}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`, [status, search, occ]);
  // Rows changed in place since the list was read (kept where they are until the filters change).
  const [patched, setPatched] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string } | null>(null);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<any | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [taskFor, setTaskFor] = useState<any | null>(null);
  const [planFor, setPlanFor] = useState<any | null>(null);
  const [bulkPlan, setBulkPlan] = useState<any[] | null>(null);
  const patch = (it: any, text?: string) => { setPatched((p) => ({ ...p, [it.id]: it })); if (text) setMsg({ id: it.id, text }); changed(); };
  const patchMany = (list: any[]) => { setPatched((p) => { const n = { ...p }; for (const it of list) if (it) n[it.id] = it; return n; }); changed(); };
  const act = async (it: any, fn: () => Promise<any>, text?: string) => {
    setBusy(it.id); setMsg(null);
    try { const r = await fn(); if (r?.suggestion) patch(r.suggestion, text); }
    catch (e: any) {
      // Refused (e.g. a task already exists in Task Tracker): show the row as it is now, with the reason.
      if (e.status === 409) { try { patch((await api<any>(`/review/suggestions/${it.id}`)).suggestion); } catch { /* keep the old row */ } }
      setMsg({ id: it.id, text: e.message });
    } finally { setBusy(null); }
  };
  const setFilter = (next: Record<string, string | null>) => { setPatched({}); setMsg(null); setBulkMsg(null); setSel(new Set()); setQ(next); };
  const classify = async (it: any, body: any) => {
    setBusy(it.id); setPickErr(null);
    try { const r = await api<any>(`/review/suggestions/${it.id}/classify`, { method: "POST", json: { version: it.version, ...body } }); patch(r.suggestion); setPicker(null); }
    catch (e: any) { if (picker) setPickErr(e.message); else setMsg({ id: it.id, text: e.message }); } finally { setBusy(null); }
  };
  const rows: any[] = (s.data?.items ?? []).map((raw: any) => patched[raw.id] ?? raw);
  const chosen = rows.filter((it) => sel.has(it.id));
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const DONE: Record<string, string> = { resolve: "resolved", dismiss: "dismissed", reopen: "back in To review" };
  const bulk = async (action: "resolve" | "dismiss" | "reopen") => {
    if (action === "dismiss" && !confirm(`Dismiss ${chosen.length} suggestion(s)? They won't come back in later scans.`)) return;
    setBusy("bulk"); setBulkMsg(null); setMsg(null);
    try {
      const r = await api<any>("/review/suggestions/bulk-status", { method: "POST", json: { action, items: chosen.map((it) => ({ id: it.id, version: it.version })) } });
      patchMany(r.results.map((x: any) => x.suggestion));
      const ok = r.results.filter((x: any) => x.ok), bad = r.results.filter((x: any) => !x.ok);
      setBulkMsg(`${ok.length} ${DONE[action]}.${bad.length ? ` ${bad.length} not changed: ${bad[0].message}` : ""}`);
      setSel(new Set(bad.map((x: any) => x.id)));
    } catch (e: any) { setBulkMsg(e.message); } finally { setBusy(null); }
  };
  return <div>
    <div className="toolbar">
      <b>Slack Review</b>
      <label>Show <select value={status} onChange={(e) => setFilter({ status: e.target.value === "pending" ? null : e.target.value })}>
        <option value="pending">To review</option><option value="planned">In a plan</option><option value="approved">Approved</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option><option value="all">All</option></select></label>
      <label>Occasion <select value={occ} onChange={(e) => setFilter({ occasion: e.target.value === "all" ? null : e.target.value })}>
        <option value="all">All</option><option value="unclassified">Unclassified</option><option value="classified">Linked to an occasion</option></select></label>
      <input type="search" placeholder="Search suggestions" defaultValue={search} aria-label="Search suggestions" onKeyDown={(e) => { if (e.key === "Enter") setFilter({ q: (e.target as HTMLInputElement).value || null }); }} />
    </div>
    <p className="sub">Private to you. Use the status button on a row, or tick several rows and set their status together, without leaving the queue. Add to plan keeps the item in the Marketing Dashboard; it goes to Task Tracker only if you choose to send it. Slack text and links stay here. An occasion you confirm puts the suggestion on your Next two quarters timeline.</p>
    {sel.size > 0 && <div className="toolbar bulk-bar" aria-label="Bulk actions">
      <b>{chosen.length} selected</b>
      <span className="sub">Set status:</span>
      <button className="btn small" disabled={busy === "bulk"} onClick={() => bulk("resolve")} title="Handled; no task">Resolve</button>
      <button className="btn small" disabled={busy === "bulk"} onClick={() => bulk("dismiss")} title="No action needed; won't come back">Dismiss</button>
      <button className="btn small" disabled={busy === "bulk"} onClick={() => bulk("reopen")} title="Dismissed or resolved items return to To review">Back to review</button>
      <button className="btn small primary" disabled={busy === "bulk"} onClick={() => { setBulkMsg(null); setBulkPlan(chosen); }}>Add to plan…</button>
      <button className="btn small" disabled={busy === "bulk"} onClick={() => setSel(new Set())}>Clear selection</button>
      {busy === "bulk" && <span className="sub">Working…</span>}
    </div>}
    {bulkMsg && <div className="notice" role="status">{bulkMsg}</div>}
    <Async s={s}>{(d) => !d.items.length ? <div className="state">{status === "pending" ? "Nothing to review." : "No suggestions here."}</div> :
      <div className="table-wrap"><table className="review-table"><thead><tr>
        <th className="pick"><input type="checkbox" aria-label="Select all rows" checked={rows.length > 0 && rows.every((it) => sel.has(it.id))}
          ref={(el) => { if (el) el.indeterminate = sel.size > 0 && !rows.every((it) => sel.has(it.id)); }}
          onChange={(e) => setSel(e.target.checked ? new Set(rows.map((it) => it.id)) : new Set())} /></th>
        <th>Suggested task</th><th>Posted</th><th>Occasion</th><th>Business</th><th>Assignee</th><th>Deadline</th><th>Review</th><th>Task Tracker</th></tr></thead>
        <tbody>{d.items.map((raw: any) => { const it = patched[raw.id] ?? raw;
          return <tr key={it.id} className={[patched[it.id] && it.status !== raw.status ? "changed" : "", sel.has(it.id) ? "selected" : ""].join(" ").trim() || undefined}>
            <td className="pick"><input type="checkbox" aria-label={`Select ${it.fields.title}`} checked={sel.has(it.id)} onChange={() => toggle(it.id)} /></td>
            <td><a href={`#/planning/review/${it.id}`}><b>{it.fields.title}</b></a>{it.needs.length > 0 && it.status === "pending" && <div className="sub">{it.needs.length} decision{it.needs.length === 1 ? "" : "s"} to make</div>}
              {msg?.id === it.id && <div className="sub" role="status">{msg?.text}</div>}</td>
            <td>{when(it.source.posted_at)}{it.source.is_reply && <div className="sub">Thread reply</div>}</td>
            <td><OccasionCell it={it} busy={busy === it.id} onPick={() => { setPickErr(null); setPicker(it); }} onConfirm={(o) => classify(it, { occasion: o })} /></td>
            <td>{it.fields.business ?? <span className="sub">Not set</span>}</td>
            <td>{it.fields.assignee?.name ?? <span className="sub">Not set</span>}</td>
            <td>{it.fields.due_date ? fmtDate(it.fields.due_date) : it.source.deadline_text ? <span className="sub">“{it.source.deadline_text}”</span> : <span className="sub">Not set</span>}</td>
            <td><ReviewStatus it={it} busy={busy === it.id} actions={[
              { label: "Resolve", hint: "Handled; no task", onClick: () => act(it, () => api(`/review/suggestions/${it.id}/resolve`, { method: "POST", json: { version: it.version } }), "Resolved.") },
              { label: "Dismiss", hint: "No action needed; won't come back", onClick: () => { if (confirm("Dismiss this suggestion? It won't come back in later scans.")) act(it, () => api(`/review/suggestions/${it.id}/dismiss`, { method: "POST", json: { version: it.version } }), "Dismissed."); } },
              { label: "Add to task", hint: "Confirm the fields, send to Task Tracker", onClick: () => setTaskFor(it) },
              { label: "Add to plan", hint: "Into a draft plan; stays in the dashboard", onClick: () => setPlanFor(it) },
            ]} onReopen={() => act(it, () => api(`/review/suggestions/${it.id}/reopen`, { method: "POST", json: { version: it.version } }), "Back in To review.")} /></td>
            <td><DeliveryCell it={it} busy={busy === it.id} onRetry={() => act(it, () => api(`/review/suggestions/${it.id}/create`, { method: "POST", json: { version: it.version } }), "Checked with Task Tracker.")}
              onResolve={() => act(it, () => api(`/review/suggestions/${it.id}/resolve`, { method: "POST", json: { version: it.version } }), "Resolved.")} /></td>
          </tr>; })}</tbody></table></div>}</Async>
    {picker && <OccasionPicker title={picker.fields.title} business={picker.fields.business_id ?? picker.suggested.business} current={picker.occasion.current} prepDate={picker.occasion.prep_date}
      busy={busy === picker.id} error={pickErr} onClose={() => setPicker(null)}
      onPick={(o, prep) => classify(picker, { occasion: o, prep_date: prep })} onClear={(prep) => classify(picker, { occasion: null, prep_date: prep })} />}
    {taskFor && <AddTaskDrawer it={taskFor} onClose={() => setTaskFor(null)} onDone={(it, text) => { setTaskFor(null); patch(it, text); }} />}
    {planFor && <AddToPlanDrawer it={planFor} onClose={() => setPlanFor(null)} onDone={(it, text) => { setPlanFor(null); patch(it, text); }} />}
    {bulkPlan && <BulkPlanDrawer items={bulkPlan} onClose={() => setBulkPlan(null)} onDone={(r) => {
      setBulkPlan(null); patchMany(r.items);
      const bad = r.results.filter((x: any) => !x.ok);
      setBulkMsg(`${r.results.length - bad.length} added to the plan (kept in the dashboard).${bad.length ? ` ${bad.length} not added: ${bad[0].message}` : ""}`);
      setSel(new Set(bad.map((x: any) => x.id)));
    }} />}
  </div>;
}

/** The review status: an action button while the suggestion is to review, a plain label otherwise. */
function ReviewStatus({ it, busy, actions, onReopen }: { it: any; busy: boolean; actions: MenuAction[]; onReopen: () => void }) {
  if (it.status === "pending") return <StatusMenu label="To review" actions={actions} busy={busy} />;
  // A dismissed or resolved suggestion (never a task) can go back to review.
  if ((it.status === "dismissed" || it.status === "resolved") && ["not_sent", "failed"].includes(it.delivery.status))
    return <StatusMenu label={STATUS[it.status]} tone="muted" busy={busy} actions={[{ label: "Back to review", hint: "Return it to To review", onClick: onReopen }]} />;
  return <span className={`chip ${it.status === "dismissed" || it.status === "resolved" ? "muted" : ""}`}>{STATUS[it.status]}</span>;
}

/** Task Tracker state on the row: Sending / Sent (with the link) / Needs retry. */
function DeliveryCell({ it, busy, onRetry, onResolve }: { it: any; busy: boolean; onRetry: () => void; onResolve: () => void }) {
  if (it.status === "planned") return <span className="sub">{it.plan?.name ? <>Plan: <a href={`#/planning/${it.plan.id}`}>{it.plan.name}</a></> : "Removed from its plan"}</span>;
  if (it.status !== "approved") return <span className="sub">—</span>;
  const d = it.delivery.status;
  return <>
    <span className={`chip ${["failed", "unknown"].includes(d) ? "bad" : d === "sending" ? "warn" : ""}`}>{DELIVERY[d]}</span>
    {it.task?.open_url && <div><a href={it.task.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a></div>}
    {["failed", "unknown", "sending"].includes(d) && <div className="row" style={{ gap: 4 }}><button className="btn small" disabled={busy} onClick={onRetry}>Retry</button>
      <button className="btn small" disabled={busy} onClick={onResolve} title="Handled without a task (Task Tracker is checked first)">Resolve</button></div>}
    {it.delivery.error && ["failed", "unknown"].includes(d) && <div className="sub bad">{it.delivery.error}</div>}
  </>;
}

/** Occasion on the row: the confirmed link, the matcher's suggestion (Confirm), possible matches, or Set occasion. */
function OccasionCell({ it, busy, onPick, onConfirm }: { it: any; busy: boolean; onPick: () => void; onConfirm: (o: { id: string; year: number }) => void }) {
  const o = it.occasion;
  const name = (c: any) => `${c.name} ${c.year}`;
  if (o.confirmed && o.current) return <div><button type="button" className="linkish" disabled={busy} onClick={onPick} title="Change or clear"><b>{name(o.current)}</b></button>
    <div className="sub">{o.current.dates?.text}{o.prep_date ? ` · prep ${fmtDate(o.prep_date)}` : ""}</div></div>;
  if (o.status === "suggested" && o.current) return <div><span className="sub">Suggested:</span> <button type="button" className="linkish" disabled={busy} onClick={() => onConfirm(o.current)} title="Confirm this occasion">{name(o.current)}</button>
    <div className="row" style={{ gap: 4, marginTop: 2 }}><button type="button" className="btn small" disabled={busy} onClick={() => onConfirm(o.current)}>Confirm</button><button type="button" className="btn small" disabled={busy} onClick={onPick}>Change</button></div></div>;
  if (o.status === "ambiguous" && o.candidates.length) return <div><span className="sub">Possible:</span> {o.candidates.map((c: any, i: number) => <span key={`${c.id}:${c.year}`}>{i ? " · " : ""}
    <button type="button" className="linkish" disabled={busy} title={c.dates?.text ?? ""} onClick={() => onConfirm({ id: c.id, year: c.year })}>{name(c)}</button></span>)}
    <div><button type="button" className="btn small" disabled={busy} onClick={onPick}>Set occasion</button></div></div>;
  return <div>{o.status === "cleared" && <div className="sub">None (cleared)</div>}<button type="button" className="btn small" disabled={busy} onClick={onPick}>Set occasion</button></div>;
}

/** Add to task: confirm title, brief, business, brand, assignee and due date, then send. One task per suggestion, however often it is clicked or retried. */
function AddTaskDrawer({ it, onClose, onDone }: { it: any; onClose: () => void; onDone: (it: any, text: string) => void }) {
  const dir = useApi<any>("/planning/directory");
  const f0 = it.fields;
  const [f, setF] = useState({ title: f0.title, brief: f0.brief ?? "", business_id: f0.business_id ?? it.suggested.business ?? "", tracker_brand_id: f0.brand?.id ?? "", tracker_assignee_id: f0.assignee?.id ?? "", due_date: f0.due_date ?? "" });
  const [phase, setPhase] = useState<"edit" | "saving" | "sending">("edit");
  const [err, setErr] = useState<string | null>(null);
  const brands = useMemo(() => (dir.data?.brands ?? []).filter((b: any) => b.business_id === f.business_id), [dir.data, f.business_id]);
  const brandId = f.tracker_brand_id || (brands.length === 1 ? brands[0].id : "");
  const ready = f.title.trim() && f.business_id && brandId && f.tracker_assignee_id && f.due_date;
  const send = async () => {
    setErr(null);
    try {
      let cur = it;
      const want = { title: f.title.trim(), brief: f.brief || null, business_id: f.business_id, tracker_brand_id: brandId, tracker_assignee_id: f.tracker_assignee_id, due_date: f.due_date };
      const same = cur.fields.title === want.title && (cur.fields.brief ?? null) === want.brief && cur.fields.business_id === want.business_id && cur.fields.brand?.id === want.tracker_brand_id
        && cur.fields.assignee?.id === want.tracker_assignee_id && cur.fields.due_date === want.due_date;
      if (!same && !cur.locked) { setPhase("saving"); cur = (await api<any>(`/review/suggestions/${it.id}`, { method: "PATCH", json: { version: cur.version, ...want } })).suggestion; }
      setPhase("sending");
      const r = await api<any>(`/review/suggestions/${it.id}/create`, { method: "POST", json: { version: cur.version } });
      onDone(r.suggestion, r.outcome === "created" ? (r.existing ? "Linked the existing Task Tracker task." : "Sent to Task Tracker.") : r.message ?? "Needs a retry.");
    } catch (e: any) { setErr(e.message); setPhase("edit"); }
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <Drawer onClose={onClose}>
    <h2>Add to task</h2>
    <p className="sub">Creates one task in Task Tracker, shown in Marketing Tasks under the assignee. Only these fields are sent: nothing from Slack. Sending again (or a double click) never makes a second task.</p>
    {err && <div className="notice" role="alert">{err}</div>}
    {dir.error && <div className="notice">Task Tracker's people list could not be read: {dir.error.message}</div>}
    <form className="stack-form" onSubmit={(e) => { e.preventDefault(); if (ready && phase === "edit") send(); }} style={{ display: "grid", gap: 8 }}>
      <label>Title<input aria-label="Title" required maxLength={300} value={f.title} onChange={set("title")} /></label>
      <label>Brief (sent with the task)<textarea aria-label="Brief" rows={3} maxLength={1500} value={f.brief} onChange={set("brief")} /></label>
      <label>Business<select aria-label="Business" value={f.business_id} onChange={(e) => setF({ ...f, business_id: e.target.value, tracker_brand_id: "", tracker_assignee_id: "" })}>
        <option value="">Choose</option>{Object.entries(BUSINESS_NAMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      {brands.length > 1 && <label>Task Tracker brand<select aria-label="Task Tracker brand" value={f.tracker_brand_id} onChange={(e) => setF({ ...f, tracker_brand_id: e.target.value, tracker_assignee_id: "" })}>
        <option value="">Choose</option>{brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      <label>Assignee<select aria-label="Assignee" value={f.tracker_assignee_id} onChange={(e) => setF({ ...f, tracker_brand_id: brandId, tracker_assignee_id: e.target.value })}>
        <option value="">Choose</option>{(dir.data?.people ?? []).filter((p: any) => brandId && p.brand_ids.includes(brandId)).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Due date<input aria-label="Due date" type="date" required value={f.due_date} onChange={set("due_date")} />{!f.due_date && it.source.deadline_text && <span className="sub">Slack said “{it.source.deadline_text}”</span>}</label>
      <div className="row"><button className="btn primary" disabled={!ready || phase !== "edit"}>{phase === "saving" ? "Saving…" : phase === "sending" ? "Sending…" : "Send to Task Tracker"}</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  </Drawer>;
}

const addDaysStr = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
type NewPlan = { name: string; prep_start: string; campaign_start: string; campaign_end: string };
/** A new draft plan's defaults: for a linked occasion, the plan form's defaults (campaign two weeks before it, prep seven weeks before). */
function newPlanFor(occ: any | null): NewPlan {
  const d = occ?.dates;
  if (occ && d?.start) return { name: `${occ.name} ${occ.year}`, prep_start: addDaysStr(d.start, -49), campaign_start: addDaysStr(d.start, -14), campaign_end: d.end };
  return { name: occ ? `${occ.name} ${occ.year}` : "", prep_start: "", campaign_start: "", campaign_end: "" };
}

/** Choose a draft plan of the business, or make a new draft plan here. */
function PlanTarget({ plans, business, occasion, value, onChange, np, setNp }: { plans: any[]; business: string; occasion: any | null; value: string; onChange: (v: string) => void; np: NewPlan; setNp: (n: NewPlan) => void }) {
  const mine = plans.filter((p) => p.business_id === business);
  const chosen = mine.find((p) => p.id === value);
  const set = (k: keyof NewPlan) => (e: any) => setNp({ ...np, [k]: e.target.value });
  return <>
    <label>Plan<select aria-label="Plan" required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a draft plan</option>
      {mine.some((p) => p.match === "same") && <optgroup label={`For ${occasion.name} ${occasion.year}`}>{mine.filter((p) => p.match === "same").map((p) => <PlanOption key={p.id} p={p} />)}</optgroup>}
      {mine.some((p) => p.match !== "same") && <optgroup label="Draft plans">{mine.filter((p) => p.match !== "same").map((p) => <PlanOption key={p.id} p={p} />)}</optgroup>}
      <option value="new">＋ New draft plan…</option></select></label>
    {chosen?.match === "different" && <div className="notice">This plan is for {chosen.occasion.name} {chosen.occasion.year}, but the suggestion is linked to {occasion.name} {occasion.year}. Add it anyway only if that is intended.</div>}
    {value === "new" && <div className="card flat" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
      <label style={{ gridColumn: "1 / -1" }}>New plan name<input aria-label="New plan name" required maxLength={200} value={np.name} onChange={set("name")} /></label>
      <label>Prep start<input aria-label="Prep start" type="date" required value={np.prep_start} max={np.campaign_start || undefined} onChange={set("prep_start")} /></label>
      <label>Campaign start<input aria-label="Campaign start" type="date" required value={np.campaign_start} onChange={set("campaign_start")} /></label>
      <label>Campaign end<input aria-label="Campaign end" type="date" required value={np.campaign_end} min={np.campaign_start || undefined} onChange={set("campaign_end")} /></label>
      <span className="sub" style={{ gridColumn: "1 / -1" }}>A private draft{occasion ? `, linked to ${occasion.name} ${occasion.year}` : ""}. Fill in the rest of the plan later.</span>
    </div>}
  </>;
}
const planBody = (business: string, value: string, np: NewPlan, occasion: any | null) =>
  value === "new" ? { business_id: business, new_plan: { ...np, occasion: occasion ? { id: occasion.id, year: occasion.year } : null } } : { business_id: business, plan_id: value };
const npReady = (np: NewPlan) => np.name.trim() && np.prep_start && np.campaign_start && np.campaign_end && np.prep_start <= np.campaign_start && np.campaign_start <= np.campaign_end;

/**
 * Add to plan: every detail is filled in here (title, brief, business, plan, assignee, due date). The item stays in the
 * Marketing Dashboard; "Send to Task Tracker" is optional and then needs brand, assignee and due date.
 */
function AddToPlanDrawer({ it, onClose, onDone }: { it: any; onClose: () => void; onDone: (it: any, text: string) => void }) {
  const choices = useApi<any>(`/review/suggestions/${it.id}/plans`, [it.id]);
  const dir = useApi<any>("/planning/directory");
  const f0 = it.fields;
  const occasion = it.occasion.confirmed && it.occasion.current ? it.occasion.current : null;
  const [f, setF] = useState({ title: f0.title, brief: f0.brief ?? "", business_id: f0.business_id ?? it.suggested.business ?? "", tracker_brand_id: f0.brand?.id ?? "", tracker_assignee_id: f0.assignee?.id ?? "", due_date: f0.due_date ?? "", send: false });
  const [plan, setPlan] = useState("");
  const [np, setNp] = useState<NewPlan>(() => newPlanFor(occasion));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const brands = useMemo(() => (dir.data?.brands ?? []).filter((b: any) => b.business_id === f.business_id), [dir.data, f.business_id]);
  const brandId = f.tracker_brand_id || (brands.length === 1 ? brands[0].id : "");
  // Without sending, anyone working on the business can be noted; to send, the person must work in the chosen brand.
  const people = (dir.data?.people ?? []).filter((p: any) => f.send ? brandId && p.brand_ids.includes(brandId) : p.brand_ids.some((id: string) => brands.some((b: any) => b.id === id)));
  const sendReady = !f.send || (brandId && f.tracker_assignee_id && f.due_date);
  const ready = f.title.trim() && f.business_id && plan && (plan !== "new" || npReady(np)) && sendReady;
  const add = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>(`/review/suggestions/${it.id}/add-to-plan`, { method: "POST", json: {
        version: it.version, ...planBody(f.business_id, plan, np, occasion), title: f.title.trim(), brief: f.brief || null, send_to_tracker: f.send,
        tracker_brand_id: f.send ? brandId : f.tracker_brand_id || null, tracker_assignee_id: f.tracker_assignee_id || null, due_date: f.due_date || null } });
      onDone(r.suggestion, f.send ? "Added to the plan. It is sent to Task Tracker when you publish the plan." : "Added to the plan. It stays in the Marketing Dashboard.");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <Drawer onClose={onClose}>
    <h2>Add to plan</h2>
    <p className="sub">Becomes an item in a draft plan, kept in the Marketing Dashboard. Nothing is sent to Task Tracker unless you tick “Send to Task Tracker”. The Slack text and links stay here.</p>
    {err && <div className="notice" role="alert">{err}</div>}
    <form className="stack-form" style={{ display: "grid", gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (ready && !busy) add(); }}>
      <label>Title<input aria-label="Title" required maxLength={300} value={f.title} onChange={set("title")} /></label>
      <label>Brief<textarea aria-label="Brief" rows={3} maxLength={1500} value={f.brief} onChange={set("brief")} /></label>
      <label>Business<select aria-label="Business" required value={f.business_id} onChange={(e) => { setF({ ...f, business_id: e.target.value, tracker_brand_id: "", tracker_assignee_id: "" }); setPlan(""); }}>
        <option value="">Choose</option>{Object.entries(BUSINESS_NAMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <div className="sub">Occasion: {occasion ? `${occasion.name} ${occasion.year}` : "not linked"}</div>
      {f.business_id && <Async s={choices}>{(d) => <PlanTarget plans={d.plans} business={f.business_id} occasion={d.occasion} value={plan} onChange={setPlan} np={np} setNp={setNp} />}</Async>}
      <label>Assignee {!f.send && <span className="sub">(optional)</span>}<select aria-label="Assignee" value={f.tracker_assignee_id} disabled={!f.business_id || !!dir.error} onChange={set("tracker_assignee_id")}>
        <option value="">{f.send ? "Choose" : "Not set"}</option>{people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {dir.error && <span className="sub">Task Tracker's people list could not be read, so no assignee can be chosen now.</span>}
      <label>Due date {!f.send && <span className="sub">(optional)</span>}<input aria-label="Due date" type="date" value={f.due_date} onChange={set("due_date")} />
        {!f.due_date && it.source.deadline_text && <span className="sub">Slack said “{it.source.deadline_text}”</span>}</label>
      <label className="check" style={{ display: "flex" }}><input type="checkbox" aria-label="Send to Task Tracker" checked={f.send} disabled={!!dir.error}
        onChange={(e) => setF({ ...f, send: e.target.checked, tracker_assignee_id: e.target.checked && brandId && !(dir.data?.people ?? []).some((p: any) => p.id === f.tracker_assignee_id && p.brand_ids.includes(brandId)) ? "" : f.tracker_assignee_id })} />
        Send to Task Tracker when the plan is published</label>
      {f.send && brands.length > 1 && <label>Task Tracker brand<select aria-label="Task Tracker brand" value={f.tracker_brand_id} onChange={(e) => setF({ ...f, tracker_brand_id: e.target.value, tracker_assignee_id: "" })}>
        <option value="">Choose</option>{brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      {f.send && !sendReady && <span className="sub">To send it, choose {[!brandId && "the brand", !f.tracker_assignee_id && "the assignee", !f.due_date && "the due date"].filter(Boolean).join(", ")}.</span>}
      <div className="row" style={{ marginTop: 6 }}><button className="btn primary" disabled={busy || !ready}>{busy ? "Adding…" : "Add to plan"}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  </Drawer>;
}

/** Bulk Add to plan: the selected suggestions go into one draft plan as items kept in the dashboard, each with its own fields. */
function BulkPlanDrawer({ items, onClose, onDone }: { items: any[]; onClose: () => void; onDone: (r: any) => void }) {
  const choices = useApi<any>("/review/plan-choices");
  const businesses = [...new Set(items.map((it) => it.fields.business_id ?? it.suggested.business).filter(Boolean))];
  const occs = [...new Set(items.filter((it) => it.occasion.confirmed && it.occasion.current).map((it) => `${it.occasion.current.id}:${it.occasion.current.year}`))];
  const occasion = occs.length === 1 && items.every((it) => it.occasion.confirmed) ? items[0].occasion.current : null;
  const [business, setBusiness] = useState<string>(businesses.length === 1 ? businesses[0] : "");
  const [plan, setPlan] = useState("");
  const [np, setNp] = useState<NewPlan>(() => newPlanFor(occasion));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const notOpen = items.filter((it) => it.status !== "pending");
  const ready = business && plan && (plan !== "new" || npReady(np));
  const add = async () => {
    setBusy(true); setErr(null);
    try { onDone(await api<any>("/review/suggestions/bulk-add-to-plan", { method: "POST", json: { items: items.map((it) => ({ id: it.id, version: it.version })), ...planBody(business, plan, np, occasion) } })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <Drawer onClose={onClose}>
    <h2>Add {items.length} to a plan</h2>
    <p className="sub">Each suggestion becomes an item with its own title, brief, assignee and due date, kept in the Marketing Dashboard. To send any of them to Task Tracker, tick “Send to Task Tracker” on the item in the plan.</p>
    {notOpen.length > 0 && <div className="notice">{notOpen.length} selected suggestion(s) are not “To review” and will be skipped.</div>}
    {err && <div className="notice" role="alert">{err}</div>}
    <form className="stack-form" style={{ display: "grid", gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (ready && !busy) add(); }}>
      <label>Business<select aria-label="Business" required value={business} onChange={(e) => { setBusiness(e.target.value); setPlan(""); }}>
        <option value="">Choose</option>{Object.entries(BUSINESS_NAMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      {businesses.length > 1 && <span className="sub">The selection covers several businesses; assignees are kept only for suggestions of the business you choose.</span>}
      {business && <Async s={choices}>{(d) => <PlanTarget plans={d.plans} business={business} occasion={occasion} value={plan} onChange={setPlan} np={np} setNp={setNp} />}</Async>}
      <ul className="list">{items.map((it) => <li key={it.id}>{it.fields.title}{it.fields.due_date ? <span className="sub"> · due {fmtDate(it.fields.due_date)}</span> : null}</li>)}</ul>
      <div className="row"><button className="btn primary" disabled={busy || !ready}>{busy ? "Adding…" : "Add to plan"}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  </Drawer>;
}
const PlanOption = ({ p }: { p: any }) => <option value={p.id}>{p.name} ({fmtDate(p.campaign_start)} – {fmtDate(p.campaign_end)}){p.occasion ? ` · ${p.occasion.name} ${p.occasion.year}` : p.categories.length ? ` · ${p.categories.join(", ")}` : ""}</option>;

function SuggestionDetail({ id }: { id: string }) {
  const s = useApi<any>(`/review/suggestions/${id}`, [id]);
  const dir = useApi<any>("/planning/directory");
  const [edit, setEdit] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [planPick, setPlanPick] = useState(false);
  const [picker, setPicker] = useState(false);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (s.error?.status === 404) return <div className="state">Page not found.</div>;
  return <Async s={s}>{(d) => {
    const it = d.suggestion, f = it.fields;
    const run = async (fn: () => Promise<any>, done?: string) => { setBusy(true); setMsg(null); try { await fn(); if (done) setMsg(done); s.reload(); changed(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
    const classify = async (body: any) => { setBusy(true); setPickErr(null); try { await api(`/review/suggestions/${id}/classify`, { method: "POST", json: { version: it.version, ...body } }); setPicker(false); s.reload(); changed(); } catch (e: any) { setPickErr(e.message); setMsg(e.message); } finally { setBusy(false); } };
    const brands = (dir.data?.brands ?? []).filter((b: any) => !edit?.business_id || b.business_id === edit.business_id);
    const people = (dir.data?.people ?? []).filter((p: any) => edit?.tracker_brand_id && p.brand_ids.includes(edit.tracker_brand_id));
    const open = it.status === "pending" || (it.status === "approved" && it.delivery.status === "failed");
    return <div>
      <p><a href="#/planning/review">← Slack Review</a></p>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div><h2 style={{ margin: 0 }}>{f.title}</h2><div className="sub">Posted {when(it.source.posted_at)}{it.source.is_reply ? " · thread reply" : ""}</div></div>
          <div className="row">
            <span className={`chip ${it.status === "pending" ? "warn" : it.status === "dismissed" || it.status === "resolved" ? "muted" : ""}`} title="Review status">{STATUS[it.status]}</span>
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
        {it.needs.length > 0 && !["dismissed", "resolved"].includes(it.status) && <div className="notice">Decisions to make: {it.needs.join("; ")}.</div>}

        <h3>Occasion</h3>
        <OccasionCell it={it} busy={busy} onPick={() => { setPickErr(null); setPicker(true); }} onConfirm={(o) => classify({ occasion: o })} />
        <p className="sub">Prep date: {it.occasion.prep_date ? fmtDate(it.occasion.prep_date) : "not set"} (shown on your timeline when there is no task deadline).</p>

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

        {it.plan && <div className="notice">{it.plan.item
          ? <>In the {it.plan.status === "published" ? "published" : "draft"} plan <a href={`#/planning/${it.plan.id}`}><b>{it.plan.name}</b></a>{it.plan.status === "published"
              ? <>{it.plan.item.send ? <> — sent with the plan{it.plan.item.delivery === "created" ? " (task created)" : ""}.</> : <> — kept in the Marketing Dashboard (not sent to Task Tracker).</>}</>
              : <> — private to you{it.plan.item.send ? ", sent to Task Tracker when you publish the plan" : ", kept in the Marketing Dashboard"}. Change it in the plan.</>}</>
          : <>Removed from its plan. You can bring it back to the review list.</>}</div>}
        {it.task && <p>Task Tracker: <span className="chip">{TASK[it.task.status] ?? it.task.status}</span> {it.task.as_of && <span className="sub">as of {when(it.task.as_of)}</span>} {it.task.open_url && <a href={it.task.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a>}</p>}
        {it.delivery.error && it.status === "approved" && <div className="notice">{it.delivery.error}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          {!it.locked && !["dismissed", "resolved"].includes(it.status) && !edit && <button className="btn small" onClick={() => setEdit({ title: f.title, brief: f.brief ?? "", business_id: f.business_id ?? it.suggested.business ?? "", tracker_brand_id: f.brand?.id ?? "", tracker_assignee_id: f.assignee?.id ?? "", due_date: f.due_date ?? "" })}>Review and edit</button>}
          {it.status === "pending" && !edit && <button className="btn small" disabled={busy} onClick={() => setPlanPick(true)}>Add to plan</button>}
          {it.status === "planned" && !it.plan?.item && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/review/suggestions/${id}/return`, { method: "POST", json: { version: it.version } }), "Back in the review list.")}>Return to review</button>}
          {!["dismissed", "planned", "resolved"].includes(it.status) && it.delivery.status !== "created" && <button className="btn small primary" disabled={busy} onClick={() => run(async () => setPreview(await api(`/review/suggestions/${id}/preview`, { method: "POST" })))}>
            {["failed", "unknown", "sending"].includes(it.delivery.status) ? "Retry creating the task" : "Create task"}</button>}
          {open && !it.locked && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/review/suggestions/${id}/resolve`, { method: "POST", json: { version: it.version } }), "Resolved: handled, no task.")}>Resolve</button>}
          {["dismissed", "resolved"].includes(it.status) && ["not_sent", "failed"].includes(it.delivery.status) && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/review/suggestions/${id}/reopen`, { method: "POST", json: { version: it.version } }), "Back in To review.")}>Back to review</button>}
          {!it.locked && !["dismissed"].includes(it.status) && <button className="btn small" disabled={busy} onClick={() => { if (confirm("Dismiss this suggestion? It won't come back in later scans.")) run(() => api(`/review/suggestions/${id}/dismiss`, { method: "POST", json: { version: it.version } }), "Dismissed."); }}>Dismiss</button>}
          {(it.delivery.status === "created" || it.delivery.status === "unknown") && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/review/suggestions/${id}/refresh`, { method: "POST" }), "Checked Task Tracker.")}>Check Task Tracker</button>}
        </div>
        {msg && <div className="notice">{msg}</div>}
      </div>
      {picker && <OccasionPicker title={f.title} business={f.business_id ?? it.suggested.business} current={it.occasion.current} prepDate={it.occasion.prep_date} busy={busy} error={pickErr}
        onClose={() => setPicker(false)} onPick={(o, prep) => classify({ occasion: o, prep_date: prep })} onClear={(prep) => classify({ occasion: null, prep_date: prep })} />}
      {planPick && <AddToPlanDrawer it={it} onClose={() => setPlanPick(false)} onDone={(_x, text) => { setPlanPick(false); setMsg(text); s.reload(); changed(); }} />}
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
