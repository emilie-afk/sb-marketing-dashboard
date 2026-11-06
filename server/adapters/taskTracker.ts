// Pull adapter for the Task Tracker's read-only reporting API (GET /api/reporting/v1/tasks). Server side only.
//   TASK_TRACKER_API_URL              the tracker's https origin
//   TASK_TRACKER_REPORTING_SECRET     the tracker's dedicated reporting secret (Integrations screen there)
//   TASK_TRACKER_INSTANCE_ID          optional: the tracker's TRACKER_INSTANCE_ID; when set, it must match
//   TASK_TRACKER_BUSINESSES           dashboard businesses accepted from the tracker (default: sb)
//
// One way: the tracker is the editing authority for its tasks; here they are read-only copies in
// tracker_task_records (never in `tasks`). Dashboard-created tasks are untouched.
//
// Safety:
// - https origin only, no redirects, per-request deadline and size limit (reportingClient), plus an overall deadline,
//   a page limit and a record limit for the whole read. The overall deadline bounds every request (headers and body),
//   retries and the start and commit of publication; anything late is discarded.
// - Every page is validated completely. All pages must carry the same snapshot and instance, contiguous offsets and
//   a final page with no cursor. If the tracker reports the snapshot changed while paging, the read restarts
//   (a bounded number of times) and pages of different snapshots are never combined.
// - Only a complete, valid snapshot is published, in one transaction. Failed, partial, oversized or malformed
//   reads publish nothing, so the last good snapshot stays.
// - Reconciliation (same transaction): copies of tasks missing from the tracker's authoritative in-scope list are
//   removed, however old; occurrences outside their task's date span are removed; one-time tasks and occurrences
//   inside the snapshot window that are missing are removed; other old occurrences stay as history. Upserts are
//   keyed by (source instance, record id), so retries are idempotent.
import { z } from "zod";
import type pg from "pg";
import { getPool } from "../db";
import { HttpError } from "../http";
import { originOf, getJson } from "./reportingClient";

export const TT_SOURCE_ID = "pull.task_tracker";
export const TT_LIMITS = { pageSize: 500, maxPages: 60, maxRecords: 20_000, overallMs: 120_000, snapshotRetries: 3 };

export const taskTrackerConfigured = () => !!originOf(process.env.TASK_TRACKER_API_URL) && (process.env.TASK_TRACKER_REPORTING_SECRET ?? "").length >= 32;
export const trackerOrigin = () => originOf(process.env.TASK_TRACKER_API_URL);
export function trackerBusinesses(): string[] {
  const list = (process.env.TASK_TRACKER_BUSINESSES ?? "sb").split(",").map((s) => s.trim()).filter((s) => ["sb", "p2s", "perksradar"].includes(s));
  return list.length ? [...new Set(list)] : ["sb"];
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "invalid date");
const instance = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/);
const snapshotId = z.string().regex(/^snp_[0-9a-f]{32}$/);
const name = (max: number) => z.string().min(1).max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "control characters");

const itemSchema = z.object({
  record_id: z.string().max(80), kind: z.enum(["task", "occurrence"]), task_id: uuid, occurrence_date: date.nullable(),
  title: name(300), type: z.enum(["routine", "adhoc", "video"]), business_id: z.string().max(40),
  brand: z.object({ id: uuid, name: name(80), archived: z.boolean() }).strict(),
  assignee: z.object({ id: uuid, name: name(120), archived: z.boolean() }).strict(),
  recurrence: z.enum(["daily", "weekdays", "weekly", "monthly"]).nullable(),
  due_date: date.nullable(), status: z.enum(["open", "done"]), completed_on: date.nullable(), created_on: date.nullable(),
  source_updated_at: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "invalid time"),
  open_url: z.string().max(300),
}).strict().superRefine((it, ctx) => {
  const want = it.kind === "task" ? `task:${it.task_id}` : `occ:${it.task_id}:${it.occurrence_date}`;
  if (it.record_id !== want) ctx.addIssue({ code: "custom", message: "record id does not match its task and occurrence" });
  if ((it.kind === "occurrence") !== (it.occurrence_date !== null)) ctx.addIssue({ code: "custom", message: "occurrence date mismatch" });
  if (it.kind === "occurrence" && it.due_date !== it.occurrence_date) ctx.addIssue({ code: "custom", message: "occurrence due date mismatch" });
  if (it.status === "done" && !it.completed_on) ctx.addIssue({ code: "custom", message: "done without completion date" });
});
const scopeTaskSchema = z.object({ task_id: uuid, recurring: z.boolean(), first_due: date.nullable(), until: date.nullable() }).strict()
  .refine((t) => (t.recurring ? t.first_due !== null : t.first_due === null && t.until === null), "span mismatch");
