// Slack Review: a private queue of task suggestions found in one Slack channel.
//
// Access (server-side, every path):
// - Reviewing (list, count, detail, search, edit, preview, create, dismiss, refresh) is for the planning owner only:
//   the account whose verified sign-in email equals PLANNING_OWNER_EMAIL. Dashboard roles grant nothing here, admins
//   and management included. Everyone else gets 404, exactly as if the feature did not exist. Without the setting,
//   nobody has access.
// - The scanner submits suggestions with its own revocable secret (SLACK_REVIEW_INGEST_SECRET, header
//   x-review-ingest-key) and may read only its own checkpoint. It cannot list or read the queue, review, or create
//   tasks, and it never sees the Task Tracker planning credential. Sessions are not accepted on the scanner path.
// - Only the fields Emilie approves (title, brief, brand, assignee, due date) go to Task Tracker. Slack excerpts, links,
//   scanner notes and review history stay in these tables and are not used by any shared view, export or report.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { query, one, tx, getPool } from "./db";
import { HttpError, badRequest, notFound, readJson, json } from "./http";
import type { Session } from "./auth";
import { isPlanningOwner, PLAN_BUSINESSES, BUSINESS_LABEL } from "./planning";
import { trackerDirectory, planningTrackerConfigured, type Directory } from "./adapters/planningClient";
import { trackerOrigin } from "./adapters/taskTracker";
import { deliverClaimed, checkAgainstDirectory, claimedTimes, reconcile, setDelivery } from "./trackerDelivery";
import { hit, clientKey } from "./rateLimit";
import { isIsoDate } from "../shared/dates";

// ------------------------------------------------------------ access
/** The queue does not exist for anyone but the planning owner. */
export function assertReviewer(s: Session) {
  if (!isPlanningOwner(s)) throw notFound("Page");
}

// ------------------------------------------------------------ scanner intake
export const INGEST_HEADER = "x-review-ingest-key";
const hash = (v: string) => createHash("sha256").update(v).digest();
const channelAllowed = () => { const c = (process.env.SLACK_REVIEW_CHANNEL_ID ?? "").trim(); return /^[A-Z0-9]{6,20}$/.test(c) ? c : null; };

function authenticateScanner(req: Request) {
  const secret = process.env.SLACK_REVIEW_INGEST_SECRET ?? "";
  const channel = channelAllowed();
  if (secret.length < 32 || !channel) throw new HttpError(503, "review_disabled", "Slack review intake is not configured.");
  const presented = req.headers.get(INGEST_HEADER) ?? "";
  if (!(presented.length >= 32 && presented.length <= 200 && timingSafeEqual(hash(presented), hash(secret))))
    throw new HttpError(401, "unauthorized", "Invalid scanner credential.");
  return { channel };
}

const TS = /^[0-9]{9,11}\.[0-9]{6}$/;
const slackUrl = z.string().max(500).regex(/^https:\/\/[a-z0-9-]+\.slack\.com\//).nullable().optional();
const txt = (max: number) => z.string().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "control characters");
const sourceKeyRe = /^slack:[A-Z0-9]{6,20}:[0-9]{9,11}\.[0-9]{6}:[a-z0-9-]{1,40}$/;
const suggestionIn = z.object({
  message_ts: z.string().regex(TS),
  action_id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  thread_ts: z.string().regex(TS).nullable().optional(),
  posted_at: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be a time"),
  message_url: slackUrl, thread_url: slackUrl,
  excerpt: txt(4000).refine((v) => v.trim().length > 0, "required"),
  scanner_note: txt(1000).nullable().optional(),
  deadline_text: txt(200).nullable().optional(),
  flags: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(10).optional(),
  title: txt(300).refine((v) => v.trim().length > 0, "required"),
  brief: txt(1500).nullable().optional(),
  business: z.enum(PLAN_BUSINESSES).nullable().optional(),
  assignee_hint: txt(120).nullable().optional(),
  due_date: z.string().refine(isIsoDate, "must be a date").nullable().optional(),
  // A later message about an action already submitted: attach it to that suggestion instead of creating a new one.
  followup_of: z.string().regex(sourceKeyRe).nullable().optional(),
}).strict();
const batchIn = z.object({
  batch_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,100}$/),
  channel_id: z.string().regex(/^[A-Z0-9]{6,20}$/),
  range: z.object({ from_ts: z.string().regex(TS).nullable(), to_ts: z.string().regex(TS) }).strict(),
  checkpoint_ts: z.string().regex(TS),
  skipped_count: z.number().int().min(0).max(10_000).default(0),
  suggestions: z.array(suggestionIn).max(200),
}).strict();
const tsNum = (ts: string) => Number(ts);

