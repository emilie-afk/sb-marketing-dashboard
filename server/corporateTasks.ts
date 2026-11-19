// Corporate Gifts tasks: explicit, open Corporate Gifts actions that the Corporate Gifts app found (in Slack, or added
// there by hand) become Task Tracker tasks, so they appear in Marketing Tasks.
//
// Flow:
//  1. Read: the hourly Task Tracker sync (and Refresh in the queue) reads pending requests from Corporate Gifts over
//     the reporting connection and keeps one draft per request (draft id = request id; re-reading never duplicates).
//     New drafts get the Succulents Box brand and the default assignee (CORPORATE_TASK_DEFAULT_ASSIGNEE).
//  2. Review: only the planning owner sees the queue (everyone else gets 404, as for Slack Review). She can edit a
//     draft, assign several at once, dismiss, and send selected drafts to Task Tracker.
//  3. Deliver: the same idempotent, fenced delivery as plan assignments and Slack Review (server/trackerDelivery.ts).
//     A request is reported "delivered" to Corporate Gifts only with Task Tracker's task id.
//  4. After delivery Task Tracker owns the task (assignee, completion). A later due date from Corporate Gifts is applied
//     there with the version check; nothing else is changed, and a completed task stays completed.
//  5. Receipts: every state change is reported back to Corporate Gifts; a failed report is retried on the next sync.
//  6. Routing: Corporate Gifts routes each request by its owner. Only Marketing tasks are drafts here; work owned
//     outside Marketing is a check-off item (copied into corporate_checkoffs), and items without a clear owner wait
//     for a routing decision. Both are shown in the same Corporate Gifts view and acted on in Corporate Gifts.
//  7. Resolve (either app, same record; one shared "resolved" status, see docs/CORPORATE_TASKS.md): a draft not sent
//     yet is closed as resolved (status 'resolved', resolved_in) and can never be sent; a task in Task Tracker gets a
//     resolve request and is completed there with Task Tracker's completion rules, and reads as resolved once Task
//     Tracker shows it done; check-off items are marked done in Corporate Gifts. Repeats never complete anything twice.
//     Neither side reopens a resolved request (rescans, repeated clicks and stale receipts are ignored).
import { z } from "zod";
import type pg from "pg";
import { query, one, tx, getPool } from "./db";
import { HttpError, badRequest, notFound } from "./http";
import type { Session } from "./auth";
import { assertReviewer } from "./review";
import { trackerDirectory, planningTrackerConfigured, changeTrackerDueDate, completeTrackerTask, readTrackerTasks, type Directory } from "./adapters/planningClient";
import { openUrl } from "./adapters/taskTracker";
import { fetchCorporateTasks, sendTaskReceipts, corporateGiftingCredentials, fetchCheckoffs, sendTaskActions, type CgTask, type TaskReceipt, type FeedCursor } from "./adapters/corporateGifting";
import { deliverClaimed, checkAgainstDirectory, claimedTimes, reconcile, setDelivery, storeTask, idempotencyKey } from "./trackerDelivery";
import { logServerError } from "./redact";
import { isIsoDate, todayIn, OPERATIONS_TZ } from "../shared/dates";

const BUSINESS = "sb";
const T = "corporate_task_drafts" as const;
const defaultAssigneeName = () => (process.env.CORPORATE_TASK_DEFAULT_ASSIGNEE ?? "").trim().toLowerCase();

async function dirOrNull(): Promise<Directory | null> {
  if (!planningTrackerConfigured()) return null;
  try { return await trackerDirectory(); } catch { return null; }
}

/** The Succulents Box brand and the default assignee (first person whose name starts with the configured name). */
export function defaultsFrom(dir: Directory | null) {
  if (!dir) return { brand: null, person: null };
  const brands = dir.brands.filter((b) => b.business_id === BUSINESS);
  const brand = brands.length === 1 ? brands[0] : null;
  const want = defaultAssigneeName();
  const person = brand && want ? dir.people.find((p) => p.brand_ids.includes(brand.id) && p.name.trim().toLowerCase().startsWith(want)) ?? null : null;
  return { brand, person };
}

/** The note Task Tracker receives: the details, then the marketplaces with their Corporate Gifts links. */
export function trackerBrief(d: { brief: string | null; partners: { name: string; url: string }[]; owner_hint: string | null }) {
  const lines = [d.brief?.trim() || null, "", `Corporate Gifts · ${d.partners.map((p) => p.name).join(", ")}`, ...d.partners.map((p) => `${p.name}: ${p.url}`),
    d.owner_hint ? `Suggested owner (from Slack): ${d.owner_hint}` : null].filter((x) => x !== null) as string[];
  return lines.join("\n").replace(/^\n+/, "").slice(0, 2000);
}

// --------------------------------------------------------------------- read from Corporate Gifts
let lastSync: { at: string; ok: boolean; message: string | null } | null = null;
// What Corporate Gifts accepts, from its latest feed (unknown until it has been read): "resolved" receipts, and
// "routing" (feed v2, claims, task actions, the check-off feed and the completion fields on receipts).
let cgResolvedSupported = false;
let cgRoutingSupported = false;

/** Reads pending requests, keeps drafts in step, applies due-date updates, refreshes delivered tasks, sends receipts. */
export async function syncCorporateTasks() {
  if (!corporateGiftingCredentials()) return { outcome: "not_configured" as const };
  try {
    await releaseClaims();
    const since = (await one<{ t: string | null }>("select (max(cg_read_at) - interval '1 hour')::text t from corporate_task_drafts"))?.t ?? null;
    const page = await fetchCorporateTasks(since ? new Date(since).toISOString() : null);
    cgResolvedSupported = page.resolvedSupported;
    cgRoutingSupported = page.routingSupported;
    const dir = await dirOrNull();
    const { brand, person } = defaultsFrom(dir);
    let added = 0, updated = 0;
    for (const t of page.tasks) {
      const r = await upsertDraft(t, brand, person);
      if (r === "added") added++; else if (r === "updated") updated++;
    }
    // Current Task Tracker state first (assignee, completion), so a completed task is never changed.
    const created = await query<any>("select id, delivery_status from corporate_task_drafts where delivery_status in ('created', 'unknown')");
    if (created.length && planningTrackerConfigured()) {
      await reconcile(T, created).catch((e) => logServerError("corporate-tasks-reconcile", e));
      await completeRequested();
      await readCompletionDates();
      await query(`update corporate_task_drafts set receipt_due = true where delivery_status = 'created' and tracker_read_at is not null
                     and (receipt_sent_at is null or tracker_updated_at > receipt_sent_at or receipt_state <> 'delivered')`);
    }
    await applyCgResolutions();
    await applyDueDateUpdates();
    if (cgRoutingSupported) await syncCheckoffs().catch((e) => logServerError("corporate-checkoffs-sync", e));
    const receipts = await flushReceipts();
    lastSync = { at: new Date().toISOString(), ok: true, message: page.rejected ? `${page.rejected} request(s) had an unexpected format and were skipped.` : null };
    return { outcome: "done" as const, added, updated, rejected: page.rejected, receipts };
  } catch (e: any) {
    logServerError("corporate-tasks-sync", e);
    lastSync = { at: new Date().toISOString(), ok: false, message: e instanceof HttpError ? e.message : "Corporate Gifting tasks could not be read." };
    return { outcome: "failed" as const, error: lastSync.message };
  }
}

