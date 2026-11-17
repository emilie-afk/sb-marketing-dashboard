// Delivering one task to Task Tracker: the idempotent, recoverable send shared by marketing plan assignments and the
// private Slack review queue. Both tables carry the same delivery columns (delivery_status, delivery_error,
// last_attempt_at, highest_sent_at, fenced_through, tracker_*).
//
// The rules (see docs/PLANNING.md):
// - The caller records the send ("sending") BEFORE Task Tracker is called, under its own row lock, so the row can't be
//   edited or removed while a task may come into existence for it.
// - Every request carries the row's stable id as idempotency key; a repeat returns the original task.
// - An unanswered send stays "unknown" (locked) until Task Tracker returns the task, or confirms that none exists and
//   returns a database fence covering every earlier attempt's sent_at.
import { query } from "./db";
import { createTrackerTask, readTrackerTasks, sentAtNow, type Directory, type TrackerTask } from "./adapters/planningClient";

export type DeliveryTable = "plan_assignments" | "review_suggestions";
export type Claimed = {
  id: string;
  business: string;                      // dashboard business the task belongs to
  previous: string;                      // delivery status before the claim
  highestSentAt: string | null;
  fencedThrough: string | null;
  payload: { brand_id: string; assignee_id: string; title: string; brief: string; due_date: string };
};
export type DeliveryResult = { id: string; outcome: "created" | "failed" | "unknown"; existing?: boolean; code?: string; message?: string };

export const idempotencyKey = (id: string) => `mkp:${id}`;
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
export const claimedTimes = (row: any) => ({ highestSentAt: iso(row.highest_sent_at), fencedThrough: iso(row.fenced_through) });

export function storeTask(table: DeliveryTable, id: string, t: TrackerTask) {
  return query(
    `update ${table} set delivery_status = 'created', delivery_error = null, tracker_task_id = $2, tracker_version = $3, tracker_title = $4, tracker_due_date = $5,
            tracker_status = $6, tracker_assignee_name_now = $7, tracker_updated_at = $8, tracker_read_at = now() where id = $1`,
    [id, t.task_id, t.version, t.title, t.due_date, t.status, t.assignee.name, t.updated_at]);
}
export function setDelivery(table: DeliveryTable, id: string, status: "failed" | "unknown", msg: string) {
  return query(`update ${table} set delivery_status = $2, delivery_error = $3 where id = $1 and delivery_status <> 'created'`, [id, status, msg.slice(0, 500)]);
}

/** Checks a Tracker brand and assignee against the directory, for the given dashboard business. */
export function checkAgainstDirectory(dir: Directory, business: string, a: { brand_id: string; assignee_id: string }) {
  const b = dir.brands.find((x) => x.id === a.brand_id);
  if (!b) return { ok: false as const, code: "invalid_brand", message: "That Task Tracker brand is not available." };
  if (b.business_id !== business) return { ok: false as const, code: "invalid_brand", message: `${b.name} belongs to another dashboard business.` };
  const p = dir.people.find((x) => x.id === a.assignee_id);
  if (!p || !p.brand_ids.includes(b.id)) return { ok: false as const, code: "invalid_assignee", message: p ? `${p.name} cannot be assigned tasks in ${b.name}.` : "That person cannot be assigned tasks in Task Tracker." };
  return { ok: true as const, brand: b, person: p };
}