export async function handleReviewIntake(req: Request, path: string): Promise<Response> {
  await hit({ bucket: `review-intake:${clientKey(req)}`, limit: 120, windowSec: 3600 });
  const { channel } = authenticateScanner(req);
  if (path === "/review-intake/checkpoint" && req.method === "GET") {
    const r = await one<{ checkpoint_ts: string | null; updated_at: string }>("select checkpoint_ts, updated_at from review_scan_state where channel_id = $1", [channel]);
    return json({ channel_id: channel, checkpoint_ts: r?.checkpoint_ts ?? null, updated_at: r?.updated_at ?? null });
  }
  if (path === "/review-intake/batches" && req.method === "POST") {
    const parsed = batchIn.safeParse(await readJson(req, 2_000_000));
    if (!parsed.success) throw new HttpError(422, "invalid_batch", "The batch is not valid.", parsed.error.issues.slice(0, 10).map((i) => ({ field: i.path.join("."), message: i.message })));
    const b = parsed.data;
    if (b.channel_id !== channel) throw new HttpError(403, "wrong_channel", "This credential submits for one channel only.");
    if (b.range.from_ts && tsNum(b.range.from_ts) > tsNum(b.range.to_ts)) throw badRequest("range.from_ts is after range.to_ts.");
    if (tsNum(b.checkpoint_ts) > tsNum(b.range.to_ts)) throw badRequest("checkpoint_ts is after the processed range.");
    const out = await tx(async (c) => {
      await c.query("insert into review_scan_state (channel_id) values ($1) on conflict do nothing", [channel]);
      const st = (await c.query("select checkpoint_ts from review_scan_state where channel_id = $1 for update", [channel])).rows[0];
      const prior = (await c.query("select created_count, followup_count, unchanged_count, skipped_count from review_scan_batches where batch_id = $1", [b.batch_id])).rows[0];
      if (prior) return { replayed: true, ...prior, checkpoint_ts: st.checkpoint_ts };
      let created = 0, followups = 0, unchanged = 0;
      for (const s of b.suggestions) {
        const key = `slack:${channel}:${s.message_ts}:${s.action_id}`;
        if (s.followup_of) {
          const parent = (await c.query(
            `select id from review_suggestions where source_key = $1
             union select suggestion_id from review_followups where source_key = $1 limit 1`, [s.followup_of])).rows[0];
          if (parent && key !== s.followup_of) {
            const r = await c.query(`insert into review_followups (suggestion_id, source_key, posted_at, message_url, excerpt) values ($1,$2,$3,$4,$5)
                                     on conflict (source_key) do nothing`, [parent.id, key, s.posted_at, s.message_url ?? null, s.excerpt]);
            if (r.rowCount) followups++; else unchanged++;
            continue;
          }
        }
        // Already followed up elsewhere, or already a suggestion: never duplicated, never overwritten.
        const isFollowup = (await c.query("select 1 from review_followups where source_key = $1", [key])).rowCount;
        if (isFollowup) { unchanged++; continue; }
        const r = await c.query(
          `insert into review_suggestions (source_key, channel_id, message_ts, thread_ts, posted_at, message_url, thread_url, excerpt, scanner_note, deadline_text, flags,
                                           suggested_title, suggested_brief, suggested_business, suggested_assignee, suggested_due_date, title, brief, business_id, due_date)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$12,$13,$14,$16) on conflict (source_key) do nothing`,
          [key, channel, s.message_ts, s.thread_ts ?? null, s.posted_at, s.message_url ?? null, s.thread_url ?? null, s.excerpt, s.scanner_note ?? null, s.deadline_text ?? null, s.flags ?? [],
            s.title.trim(), s.brief ?? null, s.business ?? null, s.assignee_hint ?? null, s.due_date ?? null]);
        if (r.rowCount) created++; else unchanged++;
      }
      // The checkpoint moves forward only now, in the transaction that accepted the batch, and never backwards.
      const next = !st.checkpoint_ts || tsNum(b.checkpoint_ts) > tsNum(st.checkpoint_ts) ? b.checkpoint_ts : st.checkpoint_ts;
      await c.query("update review_scan_state set checkpoint_ts = $2, updated_at = now() where channel_id = $1", [channel, next]);
      await c.query(`insert into review_scan_batches (batch_id, channel_id, range_from_ts, range_to_ts, created_count, followup_count, unchanged_count, skipped_count)
                     values ($1,$2,$3,$4,$5,$6,$7,$8)`, [b.batch_id, channel, b.range.from_ts, b.range.to_ts, created, followups, unchanged, b.skipped_count]);
      return { replayed: false, created_count: created, followup_count: followups, unchanged_count: unchanged, skipped_count: b.skipped_count, checkpoint_ts: next };
    });
    // Counts only: no message text in the answer or in logs.
    return json({ outcome: out.replayed ? "already_accepted" : "accepted", ...out }, out.replayed ? 200 : 201);
  }
  throw new HttpError(404, "not_found", "No such endpoint.");
}