async function upsertDraft(t: CgTask, brand: { id: string; name: string } | null, person: { id: string; name: string } | null) {
  return tx(async (c) => {
    const cur = (await c.query("select * from corporate_task_drafts where id = $1 for update", [t.id])).rows[0];
    const cg = [t.title, t.brief, t.owner_hint, JSON.stringify(t.partners), t.due_date, t.slack_status, t.delivery_status, t.content_version];
    if (!cur) {
      // Nothing to review for work already done, cancelled, dismissed or delivered elsewhere, resolved, or not a
      // Marketing task (check-off items and items waiting for routing are shown from corporate_checkoffs).
      if (t.slack_status !== "open" || ["dismissed", "delivered", "resolved"].includes(t.delivery_status) || (t.route ?? "marketing") !== "marketing" || t.resolution) return "skipped";
      await c.query(
        `insert into corporate_task_drafts (id, cg_title, cg_brief, owner_hint, partners, cg_due_date, slack_status, cg_delivery_status, cg_content_version,
           title, brief, due_date, tracker_brand_id, tracker_brand_name, tracker_assignee_id, tracker_assignee_name, receipt_due)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,$6,$10,$11,$12,$13,true)`,
        [t.id, ...cg, brand?.id ?? null, brand?.name ?? null, brand && person ? person.id : null, brand && person ? person.name : null]);
      return "added";
    }
    await c.query(`update corporate_task_drafts set cg_title = $2, cg_brief = $3, owner_hint = $4, partners = $5, cg_due_date = $6, slack_status = $7,
                     cg_delivery_status = $8, cg_content_version = $9, cg_read_at = now(), updated_at = now() where id = $1`, [t.id, ...cg]);
    if (cur.status === "resolved") return "unchanged";
    const res = t.resolution;
    // Resolved (handled without a task) and dismissed drafts are closed: a later read never reopens them.
    const open = ["not_sent", "failed"].includes(cur.delivery_status) && !["dismissed", "resolved"].includes(cur.status);
    if (open && (res?.state === "resolved" || t.delivery_status === "resolved")) {
      // Resolved in Corporate Gifts (or by a Slack confirmation) before it was sent: closed here, never sent.
      await c.query(`update corporate_task_drafts set status = 'resolved', resolved_in = 'corporate_gifts', resolved_by = $2, completed_on = $3, completion_source = $4,
                       reviewed_at = coalesce(reviewed_at, now()), receipt_due = false, receipt_state = 'resolved', version = version + 1 where id = $1`,
        [t.id, res?.by ?? null, res?.completed_on ?? todayIn(OPERATIONS_TZ), res?.source ?? "manual"]);
      return "updated";
    }
    if (open && (t.route ?? "marketing") !== "marketing") {
      // Routed to a check-off item or back to review in Corporate Gifts: no longer a draft (it can come back).
      if (cur.status === "moved") return "unchanged";
      await c.query("update corporate_task_drafts set status = 'moved', route = $2, receipt_due = false, version = version + 1 where id = $1", [t.id, t.route]);
      return "updated";
    }
    if (open && cur.status === "moved") {
      await c.query("update corporate_task_drafts set status = 'pending', route = 'marketing', receipt_due = true, version = version + 1 where id = $1", [t.id]);
      return "updated";
    }
    if (cur.delivery_status === "created" && res?.state === "requested" && !cur.resolve_requested_at && cur.tracker_status !== "done") {
      // Resolve asked for in Corporate Gifts (or confirmed in Slack): complete it in Task Tracker on this sync.
      await c.query(`update corporate_task_drafts set resolve_requested_at = now(), resolve_due = true, resolve_error = null, resolved_by = $2, completed_on = $3,
                       completion_source = $4, version = version + 1 where id = $1`, [t.id, res.by, res.completed_on, res.source]);
      return "updated";
    }
    if (open) {
      if (t.slack_status !== "open" || t.delivery_status === "dismissed") {
        // Done or cancelled in Slack, or dismissed in Corporate Gifts: no task is created for it.
        await c.query("update corporate_task_drafts set status = 'dismissed', reviewed_at = coalesce(reviewed_at, now()), receipt_due = $2, version = version + 1 where id = $1",
          [t.id, t.delivery_status !== "dismissed"]);
        return "updated";
      }
      if (!cur.edited && t.content_version !== cur.cg_content_version) {
        await c.query("update corporate_task_drafts set title = $2, brief = $3, due_date = coalesce($4, due_date), version = version + 1 where id = $1", [t.id, t.title, t.brief, t.due_date]);
      }
      if (t.delivery_status === "pending" || (cur.delivery_status === "not_sent" && t.delivery_status !== "in_review")) await c.query("update corporate_task_drafts set receipt_due = true where id = $1", [t.id]);
      return t.content_version !== cur.cg_content_version ? "updated" : "unchanged";
    }
    // Delivered (or being delivered): Task Tracker owns it. Re-report if Corporate Gifts doesn't show it as delivered yet.
    if (cur.delivery_status === "created" && (t.delivery_status !== "delivered" || (t.delivered_version ?? 0) < (cur.synced_content_version ?? t.content_version)))
      await c.query("update corporate_task_drafts set receipt_due = true where id = $1", [t.id]);
    return "unchanged";
  });
}

/** Completes in Task Tracker every delivered task whose Resolve is pending (Task Tracker's own completion rules). */
async function completeRequested() {
  const rows = await query<{ id: string }>("select id from corporate_task_drafts where resolve_due and delivery_status = 'created' order by resolve_attempt_at nulls first limit 50");
  for (const r of rows) await completeOne(r.id);
}