const removalSchema = z.object({ task_id: uuid, reason: z.enum(["deleted", "brand_unassigned", "brand_not_reported", "out_of_scope"]) }).strict();
const pageSchema = z.object({
  schema_version: z.literal(2), source_instance: instance,
  snapshot: z.object({ id: snapshotId, generated_at: z.string().refine((v) => !Number.isNaN(Date.parse(v))), operational_date: date, timezone: z.literal("Asia/Ho_Chi_Minh"),
    window: z.object({ from: date, to: date }).strict(), total_items: z.number().int().min(0).max(TT_LIMITS.maxRecords) }).strict(),
  scope: z.object({ business_ids: z.array(z.string().max(40)).max(10) }).strict(),
  items: z.array(z.unknown()).max(TT_LIMITS.pageSize),
  in_scope_tasks: z.array(z.unknown()).max(TT_LIMITS.maxRecords).nullable(),
  removals: z.array(z.unknown()).max(TT_LIMITS.maxRecords),
  page: z.object({ offset: z.number().int().min(0), limit: z.number().int().min(1).max(TT_LIMITS.pageSize), count: z.number().int().min(0) }).strict(),
  next_cursor: z.string().regex(/^\d{1,7}$/).nullable(),
}).strict();

type Item = z.infer<typeof itemSchema>;
export type ScopeTask = z.infer<typeof scopeTaskSchema>;
export type Snapshot = { instance: string; id: string; generatedAt: string; window: { from: string; to: string }; items: Item[]; scopeTasks: ScopeTask[]; removals: z.infer<typeof removalSchema>[] };

class SnapshotChanged extends Error {}
const timeout = () => new HttpError(504, "source_timeout", "Task Tracker took too long to read; nothing was published.");

// Test hooks: run between reading and publishing, and inside the publishing transaction before it commits.
let beforePublish: () => Promise<void> = async () => {};
let beforeCommit: () => Promise<void> = async () => {};
export function _setPublishHooksForTests(h: { beforePublish?: () => Promise<void>; beforeCommit?: () => Promise<void> } | null) {
  beforePublish = h?.beforePublish ?? (async () => {}); beforeCommit = h?.beforeCommit ?? (async () => {});
}

