// Marketing Tasks views. Dashboard tasks (one-off and each recurring occurrence) and read-only Task Tracker records
// are put in one shape first, with each occurrence's own assignee and status, and only then filtered, so both
// sources follow the same filters and List and Board show the same results. Dates are Vietnam calendar dates.
import { query, one } from "./db";
import { occurrences } from "../shared/recurrence";
import { addDays, todayIn, OPERATIONS_TZ } from "../shared/dates";
import { openUrl } from "./adapters/taskTracker";

export const TASK_VIEWS = ["needs_attention", "this_week", "upcoming", "completed", "all"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];
export const UNASSIGNED = "__unassigned__";
/** How far back recurring occurrences are expanded for "Needs attention" (older overdue one-off tasks always show). */
export const OVERDUE_LOOKBACK_DAYS = 120;

export type TaskFilters = {
  view: TaskView; business: string | null; assignees: string[]; q: string | null; status: string[]; activity: string[];
  source: string[]; kind: "recurring" | "oneoff" | null; from: string | null; to: string | null;
};
export type TaskRow = {
  key: string; id: string; occurrence: string | null; series_key: string | null; title: string; business_id: string; activity: string | null;
  owner: string | null; owner_archived: boolean; status: string; due_date: string | null; completed_on: string | null; completed_basis: "completion" | "due_date" | null;
  source: "dashboard" | "tracker"; read_only: boolean; open_url: string | null; recurring: boolean; recurrence: string | null;
  promotion_id: string | null; promotion_title: string | null; version: number | null; file_count: number;
};

const vnDate = (ts: string | Date | null) => (ts ? todayIn(OPERATIONS_TZ, new Date(ts)) : null);
export const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const TRACKER_TYPE: Record<string, string> = { routine: "Routine", adhoc: "Ad hoc", video: "Video" };

/** The due-date window each view needs (custom dates narrow or move it). */
export function viewWindow(f: Pick<TaskFilters, "view" | "from" | "to">, today: string) {
  const mon = mondayOf(today), sun = addDays(mon, 6);
  const base = {
    needs_attention: { from: addDays(today, -OVERDUE_LOOKBACK_DAYS), to: today },
    this_week: { from: mon, to: sun },
    upcoming: { from: addDays(sun, 1), to: addDays(sun, 28) },
    completed: { from: addDays(today, -30), to: today },
    all: { from: addDays(today, -30), to: addDays(sun, 56) },
  }[f.view];
  return { from: f.from ?? base.from, to: f.to ?? base.to, custom: !!(f.from || f.to), week: { from: mon, to: sun } };
}

/** Every task row from both sources whose due date (or completion) can fall in [from, to]. */
export async function gatherTasks(business: string | null, from: string, to: string, today: string): Promise<TaskRow[]> {
  const tasks = await query<any>(
    `select t.*, to_char(t.due_date,'YYYY-MM-DD') due_date, to_char(t.recurrence_until,'YYYY-MM-DD') recurrence_until, p.title as promotion_title,
            (select count(*) from attachments a where a.owner_type = 'task' and a.owner_id = t.id::text)::int as file_count
       from tasks t left join promotions p on p.id = t.promotion_id where ($1::text is null or t.business_id = $1)`, [business]);
  const occ = await query<any>("select task_id, to_char(due_date,'YYYY-MM-DD') due_date, status, owner, completed_at from task_occurrences where due_date between $1 and $2", [from, to]);
  const occBy = new Map(occ.map((o) => [`${o.task_id}|${o.due_date}`, o]));
  const rows: TaskRow[] = [];
  for (const t of tasks) {
    const common = { id: t.id, title: t.title, business_id: t.business_id, activity: t.activity, owner_archived: false, source: "dashboard" as const, read_only: false,
      open_url: null, promotion_id: t.promotion_id, promotion_title: t.promotion_title, file_count: t.file_count, recurrence: t.recurrence };
    if (!t.recurrence) {
      const done = vnDate(t.completed_at);
      rows.push({ ...common, key: t.id, occurrence: null, series_key: null, owner: t.owner, status: t.status, due_date: t.due_date,
        completed_on: t.status === "done" ? done ?? t.due_date : null, completed_basis: t.status === "done" ? (done ? "completion" : t.due_date ? "due_date" : null) : null,
        recurring: false, version: t.version });
      continue;
    }
    if (t.status === "cancelled") continue;   // a cancelled series has no live occurrences
    for (const d of occurrences(t.recurrence, t.due_date, { start: from, end: to }, t.recurrence_until)) {
      const o = occBy.get(`${t.id}|${d}`);
      const status = o?.status ?? "todo", done = vnDate(o?.completed_at ?? null);
      // Each occurrence carries its own assignee and status; the series owner applies only when the occurrence has none.
      rows.push({ ...common, key: `${t.id}|${d}`, occurrence: d, series_key: `dashboard:${t.id}`, owner: o?.owner ?? t.owner, status, due_date: d,
        completed_on: status === "done" ? done ?? d : null, completed_basis: status === "done" ? (done ? "completion" : "due_date") : null, recurring: true, version: t.version });
    }
  }
  const tracker = await query<any>(
    `select source_instance, record_id, task_id, kind, business_id, title, task_type, assignee_name, assignee_archived, recurrence,
            to_char(due_date,'YYYY-MM-DD') due_date, to_char(occurrence_date,'YYYY-MM-DD') occurrence_date, status, to_char(completed_on,'YYYY-MM-DD') completed_on
       from tracker_task_records
      where removed_at is null and ($1::text is null or business_id = $1)
        and (kind = 'task' or occurrence_date between $2 and $3)
      order by due_date nulls last, title limit 5000`, [business, from, to]);
  for (const r of tracker) {
    const occurrence = r.occurrence_date;
    rows.push({ key: `tracker:${r.source_instance}:${r.record_id}`, id: `tracker:${r.source_instance}:${r.record_id}`, occurrence,
      series_key: occurrence ? `tracker:${r.source_instance}:${r.task_id}` : null, title: r.title, business_id: r.business_id, activity: TRACKER_TYPE[r.task_type] ?? r.task_type,
      owner: r.assignee_name, owner_archived: r.assignee_archived, status: r.status === "done" ? "done" : "todo", due_date: r.due_date,
      completed_on: r.status === "done" ? r.completed_on ?? r.due_date : null, completed_basis: r.status === "done" ? (r.completed_on ? "completion" : r.due_date ? "due_date" : null) : null,
      source: "tracker", read_only: true, open_url: openUrl(r.task_id), recurring: !!occurrence, recurrence: r.recurrence,
      promotion_id: null, promotion_title: null, version: null, file_count: 0 });
  }
  void today;
  return rows;
}