// ------------------------------------------------------------ the queue (owner only)
const COLS = `s.id, s.source_key, s.channel_id, s.message_ts, s.thread_ts, s.posted_at, s.message_url, s.thread_url, s.excerpt, s.scanner_note, s.deadline_text, s.flags,
  s.suggested_title, s.suggested_brief, s.suggested_business, s.suggested_assignee, to_char(s.suggested_due_date,'YYYY-MM-DD') suggested_due_date,
  s.title, s.brief, s.business_id, s.tracker_brand_id, s.tracker_brand_name, s.tracker_assignee_id, s.tracker_assignee_name, to_char(s.due_date,'YYYY-MM-DD') due_date,
  s.status, s.reviewed_at, s.edited, s.version, s.delivery_status, s.delivery_error, s.last_attempt_at, s.highest_sent_at, s.fenced_through,
  s.tracker_task_id, s.tracker_version, s.tracker_title, to_char(s.tracker_due_date,'YYYY-MM-DD') tracker_due_date, s.tracker_status, s.tracker_assignee_name_now,
  s.tracker_updated_at, s.created_at, s.updated_at,
  r.status sync_status, to_char(r.due_date,'YYYY-MM-DD') sync_due_date, r.title sync_title, r.assignee_name sync_assignee_name, r.source_updated_at sync_updated_at, r.removed_at sync_removed_at`;
const FROM = `review_suggestions s left join tracker_task_records r on r.record_id = 'task:' || s.tracker_task_id::text and r.kind = 'task'`;