/** Reads one complete snapshot, or throws. Never returns a partial or mixed read. */
async function readSnapshot(origin: string, deadline: number): Promise<Snapshot> {
  const headers = { "x-tracker-reporting-key": process.env.TASK_TRACKER_REPORTING_SECRET! };
  const allowed = new Set(trackerBusinesses());
  const expectInstance = process.env.TASK_TRACKER_INSTANCE_ID?.trim() || null;
  let snap: Snapshot | null = null;
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pageNo = 0; ; pageNo++) {
    if (pageNo >= TT_LIMITS.maxPages) throw new HttpError(502, "source_too_large", `Task Tracker has more than ${TT_LIMITS.maxPages} pages; nothing was published.`);
    if (Date.now() > deadline) throw timeout();
    const qs = `limit=${TT_LIMITS.pageSize}${snap ? `&snapshot=${snap.id}&cursor=${cursor}` : ""}`;
    let raw: unknown;
    try {
      raw = await getJson(origin, `/api/reporting/v1/tasks?${qs}`, headers, "Task Tracker", { deadline });
    } catch (e) {
      if (e instanceof HttpError && e.code === "source_conflict") throw new SnapshotChanged();
      throw e;
    }
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(502, "source_bad_response", "Task Tracker sent a page in an unexpected format; nothing was published.");
    const p = parsed.data;
    if (expectInstance && p.source_instance !== expectInstance) throw new HttpError(502, "source_bad_response", "Task Tracker reported a different instance than configured; nothing was published.");
    if (!snap) snap = { instance: p.source_instance, id: p.snapshot.id, generatedAt: p.snapshot.generated_at, window: p.snapshot.window, items: [], scopeTasks: [], removals: [] };
    else if (p.snapshot.id !== snap.id || p.source_instance !== snap.instance) throw new SnapshotChanged();
    if (p.page.offset !== snap.items.length || p.page.count !== p.items.length) throw new HttpError(502, "source_bad_response", "Task Tracker pages were not contiguous; nothing was published.");
    for (const raw of p.items) {
      const it = itemSchema.safeParse(raw);
      if (!it.success) throw new HttpError(502, "source_bad_response", "Task Tracker sent a record in an unexpected format; nothing was published.");
      if (!allowed.has(it.data.business_id)) throw new HttpError(502, "source_out_of_scope", "Task Tracker sent a record for a business this dashboard does not accept; nothing was published.");
      if (seen.has(it.data.record_id)) throw new HttpError(502, "source_bad_response", "Task Tracker sent a duplicate record; nothing was published.");
      seen.add(it.data.record_id);
      snap.items.push(it.data);
    }
    if (snap.items.length > TT_LIMITS.maxRecords) throw new HttpError(502, "source_too_large", "Task Tracker sent too many records; nothing was published.");
    if (p.next_cursor === null) {
      if (snap.items.length !== p.snapshot.total_items) throw new HttpError(502, "source_bad_response", "Task Tracker's last page did not complete the snapshot; nothing was published.");
      if (p.in_scope_tasks === null) throw new HttpError(502, "source_bad_response", "Task Tracker's last page has no scope list; nothing was published.");
      const scopeIds = new Set<string>();
      for (const r of p.in_scope_tasks) {
        const st = scopeTaskSchema.safeParse(r);
        if (!st.success || scopeIds.has(st.data.task_id)) throw new HttpError(502, "source_bad_response", "Task Tracker sent an unexpected scope entry; nothing was published.");
        scopeIds.add(st.data.task_id);
        snap.scopeTasks.push(st.data);
      }
      // Every reported record must belong to a task in the scope list.
      if (snap.items.some((it) => !scopeIds.has(it.task_id))) throw new HttpError(502, "source_bad_response", "Task Tracker sent a record outside its own scope list; nothing was published.");
      for (const r of p.removals) {
        const rr = removalSchema.safeParse(r);
        if (!rr.success) throw new HttpError(502, "source_bad_response", "Task Tracker sent an unexpected removal marker; nothing was published.");
        snap.removals.push(rr.data);
      }
      // A late final page is discarded: nothing that arrives after the overall deadline is published.
      if (Date.now() > deadline) throw timeout();
      return snap;
    }
    if (p.in_scope_tasks !== null) throw new HttpError(502, "source_bad_response", "Task Tracker sent its scope list before the last page; nothing was published.");
    if (p.removals.length) throw new HttpError(502, "source_bad_response", "Task Tracker sent removal markers before the last page; nothing was published.");
    if (Number(p.next_cursor) !== snap.items.length) throw new HttpError(502, "source_bad_response", "Task Tracker sent an unexpected page cursor; nothing was published.");
    cursor = p.next_cursor;
  }
}

type Bounded = { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult<any>> };

