// Marketing Planning. The planning owner creates, edits and publishes plans and sends their assignments to Task
// Tracker; everyone else sees published plans in the rolling three-month window (the server decides, this page
// only shows what it is given).
import { useEffect, useMemo, useState } from "react";
import { api, useApi, Async, range, BUSINESS_NAMES, useHashQuery, when, Drawer, Tabs } from "../lib";
import { SlackReview } from "./SlackReview";
import { CorporateTasks } from "./CorporateTasks";

const STATUS_LABEL: Record<string, string> = { draft: "Draft", published: "Published" };
const DELIVERY_LABEL: Record<string, string> = { not_sent: "Not sent yet", sending: "Sending…", created: "Created in Task Tracker", failed: "Needs retry", unknown: "No answer: retry to settle" };
const TASK_LABEL: Record<string, string> = { open: "Open", done: "Done", deleted: "Deleted in Task Tracker" };
const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");

export function PlanningPage({ id, sub }: { id?: string; sub?: string }) {
  const meta = useApi<any>("/planning/meta");
  if (!meta.data) return <Async s={meta}>{() => null}</Async>;
  const tabs = <PlanningTabs owner={meta.data.owner} active={id === "review" ? "review" : id === "corporate" ? "corporate" : "plans"} />;
  if (id === "corporate") return <>{tabs}{meta.data.owner ? <CorporateTasks /> : <div className="state">Page not found.</div>}</>;
  if (id === "review") return <>{tabs}{meta.data.owner ? <SlackReview id={sub} /> : <div className="state">Page not found.</div>}</>;
  if (id === "new") return <>{tabs}<PlanEditor meta={meta.data} /></>;
  if (id) return <>{tabs}<PlanDetail id={id} meta={meta.data} /></>;
  return <>{tabs}<PlanList meta={meta.data} /></>;
}

/** Plans | Slack Review · N | Corporate Gifts · N. The review tabs and counts exist only for the planning owner (the server hides them from everyone else). */
function PlanningTabs({ owner, active }: { owner: boolean; active: "plans" | "review" | "corporate" }) {
  const count = useApi<any>(owner ? "/review/summary" : null);
  // Slack Review actions announce a change so the count stays right without a page reload.
  useEffect(() => { const f = () => count.reload(); window.addEventListener("slack-review-changed", f); return () => window.removeEventListener("slack-review-changed", f); }, [count.reload]);
  const cg = useApi<any>(owner ? "/review/corporate/summary" : null);
  useEffect(() => { const f = () => cg.reload(); window.addEventListener("corporate-tasks-changed", f); return () => window.removeEventListener("corporate-tasks-changed", f); }, [cg.reload]);
  if (!owner) return null;
  return <Tabs tabs={[["plans", "Plans"], ["review", `Slack Review${count.data ? ` · ${count.data.pending}` : ""}`], ["corporate", `Corporate Gifts${cg.data ? ` · ${cg.data.pending}` : ""}`]]} value={active}
    onChange={(v) => { location.hash = v === "review" ? "#/planning/review" : v === "corporate" ? "#/planning/corporate" : "#/planning"; }} />;
}