function taskOf(s: any) {
  if (s.delivery_status !== "created") return null;
  const direct = { status: s.tracker_status, due_date: s.tracker_due_date, title: s.tracker_title, assignee: s.tracker_assignee_name_now, at: s.tracker_updated_at ? new Date(s.tracker_updated_at).getTime() : 0, from: "tracker" };
  const synced = s.sync_status && !s.sync_removed_at ? { status: s.sync_status, due_date: s.sync_due_date, title: s.sync_title, assignee: s.sync_assignee_name, at: s.sync_updated_at ? new Date(s.sync_updated_at).getTime() : 0, from: "sync" } : null;
  const v = synced && synced.at >= direct.at ? synced : direct;
  const o = trackerOrigin();
  return { task_id: s.tracker_task_id, status: v.status, due_date: v.due_date, title: v.title, assignee: v.assignee, from: v.from, as_of: v.at ? new Date(v.at).toISOString() : null,
    open_url: o ? `${o}/#/tasks/${s.tracker_task_id}` : null };
}

/** Decisions Emilie still needs to make before a task can be created. */
function needs(s: any) {
  const n: string[] = [];
  if (!s.business_id) n.push("Choose the business");
  if (!s.tracker_brand_id) n.push("Choose the Task Tracker brand");
  if (!s.tracker_assignee_id) n.push("Choose the assignee");
  if (!s.due_date) n.push(s.deadline_text ? `Set the deadline (Slack said: "${s.deadline_text}")` : "Set the deadline");
  return n;
}

function dto(s: any, followups: any[] = []) {
  return {
    id: s.id, status: s.status, version: s.version, edited: s.edited, reviewed_at: s.reviewed_at,
    source: { posted_at: s.posted_at, message_url: s.message_url, thread_url: s.thread_url, is_reply: !!s.thread_ts && s.thread_ts !== s.message_ts, excerpt: s.excerpt, scanner_note: s.scanner_note,
      deadline_text: s.deadline_text, flags: s.flags, followups: followups.map((f) => ({ posted_at: f.posted_at, message_url: f.message_url, excerpt: f.excerpt })) },
    suggested: { title: s.suggested_title, brief: s.suggested_brief, business: s.suggested_business, assignee: s.suggested_assignee, due_date: s.suggested_due_date },
    fields: { title: s.title, brief: s.brief, business_id: s.business_id, business: s.business_id ? BUSINESS_LABEL[s.business_id] : null,
      brand: s.tracker_brand_id ? { id: s.tracker_brand_id, name: s.tracker_brand_name } : null,
      assignee: s.tracker_assignee_id ? { id: s.tracker_assignee_id, name: s.tracker_assignee_name } : null, due_date: s.due_date },
    needs: needs(s),
    delivery: { status: s.delivery_status, error: s.delivery_error, last_attempt_at: s.last_attempt_at },
    task: taskOf(s),
    locked: ["sending", "created", "unknown"].includes(s.delivery_status),
  };
}

export async function pendingCount(s: Session) {
  assertReviewer(s);
  return (await one<{ n: number }>("select count(*)::int n from review_suggestions where status = 'pending'"))!.n;
}