/**
 * One transaction whose statements and lock waits are bounded by the time left before `deadline`. Each statement
 * runs with statement_timeout and lock_timeout set to the remaining budget, so the server cancels anything that
 * would run past it (no uncancelled work is left racing a timer). After the last write, the deadline is checked
 * once more immediately before COMMIT; on any timeout the whole transaction is rolled back and source_timeout
 * is reported.
 */
async function boundedTransaction<T>(deadline: number, fn: (c: Bounded) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const remaining = () => Math.floor(deadline - Date.now());
  const bound = async () => {
    const ms = remaining();
    if (ms <= 0) throw timeout();
    if (Number.isFinite(ms)) await client.query(`set local statement_timeout = ${ms}; set local lock_timeout = ${ms}`);
  };
  const c: Bounded = { query: async (text, params = []) => { await bound(); return client.query(text, params as any[]); } };
  let done = false;
  try {
    await client.query("begin");
    const out = await fn(c);
    if (remaining() <= 0) throw timeout();            // after the final write, immediately before COMMIT
    await client.query("commit");
    done = true;
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const code = (e as { code?: string }).code;
    if (code === "57014" || code === "55P03") throw timeout();   // statement or lock wait cancelled by the budget
    throw e;
  } finally {
    // A connection that failed mid-transaction is discarded rather than reused.
    client.release(done ? undefined : true);
  }
}

/**
 * Publishes a complete snapshot atomically: upserts, reconciliation and the freshness record in one transaction.
 * It is never started after the overall deadline, and if the deadline passes while it runs it rolls back.
 */