// ====================================================================== list and timeline
function PlanList({ meta }: { meta: any }) {
  const [q, setQ] = useHashQuery();
  const year = q.get("year") ?? "", business = q.get("business") ?? "", channel = q.get("channel") ?? "", status = q.get("status") ?? "";
  const qs = new URLSearchParams(Object.entries({ year, business, channel, status }).filter(([, v]) => v) as [string, string][]).toString();
  const s = useApi<any>(`/planning/plans${qs ? `?${qs}` : ""}`, [qs]);
  const thisYear = Number(meta.today.slice(0, 4));
  return <div>
    <div className="toolbar">
      <b>Marketing Planning</b>
      <label>Year <select value={year} onChange={(e) => setQ({ year: e.target.value || null })}><option value="">All</option>{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
      <label>Brand <select value={business} onChange={(e) => setQ({ business: e.target.value || null })}><option value="">All</option>{Object.entries(BUSINESS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Channel <select value={channel} onChange={(e) => setQ({ channel: e.target.value || null })}><option value="">All</option>{meta.channels.map((c: string) => <option key={c}>{c}</option>)}</select></label>
      {meta.owner && <label>Status <select value={status} onChange={(e) => setQ({ status: e.target.value || null })}><option value="">All</option><option value="draft">Draft</option><option value="published">Published</option></select></label>}
      {meta.owner && <a className="btn small primary" href="#/planning/new">New plan</a>}
    </div>
    <p className="sub">{meta.owner ? "Full planning timeline, including drafts and ended plans." : `View only: published plans whose preparation starts between ${fmtDate(meta.window.from)} and ${fmtDate(meta.window.to)}, and plans in progress.`}
      {" "}Task Tracker owns assigned tasks: complete and edit them there.</p>
    {meta.owner && !meta.configured && <div className="notice">PLANNING_OWNER_EMAIL is not set on the server.</div>}
    {meta.owner && meta.tracker_connected === false && <div className="notice">Task Tracker is not connected for planning yet (TASK_TRACKER_PLANNING_SECRET). Plans can be drafted; tasks can't be sent.</div>}
    <Async s={s}>{(d) => {
      if (!d.items.length) return <div className="state">{meta.owner ? "No plans match these filters. Start one from an occasion in Marketing Calendar, or with New plan." : "No published plans in the current three-month window."}</div>;
      const months = new Map<string, any[]>();
      for (const p of d.items) { const m = p.prep_start.slice(0, 7); months.set(m, [...(months.get(m) ?? []), p]); }
      return [...months.entries()].map(([m, list]) => <section key={m}>
        <h3 className="agenda-month">Prep starts {new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</h3>
        <div className="table-wrap"><table><thead><tr><th>Plan</th><th>Brand</th><th>Occasion</th><th>Prep start</th><th>Campaign</th><th>Channels</th><th>Status</th><th>Tasks</th></tr></thead>
          <tbody>{list.map((p) => <tr key={p.id} className="clickable" onClick={() => { location.hash = `#/planning/${p.id}`; }}>
            <td><a href={`#/planning/${p.id}`}><b>{p.name}</b></a></td><td>{p.business}</td><td>{occasionText(p.occasion)}</td><td>{fmtDate(p.prep_start)}</td>
            <td>{range({ start: p.campaign_start, end: p.campaign_end })}</td><td>{p.channels.join(", ")}</td>
            <td><span className={`chip ${p.status === "draft" ? "muted" : ""}`}>{STATUS_LABEL[p.status]}</span></td>
            <td>{p.task_count}{meta.owner && p.pending_count ? <span className="sub"> · {p.pending_count} not sent</span> : null}</td></tr>)}</tbody></table></div>
      </section>);
    }}</Async>
  </div>;
}
const occasionText = (o: any) => (!o ? "" : o.kind === "gift" ? `${o.name}${o.year ? ` ${o.year}` : ""}` : `${o.name} (${fmtDate(o.date)})`);

// ====================================================================== detail
function PlanDetail({ id, meta }: { id: string; meta: any }) {
  const s = useApi<any>(`/planning/plans/${id}`, [id]);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [impact, setImpact] = useState<any[] | null>(null);
  if (s.error?.status === 404) return <div className="state">This plan isn't available to you. Plans are visible to the team once published, from three months before their preparation starts until the campaign ends.</div>;
  return <Async s={s}>{(d) => {
    const p = d.plan, owner = d.owner;
    if (editing) return <PlanEditor meta={meta} plan={p} onDone={(r) => { setEditing(false); if (r?.deadline_impact?.length) setImpact(r.deadline_impact); s.reload(); }} />;
    const created = p.assignments.filter((a: any) => a.task).length;
    const pending = owner ? p.assignments.filter((a: any) => a.delivery?.status !== "created") : [];
    const failed = pending.filter((a: any) => a.delivery?.status === "failed" || a.delivery?.status === "unknown" || a.delivery?.status === "sending").length;
    const openPreview = async () => { setMsg(null); setBusy(true); try { setPreview(await api(`/planning/plans/${p.id}/preview`, { method: "POST" })); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
    const refresh = async () => { setBusy(true); setMsg(null); try { await api(`/planning/plans/${p.id}/refresh`, { method: "POST" }); s.reload(); setMsg("Read the current tasks from Task Tracker."); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
    return <div>
      <p><a href="#/planning">← Planning</a></p>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div><h2 style={{ margin: 0 }}>{p.name}</h2>
            <div className="sub">{p.business}{p.occasion ? ` · ${occasionText(p.occasion)}` : ""}{p.promotion ? ` · Promotion: ${p.promotion.title}` : ""}</div></div>
          <div className="row">
            <span className={`chip ${p.status === "draft" ? "muted" : ""}`} title="Publication status">{STATUS_LABEL[p.status]}</span>
            {owner && <span className={`chip ${failed ? "bad" : pending.length ? "warn" : ""}`} title="Task delivery status">Tasks: {created} created{pending.length ? `, ${failed ? `${failed} need retry` : `${pending.length} not sent`}` : ""}</span>}
          </div>
        </div>
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Prep starts</dt><dd>{fmtDate(p.prep_start)}</dd>
          <dt>Campaign</dt><dd>{range({ start: p.campaign_start, end: p.campaign_end })}</dd>
          {p.channels.length > 0 && <><dt>Channels</dt><dd>{p.channels.join(", ")}</dd></>}
          {p.target_audience && <><dt>Target audience</dt><dd>{p.target_audience}</dd></>}
          {p.message_angle && <><dt>Message angle</dt><dd>{p.message_angle}</dd></>}
          {p.objective && <><dt>Objective</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.objective}</dd></>}
          {p.deliverables && <><dt>Deliverables</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.deliverables}</dd></>}
          {p.notes && <><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.notes}</dd></>}
          {p.published_at && <><dt>Published</dt><dd>{when(p.published_at)}</dd></>}
        </dl>
        {owner && <div className="row" style={{ marginTop: 12 }}>
          <button className="btn small" onClick={() => setEditing(true)}>Edit plan</button>
          {(p.status === "draft" || pending.length > 0) && <button className="btn small primary" disabled={busy || (p.status === "published" && !pending.length)} onClick={openPreview}>
            {p.status === "draft" ? (pending.length ? "Publish & send tasks" : "Publish") : failed ? "Retry remaining tasks" : "Send remaining tasks"}</button>}
          {(created > 0 || failed > 0) && <button className="btn small" disabled={busy} onClick={refresh} title="Read the current state of this plan's tasks from Task Tracker">Check Task Tracker</button>}
          {p.status === "draft" && created === 0 && <button className="btn small" onClick={async () => { if (!confirm("Delete this draft plan?")) return; try { await api(`/planning/plans/${p.id}`, { method: "DELETE" }); location.hash = "#/planning"; } catch (e: any) { setMsg(e.message); } }}>Delete draft</button>}
        </div>}
        {msg && <div className="notice">{msg}</div>}
      </div>
      {impact && <DeadlineImpact planId={p.id} items={impact} onDone={() => { setImpact(null); s.reload(); }} />}
      <h3 style={{ marginTop: 16 }}>Assignments</h3>
      {p.assignments.length === 0 ? <p className="sub">No assignments{owner ? " yet. Add them with Edit plan." : "."}</p> :
        <div className="table-wrap"><table><thead><tr><th>Task</th><th>Assignee</th><th>Due</th>{owner && <th>Delivery</th>}<th>Task Tracker status</th><th></th></tr></thead>
          <tbody>{p.assignments.map((a: any) => <AssignmentRow key={a.id} a={a} owner={owner} planId={p.id} onChanged={s.reload} />)}</tbody></table></div>}
      <p className="sub">Status comes from Task Tracker (its sync runs hourly; a task created moments ago shows its creation status until then).</p>
      {preview && <PreviewDrawer preview={preview} onClose={() => setPreview(null)} onSend={async () => {
        setBusy(true);
        try {
          const r = await api<any>(`/planning/plans/${p.id}/publish`, { method: "POST", json: { version: p.version } });
          const bad = r.results.filter((x: any) => x.outcome !== "created");
          setMsg(bad.length ? `Published. ${r.results.length - bad.length} task(s) created; ${bad.length} need a retry (see Delivery).` : r.results.length ? `Published. ${r.results.length} task(s) created in Task Tracker.` : "Published.");
          setPreview(null); s.reload();
        } catch (e: any) { setMsg(e.message); setPreview(null); } finally { setBusy(false); }
      }} busy={busy} />}
    </div>;
  }}</Async>;
}

function AssignmentRow({ a, owner, planId, onChanged }: { a: any; owner: boolean; planId: string; onChanged: () => void }) {
  const [due, setDue] = useState<string | null>(null);
  const [res, setRes] = useState<any | null>(null);
  const t = a.task;
  const save = async () => {
    try { const r = await api<any>(`/planning/plans/${planId}/assignments/${a.id}/deadline`, { method: "POST", json: { due_date: due } }); setRes(r); if (r.outcome === "updated") { setDue(null); onChanged(); } }
    catch (e: any) { setRes({ outcome: "error", message: e.message }); }
  };
  return <tr>
    <td><b>{t?.title ?? a.title}</b>{t && t.title !== a.title ? <div className="sub">Planned as: {a.title}</div> : null}</td>
    <td>{t?.assignee ?? a.assignee.name}<div className="sub">{a.brand.name}</div></td>
    <td>{fmtDate(t?.due_date ?? a.due_date)}{t && t.due_date !== a.due_date ? <div className="sub">Planned: {fmtDate(a.due_date)}</div> : null}
      {owner && t && t.status !== "deleted" && (due === null ? <div><a href="#" onClick={(e) => { e.preventDefault(); setRes(null); setDue(t.due_date ?? a.due_date); }}>Update deadline</a></div>
        : <div className="row"><input type="date" aria-label="New deadline" value={due} onChange={(e) => setDue(e.target.value)} /><button className="btn small" onClick={save}>Save in Task Tracker</button><button className="btn small" onClick={() => setDue(null)}>Cancel</button></div>)}
      {res?.outcome === "conflict" && <div className="notice">Changed in Task Tracker since it was last read: now "{res.current?.title}", due {fmtDate(res.current?.due_date)}, {TASK_LABEL[res.current?.status] ?? res.current?.status}. Use Check Task Tracker, then decide again.</div>}
      {res?.outcome === "missing" && <div className="notice">{res.message}</div>}
      {res?.outcome === "error" && <div className="notice">{res.message}</div>}
    </td>
    {owner && <td><span className={`chip ${a.delivery.status === "failed" || a.delivery.status === "unknown" ? "bad" : a.delivery.status === "created" ? "" : "muted"}`}>{DELIVERY_LABEL[a.delivery.status]}</span>{a.delivery.error && <div className="sub">{a.delivery.error}</div>}</td>}
    <td>{t ? <><span className={`chip ${t.status === "done" ? "" : "muted"}`}>{TASK_LABEL[t.status] ?? t.status}</span>{t.as_of && <div className="sub">as of {when(t.as_of)}</div>}</> : <span className="sub">Not in Task Tracker</span>}</td>
    <td>{t?.open_url && <a href={t.open_url} target="_blank" rel="noopener noreferrer">Open in Task Tracker</a>}</td>
  </tr>;
}

function DeadlineImpact({ planId, items, onDone }: { planId: string; items: any[]; onDone: () => void }) {
  const [state, setState] = useState<Record<string, string>>({});
  const update = async (it: any) => {
    try {
      const r = await api<any>(`/planning/plans/${planId}/assignments/${it.assignment_id}/deadline`, { method: "POST", json: { due_date: it.suggested_due_date } });
      setState({ ...state, [it.assignment_id]: r.outcome === "updated" ? `Updated to ${fmtDate(it.suggested_due_date)}.` : r.outcome === "conflict" ? `Not changed: the task was changed in Task Tracker (now due ${fmtDate(r.current?.due_date)}). Check Task Tracker and decide again.` : r.message ?? r.outcome });
    } catch (e: any) { setState({ ...state, [it.assignment_id]: e.message }); }
  };
  return <div className="card flat" style={{ marginTop: 12 }}>
    <h3>Campaign dates changed: assignment deadlines</h3>
    <p className="sub">Deadlines in Task Tracker stay as they are unless you update them here.</p>
    <ul className="list">{items.map((it) => <li key={it.assignment_id}><b>{it.title}</b>: due {fmtDate(it.current_due_date)}{it.outside_new_dates ? " (outside the new dates)" : ""}
      {it.suggested_due_date !== it.current_due_date && !state[it.assignment_id] && <> <button className="btn small" onClick={() => update(it)}>Update to {fmtDate(it.suggested_due_date)}</button></>}
      {state[it.assignment_id] && <div className="sub">{state[it.assignment_id]}</div>}</li>)}</ul>
    <button className="btn small" onClick={onDone}>Done</button>
  </div>;
}

function PreviewDrawer({ preview, onClose, onSend, busy }: { preview: any; onClose: () => void; onSend: () => void; busy: boolean }) {
  const problems = preview.items.filter((i: any) => i.problem).length;
  return <Drawer onClose={onClose}>
    <h2>{preview.plan.status === "draft" ? "Publish & send tasks" : "Send remaining tasks"}</h2>
    <p className="sub">{preview.plan.status === "draft" ? "Publishing makes the plan visible to the team (from three months before prep starts). " : ""}
      {preview.items.length ? `These ${preview.items.length} task(s) will be created in Task Tracker exactly as shown. Each is sent once; sending again never creates a duplicate.` : "No tasks to send."}</p>
    {!preview.tracker_connected && <div className="notice">Task Tracker is not connected for planning, so tasks will be marked as needing a retry.</div>}
    {preview.tracker_connected && !preview.directory_checked && <div className="notice">Task Tracker's people list could not be read; it will check each assignment itself.</div>}
    {preview.items.map((i: any) => <div key={i.assignment_id} className="card flat" style={{ marginBottom: 8 }}>
      <dl className="kv"><dt>Title</dt><dd><b>{i.title}</b></dd><dt>Brand</dt><dd>{i.brand}</dd><dt>Assignee</dt><dd>{i.assignee}</dd><dt>Due date</dt><dd>{fmtDate(i.due_date)}</dd>
        <dt>Brief</dt><dd style={{ whiteSpace: "pre-wrap" }}>{i.brief}</dd></dl>
      {i.problem && <div className="notice">{i.problem} This task will not be sent.</div>}
    </div>)}
    <div className="row"><button className="btn primary" disabled={busy} onClick={onSend}>{preview.plan.status === "draft" ? (preview.items.length ? "Publish & send tasks" : "Publish") : "Send tasks"}</button>
      <button className="btn" onClick={onClose}>Cancel</button></div>
    {problems > 0 && <p className="sub">{problems} assignment(s) have a problem: fix them with Edit plan, then send again.</p>}
  </Drawer>;
}

// ====================================================================== create and edit (owner)
type Asg = { id?: string; title: string; brief: string; tracker_brand_id: string; tracker_assignee_id: string; due_date: string; locked?: boolean; lockNote?: string; label?: string };

export function PlanEditor({ meta, plan, onDone }: { meta: any; plan?: any; onDone?: (r?: any) => void }) {
  const [q] = useHashQuery();
  const editing = !!plan;
  const gift = q.get("gift"), gyear = q.get("year") ? Number(q.get("year")) : null, sheet = q.get("sheet");
  const occ = useApi<any>(!editing && gift && gyear ? `/gift-occasions/${gift}?year=${gyear}` : null, [gift, gyear]);
  const dir = useApi<any>(meta.owner ? "/planning/directory" : null);
  const [v, setV] = useState<any>(() => plan ? {
    business_id: plan.business_id, name: plan.name, prep_start: plan.prep_start, campaign_start: plan.campaign_start, campaign_end: plan.campaign_end,
    objective: plan.objective ?? "", channels: plan.channels, target_audience: plan.target_audience ?? "", message_angle: plan.message_angle ?? "", deliverables: plan.deliverables ?? "", notes: plan.notes ?? "",
    gift_occasion_id: plan.occasion?.kind === "gift" ? plan.occasion.id : null, occurrence_year: plan.occasion?.kind === "gift" ? plan.occasion.year : null,
    sheet_occasion_id: plan.occasion?.kind === "sheet" ? plan.occasion.id : null, promotion_id: plan.promotion?.id ?? null,
  } : { business_id: q.get("business") || "sb", name: "", prep_start: "", campaign_start: "", campaign_end: "", objective: "", channels: [], target_audience: "", message_angle: "", deliverables: "", notes: "",
    gift_occasion_id: gift, occurrence_year: gyear, sheet_occasion_id: sheet, promotion_id: null });
  const [asg, setAsg] = useState<Asg[]>(() => (plan?.assignments ?? []).map((a: any) => ({ id: a.id, title: a.title, brief: a.brief ?? "", tracker_brand_id: a.brand.id, tracker_assignee_id: a.assignee.id, due_date: a.due_date,
    locked: ["created", "sending", "unknown"].includes(a.delivery.status), lockNote: a.delivery.status === "created" ? "In Task Tracker" : "Send not settled", label: `${a.brand.name} · ${a.assignee.name}` })));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Defaults from the occasion: name, and campaign dates leading into it.
  useEffect(() => {
    const o = occ.data;
    if (!o || editing || v.name) return;
    const brands: string[] = o.occasion.brands;
    setV((x: any) => ({ ...x, name: `${o.occasion.name} ${gyear}`, business_id: brands.includes(x.business_id) ? x.business_id : brands[0],
      campaign_end: o.dates?.end ?? "", campaign_start: o.dates ? addDaysStr(o.dates.start, -14) : "", prep_start: o.dates ? addDaysStr(o.dates.start, -49) : "" }));
  }, [occ.data]);
  const brands = useMemo(() => (dir.data?.brands ?? []).filter((b: any) => b.business_id === v.business_id), [dir.data, v.business_id]);
  const peopleFor = (brandId: string) => (dir.data?.people ?? []).filter((p: any) => p.brand_ids.includes(brandId));
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  const toggle = (c: string) => setV({ ...v, channels: v.channels.includes(c) ? v.channels.filter((x: string) => x !== c) : [...v.channels, c] });
  const submit = async (e: any) => {
    e.preventDefault(); setErr(null); setSaving(true);
    const body = { ...v, occurrence_year: v.gift_occasion_id ? v.occurrence_year : null, assignments: asg.map(({ locked, lockNote, label, ...a }) => ({ ...a, brief: a.brief || null })) };
    try {
      if (editing) { const r = await api<any>(`/planning/plans/${plan.id}`, { method: "PATCH", json: { ...body, version: plan.version } }); onDone?.(r); }
      else { const r = await api<any>("/planning/plans", { method: "POST", json: body }); location.hash = `#/planning/${r.plan.id}`; }
    } catch (x: any) { setErr(x.message); } finally { setSaving(false); }
  };
  if (!meta.owner) return <div className="state">Only the planning owner can create or edit plans.</div>;
  const label = (t: string, el: any, wide = false) => <label style={{ display: "grid", gap: 2, ...(wide ? { gridColumn: "1 / -1" } : {}) }}>{t}{el}</label>;
  return <form onSubmit={submit} className="card" aria-label={editing ? "Edit plan" : "New plan"}>
    <h2 style={{ marginTop: 0 }}>{editing ? `Edit ${plan.name}` : occ.data ? `Plan ${occ.data.occasion.name} ${gyear}` : "New plan"}</h2>
    {occ.data && <p className="sub">{occ.data.occasion.name}: {occ.data.datesText}{occ.data.occasion.leadIn ? ` · ${occ.data.occasion.leadIn}` : ""}</p>}
    {editing && plan.occasion && <p className="sub">Occasion: {occasionText(plan.occasion)}</p>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
      {label("Brand", <select aria-label="Brand" value={v.business_id} disabled={asg.some((a) => a.locked)} onChange={(e) => { setV({ ...v, business_id: e.target.value }); setAsg(asg.map((a) => a.locked ? a : { ...a, tracker_brand_id: "", tracker_assignee_id: "" })); }}>
        {Object.entries(BUSINESS_NAMES).filter(([k]) => !occ.data || occ.data.occasion.brands.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>)}
      {label("Plan name", <input aria-label="Plan name" required maxLength={200} value={v.name} onChange={set("name")} />)}
      {label("Prep start", <input aria-label="Prep start" type="date" required value={v.prep_start} onChange={set("prep_start")} />)}
      {label("Campaign start", <input aria-label="Campaign start" type="date" required value={v.campaign_start} onChange={set("campaign_start")} />)}
      {label("Campaign end", <input aria-label="Campaign end" type="date" required value={v.campaign_end} min={v.campaign_start || undefined} onChange={set("campaign_end")} />)}
      {label("Target audience", <input aria-label="Target audience" maxLength={500} value={v.target_audience} onChange={set("target_audience")} />)}
      {label("Message angle", <input aria-label="Message angle" maxLength={500} value={v.message_angle} onChange={set("message_angle")} />, true)}
      <fieldset style={{ gridColumn: "1 / -1", border: 0, padding: 0, margin: 0 }}><legend className="sub">Channels</legend>
        <div className="row">{meta.channels.map((c: string) => <button type="button" key={c} className={`chip ${v.channels.includes(c) ? "on" : ""}`} aria-pressed={v.channels.includes(c)} onClick={() => toggle(c)}>{c}</button>)}</div></fieldset>
      {label("Objective", <textarea aria-label="Objective" rows={2} maxLength={2000} value={v.objective} onChange={set("objective")} />, true)}
      {label("Deliverables", <textarea aria-label="Deliverables" rows={2} maxLength={2000} value={v.deliverables} onChange={set("deliverables")} />, true)}
      {label("Notes (not sent with tasks)", <textarea aria-label="Notes" rows={2} maxLength={4000} value={v.notes} onChange={set("notes")} />, true)}
    </div>
    <h3>Assignments</h3>
    <p className="sub">Saving keeps these in the plan only; tasks are created in Task Tracker when you publish. The brief, campaign dates, channels, audience and message angle go with each task.</p>
    {dir.error && <div className="notice">Task Tracker's people list could not be read: {dir.error.message}</div>}
    {asg.map((a, i) => <div key={a.id ?? `n${i}`} className="card flat" style={{ marginBottom: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
      {a.locked ? <><div style={{ gridColumn: "1 / -1" }}><b>{a.title}</b> <span className="chip">{a.lockNote}</span><div className="sub">{a.label} · due {fmtDate(a.due_date)} · {a.lockNote === "In Task Tracker" ? "change it in Task Tracker, or with Update deadline on the plan." : "use Retry or Check Task Tracker on the plan before changing it."}</div></div></> : <>
        {label("Task title", <input aria-label="Task title" required maxLength={300} value={a.title} onChange={(e) => setAsg(asg.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />, true)}
        {label("Task Tracker brand", <select aria-label="Task Tracker brand" required value={a.tracker_brand_id} onChange={(e) => setAsg(asg.map((x, j) => j === i ? { ...x, tracker_brand_id: e.target.value, tracker_assignee_id: "" } : x))}>
          <option value="">Choose</option>{brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>)}
        {label("Assignee", <select aria-label="Assignee" required value={a.tracker_assignee_id} onChange={(e) => setAsg(asg.map((x, j) => j === i ? { ...x, tracker_assignee_id: e.target.value } : x))}>
          <option value="">Choose</option>{peopleFor(a.tracker_brand_id).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>)}
        {label("Due date", <input aria-label="Due date" type="date" required value={a.due_date} onChange={(e) => setAsg(asg.map((x, j) => j === i ? { ...x, due_date: e.target.value } : x))} />)}
        {label("Brief for the assignee", <textarea aria-label="Brief" rows={2} maxLength={1500} value={a.brief} onChange={(e) => setAsg(asg.map((x, j) => j === i ? { ...x, brief: e.target.value } : x))} />, true)}
        <div><button type="button" className="btn small" onClick={() => setAsg(asg.filter((_, j) => j !== i))}>Remove</button></div></>}
    </div>)}
    <button type="button" className="btn small" onClick={() => setAsg([...asg, { title: "", brief: "", tracker_brand_id: brands.length === 1 ? brands[0].id : "", tracker_assignee_id: "", due_date: v.prep_start || "" }])}>Add assignment</button>
    {err && <div className="notice">{err}</div>}
    <div className="row" style={{ marginTop: 12 }}>
      <button className="btn primary" disabled={saving}>{editing ? "Save" : "Save draft"}</button>
      <button type="button" className="btn" onClick={() => (onDone ? onDone() : history.back())}>Cancel</button>
    </div>
  </form>;
}
const addDaysStr = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