async function completeOne(id: string): Promise<{ id: string; outcome: "resolved" | "failed" | "retry"; message?: string }> {
  await query("update corporate_task_drafts set resolve_attempt_at = now() where id = $1", [id]);
  try {
    const out = await completeTrackerTask(idempotencyKey(id));
    if (out.kind === "done") {
      await storeTask(T, id, out.task);
      await query(`update corporate_task_drafts set resolve_due = false, resolve_error = null,
                     tracker_completed_on = $2, completed_on = coalesce(completed_on, $2), completion_source = coalesce(completion_source, 'manual'), receipt_due = true where id = $1`,
        [id, out.task.completed_on ?? todayIn(OPERATIONS_TZ)]);
      return { id, outcome: "resolved" };
    }
    const message = out.kind === "missing" ? "The task no longer exists in Task Tracker." : out.message;
    if (out.kind === "refused" && out.task) await storeTask(T, id, out.task);
    await query("update corporate_task_drafts set resolve_due = false, resolve_error = $2, receipt_due = true where id = $1", [id, message.slice(0, 500)]);
    return { id, outcome: "failed", message };
  } catch (e: any) {
    // Not reached: it stays due and is tried again on the next sync (the completion is idempotent in Task Tracker).
    const message = e instanceof HttpError ? e.message : "Task Tracker could not be reached.";
    await query("update corporate_task_drafts set resolve_error = $2 where id = $1", [id, `${message} It will be retried.`.slice(0, 500)]);
    return { id, outcome: "retry", message };
  }
}

/** Completion dates of tasks completed directly in Task Tracker (for the receipt and the report). */
async function readCompletionDates() {
  const rows = await query<{ id: string }>("select id from corporate_task_drafts where delivery_status = 'created' and tracker_status = 'done' and tracker_completed_on is null limit 100");
  if (!rows.length) return;
  try {
    for (const t of await readTrackerTasks(rows.map((r) => idempotencyKey(r.id)))) {
      if (t.completed_on) await query("update corporate_task_drafts set tracker_completed_on = $2 where id = $1", [t.idempotency_key.replace(/^mkp:/, ""), t.completed_on]);
    }
  } catch (e) { logServerError("corporate-tasks-completion-dates", e); }
}

/**
 * Requests resolved in Corporate Gifts close their draft here, once no task exists or may exist for it: a draft whose
 * send is in progress or got no answer stays as it is until Task Tracker settles it (the reconcile above links an
 * existing task, which then wins: Corporate Gifts turns the resolution into a request to complete it). Never reopens.
 */
async function applyCgResolutions() {
  await query(`update corporate_task_drafts set status = 'resolved', resolved_in = 'corporate_gifts', reviewed_at = coalesce(reviewed_at, now()),
                 completed_on = coalesce(completed_on, (now() at time zone '${OPERATIONS_TZ}')::date), completion_source = coalesce(completion_source, 'manual'),
                 receipt_due = false, receipt_state = 'resolved', updated_at = now(), version = version + 1
                where cg_delivery_status = 'resolved' and status in ('pending', 'approved') and delivery_status in ('not_sent', 'failed')`);
}

/** A newer due date from Corporate Gifts reaches a delivered task (version-checked); nothing else is changed. */
async function applyDueDateUpdates() {
  if (!planningTrackerConfigured()) return;
  const rows = await query<any>(`select id, to_char(cg_due_date,'YYYY-MM-DD') cg_due, to_char(tracker_due_date,'YYYY-MM-DD') tr_due, tracker_version, cg_content_version, synced_content_version, tracker_status
                                   from corporate_task_drafts where delivery_status = 'created' and cg_content_version > coalesce(synced_content_version, 0)`);
  for (const r of rows) {
    try {
      if (r.cg_due && r.cg_due !== r.tr_due && r.tracker_status === "open") {
        const out = await changeTrackerDueDate(idempotencyKey(r.id), r.cg_due, r.tracker_version);
        if (out.kind === "updated") await storeTask(T, r.id, out.task);
        else if (out.kind === "conflict" && out.task) await storeTask(T, r.id, out.task);   // changed in Task Tracker meanwhile: its version wins
      }
      await query("update corporate_task_drafts set synced_content_version = $2, due_date = coalesce(tracker_due_date, due_date), receipt_due = true where id = $1", [r.id, r.cg_content_version]);
    } catch (e) {
      logServerError("corporate-tasks-due-date", e);
    }
  }
}

/** Reports state changes to Corporate Gifts. "delivered" only with Task Tracker's task id. */
export async function flushReceipts() {
  // Resolved in Corporate Gifts: nothing to report back.
  await query("update corporate_task_drafts set receipt_due = false where receipt_due and status = 'resolved' and resolved_in = 'corporate_gifts'");
  // A resolution made here waits until Corporate Gifts accepts "resolved" (rather than being reported as something else).
  const rows = await query<any>(`select *, to_char(tracker_due_date,'YYYY-MM-DD') tr_due, to_char(tracker_completed_on,'YYYY-MM-DD') tr_done, to_char(completed_on,'YYYY-MM-DD') done_on,
                                   updated_at::text updated_at_exact from corporate_task_drafts
                                  where receipt_due and status <> 'moved' and ($1 or not (status = 'resolved' and delivery_status <> 'created')) order by updated_at limit 100`, [cgResolvedSupported]);
  if (!rows.length) return { sent: 0 };
  // The completion fields only go to a Corporate Gifts build that reads them (an earlier build refuses unknown fields).
  const v2 = cgRoutingSupported;
  const receipts: TaskReceipt[] = rows.map((r) => {
    if (r.delivery_status === "created") return { id: r.id, content_version: r.synced_content_version ?? r.cg_content_version, state: "delivered",
      ...(v2 && r.resolve_requested_at && r.resolve_error && !r.resolve_due ? { resolve_error: r.resolve_error } : {}),
      tracker: { task_id: r.tracker_task_id, status: r.tracker_status ?? "open", assignee: r.tracker_assignee_name_now ?? r.tracker_assignee_name, due_date: r.tr_due, open_url: openUrl(r.tracker_task_id),
        ...(v2 ? { completed_on: r.tr_done } : {}) } };
    if (r.status === "resolved") return { id: r.id, content_version: r.cg_content_version, state: "resolved", ...(v2 ? { resolved_by: r.resolved_by ?? "Marketing Dashboard", completed_on: r.done_on } : {}) };
    if (r.status === "dismissed") return { id: r.id, content_version: r.cg_content_version, state: "dismissed" };
    if (r.delivery_status === "failed") return { id: r.id, content_version: r.cg_content_version, state: "failed", error: (r.delivery_error ?? "Delivery failed.").slice(0, 500) };
    return { id: r.id, content_version: r.cg_content_version, state: "in_review" };
  });
  try {
    await sendTaskReceipts(receipts);
  } catch (e) {
    logServerError("corporate-tasks-receipts", e);
    return { sent: 0, error: "Corporate Gifting did not accept the receipts; they are sent again on the next sync." };
  }
  for (const [i, r] of rows.entries()) {
    await query("update corporate_task_drafts set receipt_due = false, receipt_state = $2, receipt_sent_at = now() where id = $1 and updated_at <= $3::timestamptz",
      [r.id, receipts[i].state, r.updated_at_exact]);
  }
  return { sent: rows.length };
}

