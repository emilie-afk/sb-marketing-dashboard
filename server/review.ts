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
import { loadOccasionIndex, matchSuggestion, storeMatch, placeOccasion, type OccasionIndex } from "./occasionLinks";

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
// Slack ts "seconds.micros" (always 6 decimals, validated by TS) compared exactly, not as floating point.
const tsNum = (ts: string) => BigInt(ts.replace(".", ""));

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
      // No gaps: once a checkpoint exists, a batch must have been read from at or before it (overlap is fine; rescans
      // never duplicate). Otherwise messages between the checkpoint and from_ts would be skipped for good.
      // Nothing is stored and the checkpoint stays where it was.
      if (st.checkpoint_ts && (!b.range.from_ts || tsNum(b.range.from_ts) > tsNum(st.checkpoint_ts)))
        throw new HttpError(409, "checkpoint_gap", "The batch must start at or before the saved checkpoint.", [{ field: "range.from_ts", message: `must be at or before ${st.checkpoint_ts}` }]);
      let created = 0, followups = 0, unchanged = 0;
      let idx: OccasionIndex | null = null;
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
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$12,$13,$14,$16) on conflict (source_key) do nothing returning id`,
          [key, channel, s.message_ts, s.thread_ts ?? null, s.posted_at, s.message_url ?? null, s.thread_url ?? null, s.excerpt, s.scanner_note ?? null, s.deadline_text ?? null, s.flags ?? [],
            s.title.trim(), s.brief ?? null, s.business ?? null, s.assignee_hint ?? null, s.due_date ?? null]);
        if (r.rowCount) {
          created++;
          // Suggest an occasion for the new suggestion only. An existing one keeps whatever the owner chose.
          idx ??= await loadOccasionIndex(c);
          await storeMatch(c, r.rows[0].id, matchSuggestion(idx, { title: s.title, brief: s.brief, excerpt: s.excerpt, deadline_text: s.deadline_text, business_id: s.business ?? null, due_date: s.due_date ?? null, posted_at: s.posted_at }));
        } else unchanged++;
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
  s.plan_id, s.plan_assignment_id, s.planned_at, mp.name plan_name, mp.status plan_status, pa.delivery_status plan_assignment_delivery,
  s.occasion_status, s.occasion_id, s.occasion_year, s.occasion_candidates, s.occasion_matched_at, s.occasion_confirmed_at, to_char(s.prep_date,'YYYY-MM-DD') prep_date, go.name occasion_name,
  r.status sync_status, to_char(r.due_date,'YYYY-MM-DD') sync_due_date, r.title sync_title, r.assignee_name sync_assignee_name, r.source_updated_at sync_updated_at, r.removed_at sync_removed_at`;
const FROM = `review_suggestions s left join tracker_task_records r on r.record_id = 'task:' || s.tracker_task_id::text and r.kind = 'task'
  left join marketing_plans mp on mp.id = s.plan_id left join plan_assignments pa on pa.id = s.plan_assignment_id left join gift_occasions go on go.id = s.occasion_id`;

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

/** The occasion link: the owner's choice (confirmed or cleared), or the matcher's suggestion and possible matches. */
function occasionOf(s: any, idx: OccasionIndex | null) {
  const where = (id: string, y: number) => (idx ? placeOccasion(idx, id, y) : null);
  return {
    status: s.occasion_status as string, confirmed: s.occasion_status === "confirmed", confirmed_at: s.occasion_confirmed_at,
    current: s.occasion_id ? { id: s.occasion_id, name: s.occasion_name, year: s.occasion_year, dates: where(s.occasion_id, s.occasion_year) } : null,
    candidates: s.occasion_status === "ambiguous" ? (s.occasion_candidates ?? []).map((c: any) => ({ ...c, dates: where(c.id, c.year) })) : [],
    prep_date: s.prep_date ?? null,
  };
}

function dto(s: any, followups: any[] = [], idx: OccasionIndex | null = null) {
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
    plan: s.status === "planned" ? { id: s.plan_id, name: s.plan_name ?? null, status: s.plan_status ?? null, planned_at: s.planned_at,
      // The plan's own item: removed if it was deleted from the plan (or the plan was deleted); otherwise its send state.
      item: s.plan_assignment_id ? { delivery: s.plan_assignment_delivery } : null } : null,
    locked: ["sending", "created", "unknown"].includes(s.delivery_status) || s.status === "planned",
    occasion: occasionOf(s, idx),
  };
}

