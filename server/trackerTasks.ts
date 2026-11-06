// Read-only Task Tracker tasks for the dashboard's task views, calendar and summaries.
// Items are shaped like dashboard tasks but carry source "tracker" and read_only: true. Their ids start with
// "tracker:", and every dashboard task mutation refuses such ids (see assertDashboardTask).
import { query, one } from "./db";
import { forbidden, notFound } from "./http";
import { openUrl, TT_SOURCE_ID } from "./adapters/taskTracker";

const TYPE_LABEL: Record<string, string> = { routine: "Routine", adhoc: "Ad hoc", video: "Video" };
export const isTrackerId = (id: string) => id.startsWith("tracker:");

/** Guard for every dashboard task mutation path. */
export function assertDashboardTask(id: string) {
  if (isTrackerId(id)) throw forbidden("This task comes from the Task Tracker and is read-only here. Open it in the Task Tracker to change it.");
}

function item(r: any) {
  return {
    id: `tracker:${r.source_instance}:${r.record_id}`, title: r.title, business_id: r.business_id, activity: TYPE_LABEL[r.task_type] ?? r.task_type,
    owner: r.assignee_name, owner_archived: r.assignee_archived, status: r.status === "done" ? "done" : "todo", due_date: r.due_date,
    recurrence: r.recurrence, occurrence: r.occurrence_date, promotion_id: null, promotion_title: null, file_count: 0, links: [],
    completed_at: r.completed_on, brand_name: r.brand_name, brand_archived: r.brand_archived,
    source: "tracker", read_only: true, open_url: openUrl(r.task_id), version: null,
  };
}

const COLS = `source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, brand_archived, assignee_name, assignee_archived, recurrence,
              to_char(due_date,'YYYY-MM-DD') due_date, to_char(occurrence_date,'YYYY-MM-DD') occurrence_date, status, to_char(completed_on,'YYYY-MM-DD') completed_on`;

/** Task list: one-time tasks (all) and occurrences inside the window. Never series-level completion. */
export async function trackerTaskItems(f: { business: string | null; owner: string | null; status: string | null; from: string; to: string }) {
  const status = f.status === "done" ? "done" : f.status === "todo" ? "open" : f.status ? "none" : null;
  const rows = await query(
    `select ${COLS} from tracker_task_records
      where removed_at is null and ($1::text is null or business_id = $1) and ($2::text is null or assignee_name = $2) and ($3::text is null or status = $3)
        and (kind = 'task' or occurrence_date between $4 and $5)
      order by due_date nulls last, title limit 2000`, [f.business, f.owner, status, f.from, f.to]);
  return rows.map(item);
}

export async function trackerTaskDetail(id: string) {
  const m = /^tracker:([a-z0-9][a-z0-9_-]{1,39}):(.+)$/.exec(id);
  if (!m) throw notFound("Task");
  const r = await one(`select ${COLS}, synced_at from tracker_task_records where source_instance = $1 and record_id = $2 and removed_at is null`, [m[1], m[2]]);
  if (!r) throw notFound("Task");
  return { task: { ...item(r), source: "tracker", synced_at: r.synced_at }, links: [], history: [], files: [], read_only: true };
}

/** Calendar entries (dated tracker records inside the range). */
export async function trackerCalendar(from: string, to: string, business: string | null) {
  const rows = await query(`select ${COLS} from tracker_task_records where removed_at is null and due_date between $1 and $2 and ($3::text is null or business_id = $3)`, [from, to, business]);
  return rows.map((r: any) => ({ type: "task", id: `tracker:${r.source_instance}:${r.record_id}`, business: r.business_id, title: r.title, start: r.due_date, end: r.due_date,
    status: r.status === "done" ? "done" : "todo", occurrence: r.occurrence_date, source: "tracker", read_only: true, open_url: openUrl(r.task_id) }));
}

/** Work summary rows: open records and records completed in the last 14 days; occurrences within 35 days back and 7 ahead. */
export async function trackerWorkRows(business: string | null, today: string) {
  const rows = await query(
    `select ${COLS} from tracker_task_records
      where removed_at is null and ($1::text is null or business_id = $1)
        and (status = 'open' or completed_on >= $2::date - 14)
        and (kind = 'task' or occurrence_date between $2::date - 35 and $2::date + 7)
      order by due_date nulls last limit 400`, [business, today]);
  return rows.map(item);
}

/** Freshness of the tracker copy, for task views. */
export async function trackerFreshness() {
  return one(`select s.status, s.last_success_at, s.last_failure_at, s.last_error,
                     (select max(generated_at) from tracker_snapshots) as snapshot_generated_at
                from source_connections s where s.id = $1`, [TT_SOURCE_ID]);
}