// --------------------------------------------------------------------- the planning owner's queue
const COLS = `d.*, to_char(d.due_date,'YYYY-MM-DD') due_date_s, to_char(d.cg_due_date,'YYYY-MM-DD') cg_due_s, to_char(d.tracker_due_date,'YYYY-MM-DD') tracker_due_s, to_char(d.completed_on,'YYYY-MM-DD') completed_on_s,
  to_char(d.tracker_completed_on,'YYYY-MM-DD') tracker_completed_on_s`;
/**
 * The one reading of a draft's resolution: "resolved" = closed without a task (status 'resolved', shared with Corporate
 * Gifts) or a task Task Tracker shows done after a Resolve; "requested" = Resolve asked for a task in Task Tracker,
 * waiting for Task Tracker. A task completed directly in Task Tracker is shown with its Task Tracker status.
 */
export function resolutionOf(d: { status: string; delivery_status: string; tracker_status?: string | null; resolve_requested_at?: unknown }): "resolved" | "requested" | null {
  if (d.status === "resolved") return "resolved";
  if (d.delivery_status === "created" && d.resolve_requested_at) return d.tracker_status === "done" ? "resolved" : "requested";
  return null;
}
function needs(d: any) {
  const n: string[] = [];
  if (!d.tracker_brand_id) n.push("Choose the Task Tracker brand");
  if (!d.tracker_assignee_id) n.push("Choose the assignee");
  if (!d.due_date && !d.due_date_s) n.push("Set the due date");
  return n;
}
function dto(d: any) {
  return {
    id: d.id, status: d.status, version: d.version, edited: d.edited, resolved_in: d.resolved_in ?? null,
    // Corporate Gifts' own state of the request (e.g. "resolved" there, waiting for a Task Tracker check here).
    cg_state: d.cg_delivery_status,
    resolution: resolutionOf(d) ? { state: resolutionOf(d), by: d.resolved_by, completed_on: d.completed_on_s ?? d.tracker_completed_on_s, error: d.resolve_error, pending: d.resolve_due } : null,
    fields: { title: d.title, brief: d.brief, due_date: d.due_date_s, brand: d.tracker_brand_id ? { id: d.tracker_brand_id, name: d.tracker_brand_name } : null,
      assignee: d.tracker_assignee_id ? { id: d.tracker_assignee_id, name: d.tracker_assignee_name } : null },
    source: { title: d.cg_title, brief: d.cg_brief, owner_hint: d.owner_hint, due_date: d.cg_due_s, partners: d.partners, slack_status: d.slack_status, read_at: d.cg_read_at },
    needs: d.status === "pending" || d.delivery_status === "failed" ? needs(d) : [],
    delivery: { status: d.delivery_status, error: d.delivery_error, last_attempt_at: d.last_attempt_at },
    task: d.tracker_task_id ? { status: d.tracker_status, title: d.tracker_title, due_date: d.tracker_due_s, assignee: d.tracker_assignee_name_now ?? d.tracker_assignee_name, open_url: openUrl(d.tracker_task_id) } : null,
    receipt: { state: d.receipt_state, due: d.receipt_due },
    sent_brief: trackerBrief({ brief: d.brief, partners: d.partners ?? [], owner_hint: d.owner_hint }),
  };
}

export async function pendingCorporateCount(s: Session) {
  assertReviewer(s);
  return (await one<{ n: number }>(`select (select count(*) from corporate_task_drafts where (status = 'pending' or delivery_status in ('failed', 'unknown')) and status not in ('dismissed', 'resolved', 'moved'))
                                         + (select count(*) from corporate_checkoffs where listed and state = 'open' and route = 'review') as n`))!.n;
}

export async function listDrafts(s: Session, status: string) {
  assertReviewer(s);
  const requested = "(d.resolve_requested_at is not null and coalesce(d.tracker_status, 'open') <> 'done')";
  const where = status === "pending" ? `where (d.status = 'pending' or d.delivery_status in ('failed', 'unknown', 'sending') or d.resolve_due or (d.resolve_error is not null and ${requested})) and d.status not in ('dismissed', 'resolved', 'moved')`
    : status === "all" ? "where d.status <> 'moved'"
    : status === "resolved" ? "where d.status = 'resolved' or (d.resolve_requested_at is not null and d.tracker_status = 'done')"
    : `where d.status = '${status === "approved" ? "approved" : "dismissed"}'`;
  const rows = await query<any>(`select ${COLS} from corporate_task_drafts d ${where} order by d.created_at desc limit 300`);
  return { items: rows.map(dto), last_sync: lastSync, tracker_connected: planningTrackerConfigured() };
}

async function lockRow(c: pg.PoolClient, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return (await c.query(`select *, to_char(due_date,'YYYY-MM-DD') due_date_s from corporate_task_drafts where id = $1 for update`, [id])).rows[0] ?? null;
}

export const draftEditSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().max(300).refine((v) => v.trim().length > 0, "required"),
  brief: z.string().max(1500).nullable().optional(),
  tracker_assignee_id: z.string().uuid().nullable().optional(),
  due_date: z.string().refine(isIsoDate, "must be a date").nullable().optional(),
}).strict();