export async function pendingCount(s: Session) {
  assertReviewer(s);
  return (await one<{ n: number }>("select count(*)::int n from review_suggestions where status = 'pending'"))!.n;
}

/** Suggests occasions for suggestions that were never matched (those from before matching existed). */
async function matchUnmatched(idx: OccasionIndex) {
  const rows = await query<any>(`select id, title, brief, excerpt, deadline_text, business_id, suggested_business, to_char(due_date,'YYYY-MM-DD') due_date,
                                         to_char(suggested_due_date,'YYYY-MM-DD') suggested_due_date, posted_at
                                    from review_suggestions where occasion_matched_at is null order by posted_at desc limit 500`);
  for (const r of rows) await tx((c) => storeMatch(c, r.id, matchSuggestion(idx, r)));
}

export async function listSuggestions(s: Session, status: string, q: string | null, occasion: "all" | "unclassified" | "classified" = "all") {
  assertReviewer(s);
  const idx = await loadOccasionIndex();
  await matchUnmatched(idx);
  const params: unknown[] = [];
  const where: string[] = [];
  if (status !== "all") { params.push(status); where.push(`s.status = $${params.length}`); }
  if (occasion === "unclassified") where.push(`s.occasion_status <> 'confirmed'`);
  if (occasion === "classified") where.push(`s.occasion_status = 'confirmed'`);
  if (q) { params.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`); where.push(`(s.title ilike $${params.length} or s.excerpt ilike $${params.length} or coalesce(s.brief,'') ilike $${params.length})`); }
  const rows = await query<any>(`select ${COLS} from ${FROM} ${where.length ? `where ${where.join(" and ")}` : ""} order by s.posted_at desc limit 300`, params);
  return rows.map((r) => dto(r, [], idx));
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
  return dto(r, f, await loadOccasionIndex());
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
    if (cur.status === "resolved") throw new HttpError(409, "resolved", RESOLVED_MSG);
    if (cur.status === "planned") throw new HttpError(409, "planned", PLANNED_MSG);
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
      if (cur.status === "resolved") throw new HttpError(409, "resolved", RESOLVED_MSG);
      if (cur.status === "planned") throw new HttpError(409, "planned", PLANNED_MSG);
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
    if (cur.status === "planned") throw new HttpError(409, "planned", PLANNED_MSG);
    // Kept (not deleted), so later scans recognise it and never bring it back.
    await c.query("update review_suggestions set status = 'dismissed', reviewed_at = now(), updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  return getSuggestion(s, id);
}

const RESOLVED_MSG = "This suggestion was resolved (handled without a task).";

/**
 * Resolve: handled, no task. Leaves "To review"; later scans never bring it back. Nothing is sent anywhere. Holds the
 * same per-suggestion lock as Create task, so the two never interleave; if a task exists or may exist, Task Tracker is
 * checked first and an existing task wins (its status and link are shown; completion belongs to it).
 */
export async function resolveSuggestion(s: Session, id: string, version: number) {
  assertReviewer(s);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Suggestion");
  const lockConn = await getPool().connect();
  const lock = (await lockConn.query("select pg_try_advisory_lock(hashtextextended($1, 13)) ok", [id])).rows[0];
  if (!lock?.ok) { lockConn.release(); throw new HttpError(409, "sending", "This task is being created right now. Wait for the result, then decide."); }
  try {
    const pre = await one<any>("select version, delivery_status from review_suggestions where id = $1", [id]);
    if (!pre) throw notFound("Suggestion");
    if (pre.version !== version) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload first.");
    if (["sending", "unknown", "created"].includes(pre.delivery_status) && planningTrackerConfigured())
      await reconcile("review_suggestions", [{ id, delivery_status: pre.delivery_status === "created" ? "created" : "unknown" }]).catch(() => {});
    await tx(async (c) => {
      const cur = await row(id, c, true);
      if (cur.status === "planned") throw new HttpError(409, "planned", PLANNED_MSG);
      if (cur.delivery_status === "created") throw new HttpError(409, "task_exists", `This suggestion is already a Task Tracker task (${cur.tracker_status ?? "open"}). Complete or close it there.`);
      if (["sending", "unknown"].includes(cur.delivery_status))
        throw new HttpError(409, "delivery_unsettled", "Its last send got no answer and Task Tracker has no task for it yet, so that send could still arrive. Retry settles it (never a second task).");
      if (!["pending", "approved"].includes(cur.status))
        throw new HttpError(409, "not_open", cur.status === "resolved" ? "Already resolved." : "Only a suggestion still to review (or one whose task was never created) can be resolved.");
      await c.query("update review_suggestions set status = 'resolved', reviewed_at = now(), updated_at = now(), version = version + 1 where id = $1", [id]);
    });
  } finally {
    await lockConn.query("select pg_advisory_unlock(hashtextextended($1, 13))", [id]).catch(() => {});
    lockConn.release();
  }
  return getSuggestion(s, id);
}

export const classifySchema = z.object({
  version: z.number().int().min(1),
  // null clears the link; omitted leaves it as it is.
  occasion: z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/), year: z.number().int().min(2000).max(2100) }).strict().nullable().optional(),
  prep_date: z.string().refine(isIsoDate, "must be a date").nullable().optional(),
}).strict();

/**
 * Set, change, confirm or clear the occasion (and the manual prep date). Only the link changes: nothing is published,
 * no task is created, and the review status is untouched. Later scans never overwrite it.
 */
export async function classifySuggestion(s: Session, id: string, v: z.infer<typeof classifySchema>) {
  assertReviewer(s);
  await tx(async (c) => {
    const cur = await row(id, c, true);
    if (!cur) throw notFound("Suggestion");
    if (cur.version !== v.version) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload first.");
    if (v.occasion !== undefined) {
      if (v.occasion) {
        const o = (await c.query("select kind, (select array_agg(business_id) from gift_occasion_brands b where b.occasion_id = o.id) brands from gift_occasions o where id = $1 and active", [v.occasion.id])).rows[0];
        if (!o || o.kind !== "dated") throw badRequest("Choose a dated occasion.");
        const biz = cur.business_id ?? cur.suggested_business;
        if (biz && !(o.brands ?? []).includes(biz)) throw badRequest("That occasion does not apply to this suggestion's business.");
        await c.query(`update review_suggestions set occasion_status = 'confirmed', occasion_id = $2, occasion_year = $3, occasion_confirmed_at = now(), occasion_matched_at = coalesce(occasion_matched_at, now())
                        where id = $1`, [id, v.occasion.id, v.occasion.year]);
      } else {
        await c.query(`update review_suggestions set occasion_status = 'cleared', occasion_id = null, occasion_year = null, occasion_confirmed_at = now(), occasion_matched_at = coalesce(occasion_matched_at, now())
                        where id = $1`, [id]);
      }
    }
    if (v.prep_date !== undefined) await c.query("update review_suggestions set prep_date = $2 where id = $1", [id, v.prep_date]);
    await c.query("update review_suggestions set updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  return getSuggestion(s, id);
}

const PLANNED_MSG = "This suggestion is in a marketing plan. Change or remove it in the plan.";

export const addToPlanSchema = z.object({ version: z.number().int().min(1), plan_id: z.string().uuid() }).strict();

/** Draft plans a suggestion can go into: the owner's draft plans for the suggestion's business. */
export async function planChoices(s: Session, id: string) {
  assertReviewer(s);
  const r = await row(id);
  if (!r) throw notFound("Suggestion");
  if (!r.business_id) return { business: null, plans: [] };
  const linked = r.occasion_status === "confirmed" ? { id: r.occasion_id, year: r.occasion_year } : null;
  const rows = await query<any>(`select p.id, p.name, to_char(p.prep_start,'YYYY-MM-DD') prep_start, to_char(p.campaign_start,'YYYY-MM-DD') campaign_start, to_char(p.campaign_end,'YYYY-MM-DD') campaign_end,
                                        p.gift_occasion_id, p.occurrence_year, g.name occasion_name, p.categories
                                   from marketing_plans p left join gift_occasions g on g.id = p.gift_occasion_id
                                  where p.status = 'draft' and p.business_id = $1 order by p.campaign_start, p.name limit 200`, [r.business_id]);
  // Plans for the suggestion's confirmed occasion first; a plan linked to another occasion carries a warning.
  const plans = rows.map((p) => ({ id: p.id, name: p.name, prep_start: p.prep_start, campaign_start: p.campaign_start, campaign_end: p.campaign_end, categories: p.categories ?? [],
    occasion: p.gift_occasion_id ? { id: p.gift_occasion_id, name: p.occasion_name, year: p.occurrence_year } : null,
    match: !linked ? "none" : p.gift_occasion_id === linked.id && p.occurrence_year === linked.year ? "same" : p.gift_occasion_id ? "different" : "none" }));
  const rank = (m: string) => (m === "same" ? 0 : m === "none" ? 1 : 2);
  plans.sort((a, b) => rank(a.match) - rank(b.match));
  return { business: r.business_id, occasion: linked ? { ...linked, name: r.occasion_name } : null, plans };
}

/**
 * Add to plan: the approved fields become an assignment in one of the owner's DRAFT plans. Nothing is sent to Task
 * Tracker (the plan sends it only when it is published), and the item stays private while the plan is a draft. The
 * Slack excerpt, links and notes are not copied. Later scans never reopen it.
 */
export async function addToPlan(s: Session, id: string, v: z.infer<typeof addToPlanSchema>) {
  assertReviewer(s);
  const dir = await dirOrNull();
  await tx(async (c) => {
    const cur = await row(id, c, true);
    if (!cur) throw notFound("Suggestion");
    if (cur.version !== v.version) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload first.");
    if (cur.status !== "pending" || cur.delivery_status !== "not_sent") throw new HttpError(409, "not_pending", "Only a suggestion still to review can be added to a plan.");
    const missing = needs(cur);
    if (missing.length) throw new HttpError(422, "incomplete", `Before adding it to a plan: ${missing.join("; ")}.`);
    const plan = (await c.query("select id, business_id, status from marketing_plans where id = $1 for update", [v.plan_id])).rows[0];
    if (!plan) throw notFound("Plan");
    if (plan.status !== "draft") throw new HttpError(409, "plan_published", "Choose a draft plan. A published plan is visible to the team and sends its tasks.");
    if (plan.business_id !== cur.business_id) throw badRequest("That plan belongs to another business.");
    let brandName = cur.tracker_brand_name, personName = cur.tracker_assignee_name;
    if (dir) {
      const chk = checkAgainstDirectory(dir, cur.business_id, { brand_id: cur.tracker_brand_id, assignee_id: cur.tracker_assignee_id });
      if (!chk.ok) throw new HttpError(422, chk.code, chk.message);
      brandName = chk.brand.name; personName = chk.person.name;
    }
    if (!brandName || !personName) throw new HttpError(503, "tracker_unavailable", "Task Tracker could not be reached to check the brand and assignee. Try again.");
    const a = await c.query(`insert into plan_assignments (plan_id, sort_order, title, brief, tracker_brand_id, tracker_brand_name, tracker_assignee_id, tracker_assignee_name, due_date)
                             values ($1, (select coalesce(max(sort_order), -1) + 1 from plan_assignments where plan_id = $1), $2, $3, $4, $5, $6, $7, $8) returning id`,
      [plan.id, cur.title, cur.brief, cur.tracker_brand_id, brandName, cur.tracker_assignee_id, personName, cur.due_date_s]);
    // The plan changed: an editor still open on the old version must reload instead of overwriting the new item.
    await c.query("update marketing_plans set updated_at = now(), version = version + 1 where id = $1", [plan.id]);
    await c.query(`update review_suggestions set status = 'planned', plan_id = $2, plan_assignment_id = $3, planned_at = now(), reviewed_at = coalesce(reviewed_at, now()),
                     updated_at = now(), version = version + 1 where id = $1`, [id, plan.id, a.rows[0].id]);
  });
  return getSuggestion(s, id);
}

/** A planned suggestion whose plan item was removed (or whose plan was deleted) can come back to the review list. */
export async function returnToReview(s: Session, id: string, version: number) {
  assertReviewer(s);
  await tx(async (c) => {
    const cur = await row(id, c, true);
    if (!cur) throw notFound("Suggestion");
    if (cur.version !== version) throw new HttpError(409, "conflict", "This suggestion changed in another window. Reload first.");
    if (cur.status !== "planned") throw new HttpError(409, "not_planned", "This suggestion is not in a plan.");
    if (cur.plan_assignment_id) throw new HttpError(409, "still_planned", "It is still in the plan. Remove it from the plan first.");
    await c.query(`update review_suggestions set status = 'pending', plan_id = null, planned_at = null, updated_at = now(), version = version + 1 where id = $1`, [id]);
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
