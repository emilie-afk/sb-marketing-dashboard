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
import { z } from "zod";
import type pg from "pg";
import { query, one, tx, getPool } from "./db";
import { HttpError, badRequest, notFound } from "./http";
import type { Session } from "./auth";
import { assertReviewer } from "./review";
import { trackerDirectory, planningTrackerConfigured, changeTrackerDueDate, type Directory } from "./adapters/planningClient";
import { openUrl } from "./adapters/taskTracker";
import { fetchCorporateTasks, sendTaskReceipts, corporateGiftingCredentials, type CgTask, type TaskReceipt } from "./adapters/corporateGifting";
import { deliverClaimed, checkAgainstDirectory, claimedTimes, reconcile, setDelivery, storeTask, idempotencyKey } from "./trackerDelivery";
import { logServerError } from "./redact";
import { isIsoDate } from "../shared/dates";

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

/** Reads pending requests, keeps drafts in step, applies due-date updates, refreshes delivered tasks, sends receipts. */
export async function syncCorporateTasks() {
  if (!corporateGiftingCredentials()) return { outcome: "not_configured" as const };
  try {
    const since = (await one<{ t: string | null }>("select (max(cg_read_at) - interval '1 hour')::text t from corporate_task_drafts"))?.t ?? null;
    const page = await fetchCorporateTasks(since ? new Date(since).toISOString() : null);
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
      await query(`update corporate_task_drafts set receipt_due = true where delivery_status = 'created' and tracker_read_at is not null
                     and (receipt_sent_at is null or tracker_updated_at > receipt_sent_at or receipt_state <> 'delivered')`);
    }
    await applyDueDateUpdates();
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
      // Nothing to review for work already done, cancelled, dismissed or delivered elsewhere.
      if (t.slack_status !== "open" || ["dismissed", "delivered"].includes(t.delivery_status)) return "skipped";
      await c.query(
        `insert into corporate_task_drafts (id, cg_title, cg_brief, owner_hint, partners, cg_due_date, slack_status, cg_delivery_status, cg_content_version,
           title, brief, due_date, tracker_brand_id, tracker_brand_name, tracker_assignee_id, tracker_assignee_name, receipt_due)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,$6,$10,$11,$12,$13,true)`,
        [t.id, ...cg, brand?.id ?? null, brand?.name ?? null, brand && person ? person.id : null, brand && person ? person.name : null]);
      return "added";
    }
    await c.query(`update corporate_task_drafts set cg_title = $2, cg_brief = $3, owner_hint = $4, partners = $5, cg_due_date = $6, slack_status = $7,
                     cg_delivery_status = $8, cg_content_version = $9, cg_read_at = now(), updated_at = now() where id = $1`, [t.id, ...cg]);
    // Resolved (handled without a task) and dismissed drafts are closed: a later read never reopens them.
    const open = ["not_sent", "failed"].includes(cur.delivery_status) && !["dismissed", "resolved"].includes(cur.status);
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
  const rows = await query<any>(`select *, to_char(tracker_due_date,'YYYY-MM-DD') tr_due from corporate_task_drafts where receipt_due order by updated_at limit 100`);
  if (!rows.length) return { sent: 0 };
  const receipts: TaskReceipt[] = rows.map((r) => {
    if (r.delivery_status === "created") return { id: r.id, content_version: r.synced_content_version ?? r.cg_content_version, state: "delivered",
      tracker: { task_id: r.tracker_task_id, status: r.tracker_status ?? "open", assignee: r.tracker_assignee_name_now ?? r.tracker_assignee_name, due_date: r.tr_due, open_url: openUrl(r.tracker_task_id) } };
    // Corporate Gifts has no "resolved" state: resolved (handled, no task) is reported as dismissed, i.e. no task will be created.
    if (r.status === "dismissed" || r.status === "resolved") return { id: r.id, content_version: r.cg_content_version, state: "dismissed" };
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
    await query("update corporate_task_drafts set receipt_due = false, receipt_state = $2, receipt_sent_at = now() where id = $1 and updated_at <= $3",
      [r.id, receipts[i].state, r.updated_at]);
  }
  return { sent: rows.length };
}