export async function listSuggestions(s: Session, status: string, q: string | null) {
  assertReviewer(s);
  const params: unknown[] = [];
  const where: string[] = [];
  if (status !== "all") { params.push(status); where.push(`s.status = $${params.length}`); }
  if (q) { params.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`); where.push(`(s.title ilike $${params.length} or s.excerpt ilike $${params.length} or coalesce(s.brief,'') ilike $${params.length})`); }
  const rows = await query<any>(`select ${COLS} from ${FROM} ${where.length ? `where ${where.join(" and ")}` : ""} order by s.posted_at desc limit 300`, params);
  return rows.map((r) => dto(r));
}

async function row(id: string, c?: pg.PoolClient, lock = false) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const sql = lock ? `select *, to_char(due_date,'YYYY-MM-DD') due_date_s from review_suggestions where id = $1 for update` : `select ${COLS} from ${FROM} where s.id = $1`;
  return c ? (await c.query(sql, [id])).rows[0] : await one<any>(sql, [id]);
}

export async function getSuggestion(s: Session, id: string) {
  assertReviewer(s);
  const r = await row(id);
  if (!r) throw notFound("Suggestion");
  const f = await query<any>("select posted_at, message_url, excerpt from review_followups where suggestion_id = $1 order by posted_at", [id]);
  return dto(r, f);
}

export const editSchema = z.object({
  version: z.number().int().min(1),
  title: txt(300).refine((v) => v.trim().length > 0, "required"),
  brief: txt(1500).nullable().optional(),
  business_id: z.enum(PLAN_BUSINESSES).nullable().optional(),
  tracker_brand_id: z.string().uuid().nullable().optional(),
  tracker_assignee_id: z.string().uuid().nullable().optional(),
  due_date: z.string().refine(isIsoDate, "must be a date").nullable().optional(),
}).strict();

async function dirOrNull(): Promise<Directory | null> {
  if (!planningTrackerConfigured()) return null;
  try { return await trackerDirectory(); } catch { return null; }
}

export async function editSuggestion(s: Session, id: string, v: z.infer<typeof editSchema>) {
  assertReviewer(s);
  // Brand and assignee are checked against Task Tracker's directory (the tracker checks again when the task is sent).
  let brandName: string | null = null, personName: string | null = null;
  if (v.tracker_brand_id || v.tracker_assignee_id) {
    if (!v.business_id || !v.tracker_brand_id || !v.tracker_assignee_id) throw badRequest("Choose the business, the Task Tracker brand and the assignee together.");
    const dir = await dirOrNull();
    if (!dir) throw new HttpError(503, "tracker_unavailable", "Task Tracker could not be reached to check the brand and assignee. Try again.");
    const chk = checkAgainstDirectory(dir, v.business_id, { brand_id: v.tracker_brand_id, assignee_id: v.tracker_assignee_id });
    if (!chk.ok) throw new HttpError(422, chk.code, chk.message);
    brandName = chk.brand.name; personName = chk.person.name;
  }
  await tx(async (c) => {
    const cur = await row(id, c, true);
    if (!cur) throw notFound("Suggestion");
    if (cur.version !== v.version) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload, then re-apply your edit.");
    if (cur.status === "dismissed") throw new HttpError(409, "dismissed", "This suggestion was dismissed.");
    if (["sending", "created", "unknown"].includes(cur.delivery_status)) throw new HttpError(409, "delivery_locked", "A Task Tracker task exists or may exist for this suggestion; change it in Task Tracker (or use Check Task Tracker first).");
    await c.query(`update review_suggestions set title = $2, brief = $3, business_id = $4, tracker_brand_id = $5, tracker_brand_name = $6, tracker_assignee_id = $7,
                     tracker_assignee_name = $8, due_date = $9, edited = true, updated_at = now(), version = version + 1 where id = $1`,
      [id, v.title.trim(), v.brief || null, v.business_id ?? null, v.tracker_brand_id ?? null, brandName, v.tracker_assignee_id ?? null, personName, v.due_date ?? null]);
  });
  return getSuggestion(s, id);
}

/** Exactly what Create task sends: nothing from Slack, only these fields. */
export async function previewSuggestion(s: Session, id: string) {
  assertReviewer(s);
  const r = await row(id);
  if (!r) throw notFound("Suggestion");
  const dir = await dirOrNull();
  const chk = dir && r.tracker_brand_id && r.tracker_assignee_id && r.business_id ? checkAgainstDirectory(dir, r.business_id, { brand_id: r.tracker_brand_id, assignee_id: r.tracker_assignee_id }) : null;
  return {
    id: r.id, version: r.version, status: r.status, delivery: r.delivery_status,
    send: { title: r.title, brief: r.brief ?? "", business: r.business_id ? BUSINESS_LABEL[r.business_id] : null, brand: r.tracker_brand_name, assignee: r.tracker_assignee_name, due_date: r.due_date },
    problems: [...needs(r), ...(chk && !chk.ok ? [chk.message] : [])],
    tracker_connected: planningTrackerConfigured(),
  };
}

/** Approve (if pending) and create the task. Concurrent clicks, duplicates and retries produce at most one task. */
export async function createFromSuggestion(s: Session, id: string, version: number) {
  assertReviewer(s);
  // One send per suggestion at a time; holding this, a leftover "sending" is an interrupted send (unresolved).
  const lockConn = await getPool().connect();
  const lock = (await lockConn.query("select pg_try_advisory_lock(hashtextextended($1, 13)) ok", [id])).rows[0];
  if (!lock?.ok) { lockConn.release(); throw new HttpError(409, "sending", "This task is being created right now. Wait a moment and reload."); }
  try {
    const claim = await tx(async (c) => {
      const cur = await row(id, c, true);
      if (!cur) throw notFound("Suggestion");
      if (cur.delivery_status === "created") return null;                       // already created: nothing to send
      if (cur.version !== version && !["sending", "unknown"].includes(cur.delivery_status)) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload before creating the task.");
      if (cur.status === "dismissed") throw new HttpError(409, "dismissed", "This suggestion was dismissed.");
      const missing = needs(cur);
      if (missing.length) throw new HttpError(422, "incomplete", `Before creating the task: ${missing.join("; ")}.`);
      // Recorded before Task Tracker is called; from here the suggestion cannot be edited or dismissed.
      await c.query(`update review_suggestions set status = 'approved', reviewed_at = coalesce(reviewed_at, now()), delivery_status = 'sending', delivery_error = null,
                       last_attempt_at = now(), updated_at = now(), version = version + 1 where id = $1`, [id]);
      return { cur, previous: cur.delivery_status as string, ...claimedTimes(cur) };
    });
    if (!claim) return { outcome: "created", existing: true, suggestion: await getSuggestion(s, id) };
    const { cur } = claim;
    if (!planningTrackerConfigured()) {
      if (claim.previous === "not_sent" || claim.previous === "failed") await setDelivery("review_suggestions", id, "failed", "Task Tracker is not connected.");
      else await setDelivery("review_suggestions", id, "unknown", "Task Tracker is not connected; retry once it is.");
      return { outcome: "failed", message: "Task Tracker is not connected.", suggestion: await getSuggestion(s, id) };
    }
    const r = await deliverClaimed("review_suggestions", { id, business: cur.business_id, previous: claim.previous, highestSentAt: claim.highestSentAt, fencedThrough: claim.fencedThrough,
      payload: { brand_id: cur.tracker_brand_id, assignee_id: cur.tracker_assignee_id, title: cur.title, brief: cur.brief ?? "", due_date: cur.due_date_s } },
      id, "review", await dirOrNull());
    return { outcome: r.outcome, existing: r.existing, code: r.code, message: r.message, suggestion: await getSuggestion(s, id) };
  } finally {
    await lockConn.query("select pg_advisory_unlock(hashtextextended($1, 13))", [id]).catch(() => {});
    lockConn.release();
  }
}

export async function dismissSuggestion(s: Session, id: string, version: number) {
  assertReviewer(s);
  await tx(async (c) => {
    const cur = await row(id, c, true);
    if (!cur) throw notFound("Suggestion");
    if (cur.version !== version) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload first.");
    if (!["not_sent", "failed"].includes(cur.delivery_status)) throw new HttpError(409, "delivery_locked", "A Task Tracker task exists or may exist for this suggestion, so it can't be dismissed.");
    // Kept (not deleted), so later scans recognise it and never bring it back.
    await c.query("update review_suggestions set status = 'dismissed', reviewed_at = now(), updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  return getSuggestion(s, id);
}

export async function refreshSuggestion(s: Session, id: string) {
  assertReviewer(s);
  const r = await row(id);
  if (!r) throw notFound("Suggestion");
  await reconcile("review_suggestions", [{ id: r.id, delivery_status: r.delivery_status }]);
  return getSuggestion(s, id);
}