async function checkAssignee(assigneeId: string) {
  const dir = await dirOrNull();
  if (!dir) throw new HttpError(503, "tracker_unavailable", "Task Tracker could not be reached to check the assignee. Try again.");
  const { brand } = defaultsFrom(dir);
  if (!brand) throw new HttpError(422, "invalid_brand", "Task Tracker has no single Succulents Box brand for planning.");
  const chk = checkAgainstDirectory(dir, BUSINESS, { brand_id: brand.id, assignee_id: assigneeId });
  if (!chk.ok) throw new HttpError(422, chk.code, chk.message);
  return { brand: chk.brand, person: chk.person };
}

function assertEditable(cur: any) {
  if (["sending", "created", "unknown"].includes(cur.delivery_status)) throw new HttpError(409, "delivery_locked", "A Task Tracker task exists or may exist for this draft; change it in Task Tracker.");
  if (cur.status === "dismissed") throw new HttpError(409, "dismissed", "This draft was dismissed.");
  if (cur.status === "resolved") throw new HttpError(409, "resolved", "This draft was resolved; it can't be sent.");
  if (cur.status === "moved") throw new HttpError(409, "moved", "This item is no longer a Marketing task (see Corporate Gifts routing).");
}

export async function editDraft(s: Session, id: string, v: z.infer<typeof draftEditSchema>) {
  assertReviewer(s);
  const who = v.tracker_assignee_id ? await checkAssignee(v.tracker_assignee_id) : null;
  await tx(async (c) => {
    const cur = await lockRow(c, id);
    if (!cur) throw notFound("Draft");
    if (cur.version !== v.version) throw new HttpError(409, "conflict", "This draft changed in another window. Reload, then re-apply your edit.");
    assertEditable(cur);
    await c.query(`update corporate_task_drafts set title = $2, brief = $3, due_date = $4, edited = true, updated_at = now(), version = version + 1
                     ${who ? ", tracker_brand_id = $5, tracker_brand_name = $6, tracker_assignee_id = $7, tracker_assignee_name = $8" : ""} where id = $1`,
      [id, v.title.trim(), v.brief ?? null, v.due_date ?? null, ...(who ? [who.brand.id, who.brand.name, who.person.id, who.person.name] : [])]);
  });
  return dto(await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id]));
}

export const bulkAssignSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  tracker_assignee_id: z.string().uuid().optional(),
  due_date: z.string().refine(isIsoDate, "must be a date").optional(),
}).strict().refine((v) => v.tracker_assignee_id || v.due_date, "Choose an assignee or a due date");

/** Sets the assignee and/or due date on several drafts at once (drafts already sent are left as they are). */
export async function bulkAssign(s: Session, v: z.infer<typeof bulkAssignSchema>) {
  assertReviewer(s);
  const who = v.tracker_assignee_id ? await checkAssignee(v.tracker_assignee_id) : null;
  let changed = 0, skipped = 0;
  await tx(async (c) => {
    for (const id of [...new Set(v.ids)]) {
      const cur = await lockRow(c, id);
      if (!cur || ["dismissed", "resolved", "moved"].includes(cur.status) || ["sending", "created", "unknown"].includes(cur.delivery_status)) { skipped++; continue; }
      await c.query(`update corporate_task_drafts set due_date = coalesce($2, due_date), edited = edited or $2 is not null, updated_at = now(), version = version + 1
                       ${who ? ", tracker_brand_id = $3, tracker_brand_name = $4, tracker_assignee_id = $5, tracker_assignee_name = $6" : ""} where id = $1`,
        [id, v.due_date ?? null, ...(who ? [who.brand.id, who.brand.name, who.person.id, who.person.name] : [])]);
      changed++;
    }
  });
  return { changed, skipped };
}