const open = (t: TaskRow) => t.status !== "done" && t.status !== "cancelled";

/** Whether a row belongs to a view (before the other filters). */
export function inView(t: TaskRow, view: TaskView, w: { from: string; to: string; custom: boolean; week: { from: string; to: string } }, today: string) {
  switch (view) {
    case "needs_attention": return open(t) && !!t.due_date && t.due_date <= today && (!w.custom || (t.due_date >= w.from && t.due_date <= w.to));
    case "this_week": return open(t) && !!t.due_date && t.due_date >= w.from && t.due_date <= w.to;
    case "upcoming": return open(t) && !!t.due_date && t.due_date >= w.from && t.due_date <= w.to;
    case "completed": return t.status === "done" && !!t.completed_on && t.completed_on >= w.from && t.completed_on <= w.to;
    case "all": return t.due_date ? t.due_date >= w.from && t.due_date <= w.to : true;
  }
}

/** The filters other than the view (and, for the assignee picker, other than assignee). */
export function matches(t: TaskRow, f: TaskFilters, skipAssignee = false) {
  if (f.business && t.business_id !== f.business) return false;
  if (!skipAssignee && f.assignees.length && !f.assignees.includes(t.owner ?? UNASSIGNED)) return false;
  if (f.status.length ? !f.status.includes(t.status) : t.status === "cancelled") return false;   // cancelled only when asked for
  if (f.activity.length && !f.activity.includes(t.activity ?? "")) return false;
  if (f.source.length && !f.source.includes(t.source)) return false;
  if (f.kind === "recurring" && !t.recurring) return false;
  if (f.kind === "oneoff" && t.recurring) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (![t.title, t.activity, t.promotion_title, t.owner].some((x) => x?.toLowerCase().includes(q))) return false;
  }
  return true;
}

export function sortTasks(rows: TaskRow[], view: TaskView) {
  if (view === "completed") return rows.sort((a, b) => (b.completed_on ?? "").localeCompare(a.completed_on ?? "") || a.title.localeCompare(b.title));
  return rows.sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}

export async function listTasks(f: TaskFilters, today = todayIn(OPERATIONS_TZ)) {
  const w = viewWindow(f, today);
  // Completed items can be due before they were finished; expand a little further back for them.
  const gatherFrom = f.view === "completed" ? addDays(w.from, -60) : w.from;
  const rows = await gatherTasks(null, gatherFrom, w.to, today);
  const inScope = rows.filter((t) => inView(t, f.view, w, today));
  const items = sortTasks(inScope.filter((t) => matches(t, f)), f.view);
  // Counts for the two headline views use the same filters.
  const na = viewWindow({ view: "needs_attention", from: null, to: null }, today), tw = viewWindow({ view: "this_week", from: null, to: null }, today);
  const nearRows = await gatherTasks(null, na.from, tw.to, today);
  const counts = {
    needs_attention: nearRows.filter((t) => inView(t, "needs_attention", na, today) && matches(t, f)).length,
    this_week: nearRows.filter((t) => inView(t, "this_week", tw, today) && matches(t, f)).length,
  };
  // Assignees in the current scope (all other filters applied), so people no longer on the team stay findable while they still have tasks.
  const people = new Map<string, { name: string; archived: boolean; count: number }>();
  for (const t of inScope.filter((x) => matches(x, f, true))) {
    const k = t.owner ?? UNASSIGNED, cur = people.get(k);
    people.set(k, { name: k, archived: (cur?.archived ?? false) || t.owner_archived, count: (cur?.count ?? 0) + 1 });
  }
  const snap = await one<any>("select to_char(window_from,'YYYY-MM-DD') window_from, to_char(window_to,'YYYY-MM-DD') window_to from tracker_snapshots order by published_at desc limit 1");
  const trackerHistoryNote = snap && w.from < snap.window_from
    ? `Task Tracker occurrences are available from ${snap.window_from}; earlier recurring occurrences from the Task Tracker aren't shown.` : null;
  return { items, total: items.length, counts, window: { from: w.from, to: w.to, custom: w.custom, week: w.week }, today,
    assignees: [...people.values()].sort((a, b) => (a.name === UNASSIGNED ? 1 : b.name === UNASSIGNED ? -1 : a.name.localeCompare(b.name))),
    activities: [...new Set(inScope.map((t) => t.activity).filter(Boolean))].sort(), trackerHistoryNote };
}