/** Sends one claimed row (already marked "sending" by the caller). */
export async function deliverClaimed(table: DeliveryTable, c: Claimed, trackerPlanId: string, origin: "plan" | "review", dir: Directory | null): Promise<DeliveryResult> {
  const key = idempotencyKey(c.id);
  const unresolved = c.previous === "sending" || c.previous === "unknown";
  if (unresolved) {
    // Reconcile by the id first: it may already exist from the unanswered attempt.
    const prior = await readTrackerTasks([key]).catch(() => null);
    if (prior && prior[0]) { await storeTask(table, c.id, prior[0]); return { id: c.id, outcome: "created", existing: true }; }
    if (prior === null) { await setDelivery(table, c.id, "unknown", "Task Tracker could not be checked. Retry later; no second task can be created."); return { id: c.id, outcome: "unknown", message: "Task Tracker could not be checked." }; }
  }
  // Validate the Tracker brand and assignee before sending (the tracker validates again). An unresolved send is
  // never refused here: only Task Tracker's own answer to the same id can settle it, so it is always sent.
  if (dir && !unresolved) {
    const chk = checkAgainstDirectory(dir, c.business, c.payload);
    if (!chk.ok) { await setDelivery(table, c.id, "failed", chk.message); return { id: c.id, outcome: "failed", code: chk.code, message: chk.message }; }
  }
  // sent_at is after every earlier attempt and after Task Tracker's fence (whatever this server's clock says), and the
  // greatest one sent is stored before the request leaves. The earlier unanswered attempt is named in supersedes_sent_at.
  const after = (v: string | null) => (v ? Date.parse(v) + 1 : 0);
  const sentAt = new Date(Math.max(Date.parse(sentAtNow()), after(c.highestSentAt), after(c.fencedThrough))).toISOString();
  await query(`update ${table} set highest_sent_at = greatest(coalesce(highest_sent_at, $2::timestamptz), $2::timestamptz) where id = $1`, [c.id, sentAt]);
  const out = await createTrackerTask({ key, plan_id: trackerPlanId, ...c.payload, sent_at: sentAt, supersedes_sent_at: c.highestSentAt, origin });
  if (out.kind === "created") { await storeTask(table, c.id, out.task); return { id: c.id, outcome: "created", existing: !out.created }; }
  if (out.kind === "refused") {
    if (out.fenced_through) await query(`update ${table} set fenced_through = greatest(coalesce(fenced_through, $2::timestamptz), $2::timestamptz) where id = $1`, [c.id, out.fenced_through]);
    // After an unanswered attempt, a refusal settles the row only when Task Tracker confirms no task exists AND returns
    // a fence at or after the greatest sent_at of every earlier attempt. Anything else (e.g. key_unavailable) keeps it locked.
    const settled = !unresolved || (out.task_exists === false && out.fenced_through !== null && (c.highestSentAt === null || Date.parse(out.fenced_through) >= Date.parse(c.highestSentAt)));
    if (settled) { await setDelivery(table, c.id, "failed", out.message); return { id: c.id, outcome: "failed", code: out.code, message: out.message }; }
    const msg = out.task_exists === false ? `${out.message} Task Tracker has no task for it, but did not confirm that earlier attempts are fenced off; it stays locked.` : `${out.message} A task may exist for this item; it stays locked until Task Tracker returns it or confirms there is none.`;
    await setDelivery(table, c.id, "unknown", msg);
    return { id: c.id, outcome: "unknown", code: out.code, message: msg };
  }
  await setDelivery(table, c.id, "unknown", `${out.message} It may have been created. Retry or Check Task Tracker settles it by its id; a second task is never created.`);
  return { id: c.id, outcome: "unknown", message: out.message };
}

/** Re-reads created (and unresolved) rows from Task Tracker by id; an unresolved row found there becomes created. */
export async function reconcile(table: DeliveryTable, rows: { id: string; delivery_status: string }[]) {
  const asg = rows.filter((a) => a.delivery_status === "created" || a.delivery_status === "unknown");
  const got = await readTrackerTasks(asg.map((a) => idempotencyKey(a.id)));
  for (const t of got) { const a = asg.find((x) => idempotencyKey(x.id) === t.idempotency_key); if (a) await storeTask(table, a.id, t); }
  for (const a of asg.filter((x) => x.delivery_status === "created" && !got.some((t) => t.idempotency_key === idempotencyKey(x.id))))
    await query(`update ${table} set tracker_status = 'deleted', tracker_read_at = now() where id = $1`, [a.id]);
  // Unresolved rows not found stay unresolved: only a new send with the same id settles them.
}