/** Sends one draft. Concurrent clicks, duplicates and retries create at most one task (same id every time). */
async function sendOne(id: string, dir: Directory | null) {
  const lockConn = await getPool().connect();
  const lock = (await lockConn.query("select pg_try_advisory_lock(hashtextextended($1, 17)) ok", [id])).rows[0];
  if (!lock?.ok) { lockConn.release(); return { id, outcome: "sending", message: "Already being sent." }; }
  let stale = false;   // refused by Corporate Gifts: nothing to report back (it already knows the current state)
  try {
    const claim = await tx(async (c) => {
      const cur = await lockRow(c, id);
      if (!cur) return { skip: "Not found." };
      if (cur.delivery_status === "created") return { skip: null, created: true };
      if (cur.status === "dismissed") return { skip: "Dismissed." };
      if (cur.status === "resolved") return { skip: "Resolved; it is not sent." };
      if (cur.cg_delivery_status === "resolved") return { skip: "Resolved in Corporate Gifts; it is not sent." };
      if (cur.status === "moved") return { skip: "Not a Marketing task." };
      const missing = needs(cur);
      if (missing.length) return { skip: missing.join("; ") };
      await c.query(`update corporate_task_drafts set status = 'approved', reviewed_at = coalesce(reviewed_at, now()), delivery_status = 'sending', delivery_error = null,
                       last_attempt_at = now(), updated_at = now(), version = version + 1 where id = $1`, [id]);
      return { cur, previous: cur.delivery_status as string, ...claimedTimes(cur) };
    });
    if ("skip" in claim) return claim.created ? { id, outcome: "created", existing: true } : { id, outcome: "skipped", message: claim.skip };
    const { cur } = claim as any;
    const revert = (message: string, extra = "") => query(`update corporate_task_drafts set delivery_status = $2, status = case when $2 = 'not_sent' then 'pending' else status end,
                                                             delivery_error = $3 ${extra} where id = $1`, [id, claim.previous, message.slice(0, 500)]);
    // An earlier claim whose answer was lost is released first (no task was started for it). If a Resolve was asked
    // for meanwhile, the release resolves it in Corporate Gifts and the draft is not sent.
    if (cur.claim_release_due) {
      const rel = await releaseClaims([id]);
      const out = rel.get(id);
      if (!out || out === "pending") {
        await revert("Corporate Gifts has not confirmed that the earlier send was cancelled; try again shortly.");
        return { id, outcome: "skipped", message: "Corporate Gifts has not confirmed that the earlier send was cancelled; try again shortly." };
      }
      if (out === "resolved") {
        await revert("Resolved in Corporate Gifts; it is not sent.");
        stale = true;
        return { id, outcome: "skipped", message: "Resolved in Corporate Gifts; it is not sent.", stale: true };
      }
    }
    // Claim the request in Corporate Gifts with the version this draft was built from. A request resolved, rerouted,
    // dismissed or changed there since the last refresh is refused, so a stale draft (e.g. an open tab) never creates a
    // task. An unanswered earlier send is re-claimed (accepted) and settled by its id as before.
    let refusal: string | null = null;
    let uncertain = false;   // the claim may have been applied in Corporate Gifts, but its answer was lost
    try {
      const [r] = await sendTaskActions([{ id, action: "claim", by: "Marketing Dashboard", content_version: cur.cg_content_version }]);
      if (!r) uncertain = true;
      else if (r.outcome !== "claimed") refusal = r.message ?? "Corporate Gifts did not confirm the request.";
    } catch (e: any) {
      if (e instanceof HttpError && ["actions_rejected", "not_configured"].includes(e.code)) refusal = `${e.message} Nothing was sent.`;
      else uncertain = true;
    }
    if (uncertain) {
      const message = "Corporate Gifts didn't answer, so nothing was sent to Task Tracker. The request is released there and can be sent again.";
      if (["not_sent", "failed"].includes(claim.previous)) {
        // Task Tracker was never called: release the possible claim (now if reachable, else on the next sync).
        await revert(message, ", claim_release_due = true");
        stale = true;
        await releaseClaims([id]).catch(() => {});
        return { id, outcome: "failed", message, stale: true };
      }
      // An earlier send may have created the task: it stays unsettled and is checked against Task Tracker as before.
      await setDelivery(T, id, "unknown", "Corporate Gifts didn't answer; retry to settle the earlier send.");
      stale = true;
      return { id, outcome: "failed", message: "Corporate Gifts didn't answer; retry to settle the earlier send." };
    }
    if (refusal) {
      if (["not_sent", "failed"].includes(claim.previous)) {
        await query(`update corporate_task_drafts set delivery_status = $2, status = case when $2 = 'not_sent' then 'pending' else status end, delivery_error = $3 where id = $1`,
          [id, claim.previous, refusal.slice(0, 500)]);
      } else await setDelivery(T, id, "unknown", refusal);
      stale = true;
      return { id, outcome: "skipped", message: refusal, stale: true };
    }
    if (!planningTrackerConfigured()) {
      if (["not_sent", "failed"].includes(claim.previous)) await setDelivery(T, id, "failed", "Task Tracker is not connected.");
      else await setDelivery(T, id, "unknown", "Task Tracker is not connected; retry once it is.");
      return { id, outcome: "failed", message: "Task Tracker is not connected." };
    }
    const r = await deliverClaimed(T, { id, business: BUSINESS, previous: claim.previous, highestSentAt: (claim as any).highestSentAt, fencedThrough: (claim as any).fencedThrough,
      payload: { brand_id: cur.tracker_brand_id, assignee_id: cur.tracker_assignee_id, title: cur.title, brief: trackerBrief({ brief: cur.brief, partners: cur.partners ?? [], owner_hint: cur.owner_hint }), due_date: cur.due_date_s } },
      id, "review", dir);
    if (r.outcome === "created") await query("update corporate_task_drafts set synced_content_version = cg_content_version where id = $1", [id]);
    return r;
  } finally {
    if (!stale) await query("update corporate_task_drafts set receipt_due = true, updated_at = now() where id = $1", [id]).catch(() => {});
    await lockConn.query("select pg_advisory_unlock(hashtextextended($1, 17))", [id]).catch(() => {});
    lockConn.release();
  }
}

export async function sendDrafts(s: Session, ids: string[]) {
  assertReviewer(s);
  if (!ids.length || ids.length > 50) throw badRequest("Choose 1 to 50 drafts.");
  const dir = await dirOrNull();
  const results = [];
  for (const id of [...new Set(ids)]) results.push(await sendOne(id, dir));
  // Refused as stale: read Corporate Gifts again so those drafts show their current state (resolved, moved, changed).
  if (results.some((r: any) => r.stale)) await syncCorporateTasks();
  const receipts = await flushReceipts();
  return { results, receipts };
}