// --------------------------------------------------------------------- the planning owner's queue
const COLS = `d.*, to_char(d.due_date,'YYYY-MM-DD') due_date_s, to_char(d.cg_due_date,'YYYY-MM-DD') cg_due_s, to_char(d.tracker_due_date,'YYYY-MM-DD') tracker_due_s`;
function needs(d: any) {
  const n: string[] = [];
  if (!d.tracker_brand_id) n.push("Choose the Task Tracker brand");
  if (!d.tracker_assignee_id) n.push("Choose the assignee");
  if (!d.due_date && !d.due_date_s) n.push("Set the due date");
  return n;
}
function dto(d: any) {
  return {
    id: d.id, status: d.status, version: d.version, edited: d.edited,
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
  return (await one<{ n: number }>("select count(*)::int n from corporate_task_drafts where (status = 'pending' or delivery_status in ('failed', 'unknown')) and status not in ('dismissed', 'resolved')"))!.n;
}

export async function listDrafts(s: Session, status: string) {
  assertReviewer(s);
  const where = status === "pending" ? "where (d.status = 'pending' or d.delivery_status in ('failed', 'unknown', 'sending')) and d.status not in ('dismissed', 'resolved')" : status === "all" ? "" : `where d.status = '${status === "approved" ? "approved" : status === "resolved" ? "resolved" : "dismissed"}'`;
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
  if (cur.status === "resolved") throw new HttpError(409, "resolved", "This draft was resolved (handled without a task).");
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
      if (!cur || ["dismissed", "resolved"].includes(cur.status) || ["sending", "created", "unknown"].includes(cur.delivery_status)) { skipped++; continue; }
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
  try {
    const claim = await tx(async (c) => {
      const cur = await lockRow(c, id);
      if (!cur) return { skip: "Not found." };
      if (cur.delivery_status === "created") return { skip: null, created: true };
      if (cur.status === "dismissed") return { skip: "Dismissed." };
      if (cur.status === "resolved") return { skip: "Resolved." };
      const missing = needs(cur);
      if (missing.length) return { skip: missing.join("; ") };
      await c.query(`update corporate_task_drafts set status = 'approved', reviewed_at = coalesce(reviewed_at, now()), delivery_status = 'sending', delivery_error = null,
                       last_attempt_at = now(), updated_at = now(), version = version + 1 where id = $1`, [id]);
      return { cur, previous: cur.delivery_status as string, ...claimedTimes(cur) };
    });
    if ("skip" in claim) return claim.created ? { id, outcome: "created", existing: true } : { id, outcome: "skipped", message: claim.skip };
    const { cur } = claim as any;
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
    await query("update corporate_task_drafts set receipt_due = true, updated_at = now() where id = $1", [id]).catch(() => {});
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
    await c.query("update corporate_task_drafts set status = 'dismissed', reviewed_at = now(), receipt_due = true, updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  await flushReceipts();
  return dto(await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id]));
}

/** Resolve: handled outside Task Tracker. Leaves "To review", creates no task; Corporate Gifts is told no task will be created. */
export async function resolveDraft(s: Session, id: string, version: number) {
  assertReviewer(s);
  await tx(async (c) => {
    const cur = await lockRow(c, id);
    if (!cur) throw notFound("Draft");
    if (cur.version !== version) throw new HttpError(409, "conflict", "This draft changed in another window. Reload first.");
    if (!["not_sent", "failed"].includes(cur.delivery_status)) throw new HttpError(409, "delivery_locked", "A Task Tracker task exists or may exist for this draft, so it can't be resolved.");
    if (!["pending", "approved"].includes(cur.status)) throw new HttpError(409, "not_open", cur.status === "resolved" ? "Already resolved." : "This draft was dismissed.");
    await c.query("update corporate_task_drafts set status = 'resolved', reviewed_at = now(), receipt_due = true, updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  await flushReceipts();
  return dto(await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id]));
}

export async function getDraft(s: Session, id: string) {
  assertReviewer(s);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Draft");
  const d = await one<any>(`select ${COLS} from corporate_task_drafts d where d.id = $1`, [id]);
  if (!d) throw notFound("Draft");
  return dto(d);
}

export async function refreshDrafts(s: Session) {
  assertReviewer(s);
  return syncCorporateTasks();
}

/** Tests only. */
export function _resetCorporateSyncState() { lastSync = null; }