export async function publishSnapshot(s: Snapshot, deadline = Infinity) {
  if (Date.now() > deadline) throw timeout();
  return boundedTransaction(deadline, async (c) => {
    // One publisher at a time, even if two jobs overlap.
    await c.query("select pg_advisory_xact_lock(hashtext('tracker_task_records'))");
    const ids: string[] = [];
    for (const it of s.items) {
      ids.push(it.record_id);
      await c.query(
        `insert into tracker_task_records (source_instance, record_id, task_id, kind, occurrence_date, business_id, title, task_type, brand_name, brand_archived,
                                           assignee_name, assignee_archived, recurrence, due_date, status, completed_on, created_on, source_updated_at, snapshot_id, synced_at, removed_at, removed_reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(), null, null)
         on conflict (source_instance, record_id) do update set task_id = excluded.task_id, kind = excluded.kind, occurrence_date = excluded.occurrence_date,
           business_id = excluded.business_id, title = excluded.title, task_type = excluded.task_type, brand_name = excluded.brand_name, brand_archived = excluded.brand_archived,
           assignee_name = excluded.assignee_name, assignee_archived = excluded.assignee_archived, recurrence = excluded.recurrence, due_date = excluded.due_date,
           status = excluded.status, completed_on = excluded.completed_on, created_on = excluded.created_on, source_updated_at = excluded.source_updated_at,
           snapshot_id = excluded.snapshot_id, synced_at = now(), removed_at = null, removed_reason = null`,
        [s.instance, it.record_id, it.task_id, it.kind, it.occurrence_date, it.business_id, it.title, it.type, it.brand.name, it.brand.archived,
          it.assignee.name, it.assignee.archived, it.recurrence, it.due_date, it.status, it.completed_on, it.created_on, it.source_updated_at, s.id]);
    }
    // Records from a business this dashboard no longer accepts.
    const scoped = await c.query(`update tracker_task_records set removed_at = now(), removed_reason = 'out_of_scope'
                                   where removed_at is null and not (business_id = any($1::text[]))`, [trackerBusinesses()]);
    let marked = scoped.rowCount ?? 0;
    // Reconciliation against the tracker's authoritative scope list (works after any gap, unlike time-limited
    // removal markers): copies of tasks no longer in scope are removed, including old occurrences outside the
    // window; occurrences outside their task's date span are removed; other old occurrences stay as history.
    const reasons = new Map(s.removals.map((r) => [r.task_id, r.reason]));
    const scope = s.scopeTasks;
    const outOfScope = await c.query(
      `update tracker_task_records r set removed_at = now(), removed_reason = coalesce((m.reasons ->> r.task_id::text), 'no_longer_reported')
         from (select $3::jsonb reasons) m
        where r.source_instance = $1 and r.removed_at is null and not (r.task_id = any($2::uuid[]))`,
      [s.instance, scope.map((t) => t.task_id), JSON.stringify(Object.fromEntries(reasons))]);
    marked += outOfScope.rowCount ?? 0;
    // Removal markers also give the reason for copies removed earlier without one.
    for (const [taskId, reason] of reasons)
      await c.query(`update tracker_task_records set removed_reason = $3 where source_instance = $1 and task_id = $2 and removed_at is not null
                       and removed_reason in ('not_in_snapshot', 'no_longer_reported') and not (task_id = any($4::uuid[]))`, [s.instance, taskId, reason, scope.map((t) => t.task_id)]);
    const spans = scope.filter((t) => t.recurring);
    const outsideSpan = await c.query(
      `update tracker_task_records r set removed_at = now(), removed_reason = 'not_in_snapshot'
         from unnest($2::uuid[], $3::date[], $4::date[]) as sp(task_id, first_due, until)
        where r.source_instance = $1 and r.removed_at is null and r.task_id = sp.task_id
          and (r.kind = 'task' or r.occurrence_date < sp.first_due or (sp.until is not null and r.occurrence_date > sp.until))`,
      [s.instance, spans.map((t) => t.task_id), spans.map((t) => t.first_due), spans.map((t) => t.until)]);
    marked += outsideSpan.rowCount ?? 0;
    // Records the snapshot covered (one-time tasks, occurrences inside its window) but no longer contains.
    const gone = await c.query(
      `update tracker_task_records set removed_at = now(), removed_reason = 'not_in_snapshot'
        where source_instance = $1 and removed_at is null and not (record_id = any($2::text[]))
          and (kind = 'task' or occurrence_date between $3 and $4)`, [s.instance, ids, s.window.from, s.window.to]);
    marked += gone.rowCount ?? 0;
    await beforeCommit();
    await c.query(`insert into tracker_snapshots (source_instance, snapshot_id, generated_at, window_from, window_to, record_count, removal_count, marked_removed)
                   values ($1,$2,$3,$4,$5,$6,$7,$8)`, [s.instance, s.id, s.generatedAt, s.window.from, s.window.to, s.items.length, s.removals.length, marked]);
    return { records: s.items.length, removals: s.removals.length, marked_removed: marked };
  });
}

/** Job entry (Settings → Data sources and the scheduled pull). Throws on failure; previous data is kept. */
export async function pullTaskTracker(_actor = "pull:task_tracker") {
  if (!taskTrackerConfigured()) return { outcome: "not_configured" as const, results: [], problems: [] };
  const origin = trackerOrigin()!;
  const deadline = Date.now() + TT_LIMITS.overallMs;
  // Every attempt, page, body read and the publication share one overall deadline.
  for (let attempt = 1; ; attempt++) {
    if (Date.now() > deadline) throw timeout();
    try {
      const snap = await readSnapshot(origin, deadline);
      await beforePublish();
      const out = await publishSnapshot(snap, deadline);
      return { outcome: "done" as const, results: [{ outcome: "accepted", snapshot: snap.id, ...out }], problems: [] as string[] };
    } catch (e) {
      if (e instanceof SnapshotChanged) {
        if (attempt >= TT_LIMITS.snapshotRetries) throw new HttpError(502, "source_busy", "Task Tracker kept changing while it was read; nothing was published. It will be read again later.");
        continue;
      }
      throw e;
    }
  }
}

/** "Open in Task Tracker" link, built here from the configured origin (never from source data). */
export function openUrl(taskId: string) {
  const o = trackerOrigin();
  return o && /^[0-9a-f-]{36}$/.test(taskId) ? `${o}/#/tasks/${taskId}` : null;
}