export async function dismissDraft(s: Session, id: string, version: number) {
  assertReviewer(s);
  await tx(async (c) => {
    const cur = await lockRow(c, id);
    if (!cur) throw notFound("Draft");
    if (cur.version !== version) throw new HttpError(409, "conflict", "This draft changed in another window. Reload first.");
    if (!["not_sent", "failed"].includes(cur.delivery_status)) throw new HttpError(409, "delivery_locked", "A Task Tracker task exists or may exist for this draft, so it can't be dismissed.");
    if (cur.status === "resolved" || cur.status === "moved") throw new HttpError(409, cur.status, "This draft is no longer open.");
    await c.query("update corporate_task_drafts set status = 'dismissed', reviewed_at = now(), receipt_due = true, updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  await flushReceipts();
  return dto(await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id]));
}

/**
 * Releases claims whose answer was lost (no Task Tracker task was started for them). A confirmed answer clears the
 * flag; "resolved" means a Resolve was waiting for the send: the draft is closed on the next read. Unanswered ones stay
 * due. Returns each id's outcome ("pending" while not confirmed).
 */
async function releaseClaims(only?: string[]): Promise<Map<string, string>> {
  // Named ids come from sendOne, which holds the draft's send lock (its local state is "sending" meanwhile).
  const rows = await query<{ id: string }>(`select id from corporate_task_drafts where claim_release_due
                                              and ${only ? "id = any($1::uuid[])" : "delivery_status in ('not_sent', 'failed')"} limit 50`, only ? [only] : []);
  const out = new Map<string, string>();
  if (!rows.length) return out;
  let results: { id: string; outcome: string }[] = [];
  try { results = await sendTaskActions(rows.map((r) => ({ id: r.id, action: "release" as const, by: "Marketing Dashboard" }))); }
  catch (e) { logServerError("corporate-tasks-release", e); }
  for (const r of rows) {
    const x = results.find((y) => y.id === r.id);
    if (!x || !["released", "resolved", "not_claimed", "not_found", "delivered"].includes(x.outcome)) { out.set(r.id, "pending"); continue; }
    if (x.outcome === "delivered") logServerError("corporate-tasks-release", new Error(`Request ${r.id} shows as delivered in Corporate Gifts after an unanswered claim.`));
    await query("update corporate_task_drafts set claim_release_due = false where id = $1", [r.id]);
    out.set(r.id, x.outcome);
  }
  return out;
}

// --------------------------------------------------------------------- Resolve
export const resolveSchema = z.object({
  version: z.number().int().min(1).optional(),                // from the row the person saw (refused if it changed since)
  completed_on: z.string().refine(isIsoDate, "must be a date").nullable().optional(),
}).strict();

/**
 * Resolve from the dashboard. Holds the same per-draft lock as sending, so a resolution and a send never interleave.
 *  - A draft not sent yet: closed at once as resolved (handled without a task; never sent; reported to Corporate Gifts).
 *  - A task in Task Tracker: completed there now with Task Tracker's completion rules; it reads as resolved once Task
 *    Tracker confirms (a failure is shown and retried on the next sync).
 *  - A send in progress or without an answer: Task Tracker is checked first; an existing task is completed as above,
 *    an unsettled send is refused until it is settled (Retry settles it; never a second task).
 */
export async function resolveDraft(s: Session, id: string, v: z.infer<typeof resolveSchema>) {
  assertReviewer(s);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Draft");
  const today = todayIn(OPERATIONS_TZ);
  if (v.completed_on && v.completed_on > today) throw badRequest("The completion date can't be in the future.");
  const lockConn = await getPool().connect();
  const lock = (await lockConn.query("select pg_try_advisory_lock(hashtextextended($1, 17)) ok", [id])).rows[0];
  if (!lock?.ok) { lockConn.release(); throw new HttpError(409, "sending", "This task is being sent to Task Tracker right now. Wait for the result, then decide."); }
  let step: "already" | "complete" | "resolved";
  try {
    const pre = await one<any>("select id, version, status, delivery_status from corporate_task_drafts where id = $1", [id]);
    if (!pre) throw notFound("Draft");
    if (v.version !== undefined && pre.version !== v.version) throw new HttpError(409, "conflict", "This draft changed in another window. Reload first.");
    if (["sending", "unknown"].includes(pre.delivery_status) && planningTrackerConfigured())
      // Holding the lock, a leftover "sending" is an interrupted send: look it up like an unanswered one.
      await reconcile(T, [{ id, delivery_status: "unknown" }]).catch((e) => logServerError("corporate-tasks-resolve-check", e));
    step = await tx(async (c) => {
      const cur = await lockRow(c, id);
      if (resolutionOf(cur) === "resolved" || (cur.delivery_status === "created" && cur.tracker_status === "done")) {
        // From the row the person saw: a repeat is refused like any other change to a closed row.
        if (v.version !== undefined) throw new HttpError(409, "not_open", "Already resolved.");
        return "already";
      }
      if (cur.status === "moved") throw new HttpError(409, "moved", "This item is not a Marketing task; resolve it under check-off items.");
      if (["sending", "unknown"].includes(cur.delivery_status))
        throw new HttpError(409, "delivery_unsettled", "Its last send got no answer and Task Tracker has no task for it yet, so that send could still arrive. Retry settles it (never a second task); then Resolve.");
      if (cur.delivery_status === "created") {
        if (cur.resolve_requested_at && (cur.resolve_due || !cur.resolve_error)) return "complete";   // already asked: try again now
        await c.query(`update corporate_task_drafts set resolve_requested_at = coalesce(resolve_requested_at, now()), resolve_due = true, resolve_error = null, resolved_by = coalesce(resolved_by, $2),
                         completed_on = coalesce(completed_on, $3), completion_source = coalesce(completion_source, 'manual'), updated_at = now(), version = version + 1 where id = $1`,
          [id, s.email, v.completed_on ?? today]);
        return "complete";
      }
      if (cur.status === "dismissed") throw new HttpError(409, "not_open", "This draft was dismissed.");
      await c.query(`update corporate_task_drafts set status = 'resolved', resolved_in = 'dashboard', resolved_by = $2, completed_on = $3, completion_source = 'manual',
                       reviewed_at = now(), receipt_due = true, updated_at = now(), version = version + 1 where id = $1`, [id, s.email, v.completed_on ?? today]);
      return "resolved";
    });
  } finally {
    await lockConn.query("select pg_advisory_unlock(hashtextextended($1, 17))", [id]).catch(() => {});
    lockConn.release();
  }
  let message: string | undefined;
  if (step === "complete") {
    if (!planningTrackerConfigured()) message = "Task Tracker is not connected; it is completed on the next sync.";
    else { const r = await completeOne(id); if (r.outcome !== "resolved") message = r.message; }
  }
  await flushReceipts();
  return { outcome: step, message, draft: dto(await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id])) };
}

export async function getDraft(s: Session, id: string) {
  assertReviewer(s);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Draft");
  const d = await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id]);
  if (!d) throw notFound("Draft");
  return dto(d);
}

// --------------------------------------------------------------------- check-off items
/**
 * Follows the Corporate Gifts change feed (every task request, paged by its source updated_at and id) and keeps the
 * check-off copy in step. Every item is upserted with its "listed" flag and applied only if it is not older than the
 * stored row (source updated_at), so an older response can neither bring back nor remove a newer state; items that left
 * the list (e.g. routed to Marketing) are kept as unlisted rows and hidden.
 * Each run re-reads a short overlap before the stored cursor, so a row committed late at the source is not skipped.
 */
const FEED = "corporate-checkoffs";
const OVERLAP_MS = 10 * 60_000;
const NIL = "00000000-0000-0000-0000-000000000000";
export async function syncCheckoffs(full = false) {
  if (!corporateGiftingCredentials()) return { read: 0 };
  const saved = full ? null : await one<{ after_at: string }>("select after_at from corporate_feed_cursors where name = $1", [FEED]);
  let cursor: FeedCursor | null = saved ? { after: new Date(Date.parse(saved.after_at) - OVERLAP_MS).toISOString(), after_id: NIL } : null;
  let read = 0, rejected = 0, pages = 0, last: FeedCursor | null = null;
  while (pages++ < 100) {
    const page = await fetchCheckoffs(cursor);
    for (const x of page.items) {
      await query(
        `insert into corporate_checkoffs (id, title, route, route_reason, owner, owner_team, partners, due_date, state, completed_on, completion_source, resolved_by, resolved_at,
           evidence_count, cg_version, cg_updated_at, listed, read_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
         on conflict (id) do update set title = excluded.title, route = excluded.route, route_reason = excluded.route_reason, owner = excluded.owner, owner_team = excluded.owner_team,
           partners = excluded.partners, due_date = excluded.due_date, state = excluded.state, completed_on = excluded.completed_on, completion_source = excluded.completion_source,
           resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at, evidence_count = excluded.evidence_count, cg_version = excluded.cg_version,
           cg_updated_at = excluded.cg_updated_at, listed = excluded.listed, read_at = now()
         where corporate_checkoffs.cg_updated_at <= excluded.cg_updated_at`,
        [x.id, x.title, x.route, x.route_reason, x.owner, x.owner_team, JSON.stringify(x.partners), x.due_date, x.state, x.completed_on, x.completion_source, x.resolved_by, x.resolved_at,
          x.evidence_count, x.version, x.updated_at, x.listed]);
    }
    read += page.items.length; rejected += page.rejected;
    if (page.next) last = page.next;
    if (!page.has_more || !page.next) break;
    cursor = page.next;
  }
  // Only a cursor that moved forward is stored (never one inside the overlap that was just re-read).
  if (last) await query(
    `insert into corporate_feed_cursors (name, after_at, after_id) values ($1,$2,$3)
     on conflict (name) do update set after_at = excluded.after_at, after_id = excluded.after_id, updated_at = now()
     where (excluded.after_at::timestamptz, excluded.after_id) > (corporate_feed_cursors.after_at::timestamptz, corporate_feed_cursors.after_id)`, [FEED, last.after, last.after_id]);
  return { read, rejected };
}

export async function listCheckoffs(s: Session, status: string) {
  assertReviewer(s);
  const where = status === "open" ? "where listed and state = 'open'" : status === "done" ? "where listed and state = 'done'" : "where listed";
  const rows = await query<any>(`select *, to_char(due_date,'YYYY-MM-DD') due_s, to_char(completed_on,'YYYY-MM-DD') done_s from corporate_checkoffs ${where}
                                  order by (route = 'review') desc, state, due_date nulls last, title limit 300`);
  return { items: rows.map((x) => ({ id: x.id, title: x.title, route: x.route, route_reason: x.route_reason, owner: x.owner, owner_team: x.owner_team, partners: x.partners,
    due_date: x.due_s, state: x.state, completed_on: x.done_s, completion_source: x.completion_source, resolved_by: x.resolved_by, version: x.cg_version })),
    // Who follows up an item assigned to Marketing (the drafts' default assignee).
    follow_up_name: followUpName() };
}
const followUpName = () => { const n = (process.env.CORPORATE_TASK_DEFAULT_ASSIGNEE ?? "").trim(); return n ? n.charAt(0).toUpperCase() + n.slice(1) : "Marketing"; };

export const followUpSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
/**
 * Follow up: assign check-off items to Marketing (one or many), applied in Corporate Gifts. Each becomes a Marketing
 * draft here with the default assignee, ready to send to Task Tracker. Each item on its own: failed ones can be retried.
 */
export async function followUpCheckoffs(s: Session, v: z.infer<typeof followUpSchema>) {
  assertReviewer(s);
  const ids = [...new Set(v.ids)];
  const known = new Map((await query<any>("select id, state from corporate_checkoffs where listed and id = any($1::uuid[])", [ids])).map((x) => [x.id, x]));
  const results: { id: string; outcome: string; message?: string }[] = [];
  const send = ids.filter((id) => {
    const x = known.get(id);
    if (!x) { results.push({ id, outcome: "failed", message: "Not found; refresh first." }); return false; }
    if (x.state !== "open") { results.push({ id, outcome: "failed", message: "Already closed." }); return false; }
    return true;
  });
  if (send.length) {
    try {
      results.push(...(await sendTaskActions(send.map((id) => ({ id, action: "route" as const, route: "marketing" as const, by: s.email })))).map((r) => ({ id: r.id, outcome: r.outcome === "routed" ? "assigned" : "failed", ...(r.outcome === "routed" ? {} : { message: r.message ?? "Corporate Gifts did not apply it." }) })));
    } catch (e: any) {
      results.push(...send.map((id) => ({ id, outcome: "failed", message: e instanceof HttpError ? e.message : "Corporate Gifting could not be reached." })));
    }
    await syncCheckoffs().catch((e) => logServerError("corporate-checkoffs-sync", e));
    await syncCorporateTasks();
  }
  return { results };
}

export const markDoneSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100), completed_on: z.string().refine(isIsoDate, "must be a date").nullable().optional() }).strict();
/** Mark done (one or many check-off items) in Corporate Gifts. Each item on its own: failed ones can be retried. */
export async function markCheckoffsDone(s: Session, v: z.infer<typeof markDoneSchema>) {
  assertReviewer(s);
  if (v.completed_on && v.completed_on > todayIn(OPERATIONS_TZ)) throw badRequest("The completion date can't be in the future.");
  const ids = [...new Set(v.ids)];
  const known = new Map((await query<any>("select id, route, state from corporate_checkoffs where listed and id = any($1::uuid[])", [ids])).map((x) => [x.id, x]));
  const results: { id: string; outcome: string; message?: string }[] = [];
  const send = ids.filter((id) => {
    const x = known.get(id);
    if (!x) { results.push({ id, outcome: "failed", message: "Not found; refresh first." }); return false; }
    if (x.route !== "checkoff") { results.push({ id, outcome: "failed", message: "Choose a route first." }); return false; }
    return true;
  });
  if (send.length) {
    try {
      results.push(...await sendTaskActions(send.map((id) => ({ id, action: "resolve" as const, by: s.email, completed_on: v.completed_on ?? todayIn(OPERATIONS_TZ) }))));
    } catch (e: any) {
      results.push(...send.map((id) => ({ id, outcome: "failed", message: e instanceof HttpError ? e.message : "Corporate Gifting could not be reached." })));
    }
    await syncCheckoffs().catch((e) => logServerError("corporate-checkoffs-sync", e));
  }
  return { results };
}

export const routeSchema = z.object({ route: z.enum(["marketing", "checkoff"]), version: z.number().int().min(1) }).strict();
/** "Assign as Marketing task" / "Track as check-off" for an item waiting for routing (decided in Corporate Gifts). */
export async function routeCheckoff(s: Session, id: string, v: z.infer<typeof routeSchema>) {
  assertReviewer(s);
  const [r] = await sendTaskActions([{ id, action: "route", route: v.route, by: s.email, version: v.version }]);
  if (!r || r.outcome !== "routed") throw new HttpError(409, "not_routed", r?.message ?? "Corporate Gifts did not apply the routing.");
  await syncCheckoffs().catch((e) => logServerError("corporate-checkoffs-sync", e));
  if (v.route === "marketing") await syncCorporateTasks();
  return { ok: true };
}

export async function refreshDrafts(s: Session) {
  assertReviewer(s);
  return syncCorporateTasks();
}

/** Tests only. */
export function _resetCorporateSyncState() { lastSync = null; }
