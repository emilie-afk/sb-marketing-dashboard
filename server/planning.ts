// Marketing Planning: plans owned by the dashboard, with assigned tasks created in Task Tracker (which owns them).
//
// Access (enforced here, for every list, detail, search, calendar badge, count, direct link and write):
// - The planning owner is the account whose verified sign-in email equals PLANNING_OWNER_EMAIL. Only the owner sees
//   the full timeline and drafts, creates, edits and publishes plans, and sends assignments to Task Tracker.
//   Without that setting nobody has those rights.
// - Everyone else signed in (dashboard admins included) sees published plans whose prep starts from today through
//   three calendar months from today, plus published plans whose prep has started and whose campaign ends today or
//   later (Vietnam dates). Drafts and ended plans are the owner's only. A hidden plan answers 404, exactly like a
//   plan that does not exist.
import type pg from "pg";
import { query, one, tx, getPool } from "./db";
import { HttpError, badRequest, notFound } from "./http";
import type { Session } from "./auth";
import { addDays, daysInMonth, todayIn, OPERATIONS_TZ, isIsoDate, formatRange } from "../shared/dates";
import { createTrackerTask, sentAtNow, readTrackerTasks, changeTrackerDueDate, trackerDirectory, planningTrackerConfigured, type TrackerTask, type Directory } from "./adapters/planningClient";
import { trackerOrigin } from "./adapters/taskTracker";
import { deliverClaimed, checkAgainstDirectory, idempotencyKey, storeTask as storeTaskIn, setDelivery as setDeliveryIn, reviewSources } from "./trackerDelivery";
import type { Sources } from "./adapters/planningClient";
const planSources = (sourceKey: string | undefined): Sources | null => { const r = reviewSources(sourceKey); return r ? { ...r, source_workflow: "plan" } : null; };

export const CHANNELS = ["Email", "Facebook", "Instagram", "LinkedIn", "Pinterest", "TikTok", "YouTube", "Google Ads", "Website", "Amazon", "Etsy", "Faire", "PR", "Other"] as const;
export const PLAN_BUSINESSES = ["sb", "p2s", "perksradar"] as const;
export const BUSINESS_LABEL: Record<string, string> = { sb: "Succulents Box", p2s: "P2S", perksradar: "Perksradar" };

// ------------------------------------------------------------ who and when
export function planningOwnerEmail(): string | null {
  const v = (process.env.PLANNING_OWNER_EMAIL ?? "").trim().toLowerCase();
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v) ? v : null;
}
/** The session email was verified by Google at sign-in (email_verified) and is re-checked against the allowlist. */
export const isPlanningOwner = (s: Session) => { const o = planningOwnerEmail(); return !!o && s.email.trim().toLowerCase() === o; };
export function assertOwner(s: Session) {
  if (!isPlanningOwner(s)) throw new HttpError(403, "forbidden", planningOwnerEmail() ? "Only the planning owner can change plans." : "Planning is not set up (PLANNING_OWNER_EMAIL).");
}

let clock: (() => Date) | null = null;
export function _setPlanningClockForTests(f: (() => Date) | null) { clock = f; }
export const planningToday = () => todayIn(OPERATIONS_TZ, clock ? clock() : new Date());

/** The same day three calendar months later (clamped to the month's last day: Nov 30 → Feb 28). */
export function addCalendarMonths(d: string, n: number) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)), day = Number(d.slice(8, 10));
  const i = y * 12 + (m - 1) + n, ny = Math.floor(i / 12), nm = (i % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, daysInMonth(ny, nm))).padStart(2, "0")}`;
}
export function teamWindow(today = planningToday()) { return { from: today, to: addCalendarMonths(today, 3) }; }

/** SQL condition on plans (alias p) limiting them to what this person may see. Pushes its parameters. */
export function visibleSql(s: Session, params: unknown[], alias = "p") {
  if (isPlanningOwner(s)) return "true";
  const w = teamWindow();
  params.push(w.from, w.to);
  const a = `$${params.length - 1}::date`, b = `$${params.length}::date`;
  return `(${alias}.status = 'published' and ((${alias}.prep_start between ${a} and ${b}) or (${alias}.prep_start < ${a} and ${alias}.campaign_end >= ${a})))`;
}
/** In-memory version of visibleSql for a single plan row (same rule). */
export function visibleTo(s: Session, p: { status: string; prep_start: string; campaign_end: string }) {
  if (isPlanningOwner(s)) return true;
  const w = teamWindow();
  return p.status === "published" && ((p.prep_start >= w.from && p.prep_start <= w.to) || (p.prep_start < w.from && p.campaign_end >= w.from));
}

/** Delivery states in which a Task Tracker task exists or may exist: the assignment is locked to its id. */
export const LOCKED_DELIVERY = ["sending", "created", "unknown"];

// ------------------------------------------------------------ reading
const PLAN_COLS = `p.id, p.business_id, p.name, p.gift_occasion_id, p.occurrence_year, p.sheet_occasion_id, p.promotion_id,
  to_char(p.prep_start,'YYYY-MM-DD') prep_start, to_char(p.campaign_start,'YYYY-MM-DD') campaign_start, to_char(p.campaign_end,'YYYY-MM-DD') campaign_end,
  p.objective, p.channels, p.categories, p.target_audience, p.message_angle, p.deliverables, p.notes, p.status, p.published_at, p.created_by, p.created_at, p.updated_at, p.version,
  g.name gift_occasion_name, o.name sheet_occasion_name, to_char(o.occasion_date,'YYYY-MM-DD') sheet_occasion_date, pr.title promotion_title`;
const PLAN_FROM = `marketing_plans p left join gift_occasions g on g.id = p.gift_occasion_id left join occasions o on o.id = p.sheet_occasion_id left join promotions pr on pr.id = p.promotion_id`;

const ASG_COLS = `a.id, a.plan_id, a.sort_order, a.title, a.brief, a.send_to_tracker, a.tracker_brand_id, a.tracker_brand_name, a.tracker_assignee_id, a.tracker_assignee_name,
  to_char(a.due_date,'YYYY-MM-DD') due_date, a.delivery_status, a.delivery_error, a.last_attempt_at, a.tracker_task_id, a.tracker_version, a.tracker_title,
  to_char(a.tracker_due_date,'YYYY-MM-DD') tracker_due_date, a.tracker_status, a.tracker_assignee_name_now, a.tracker_updated_at, a.tracker_read_at,
  r.status sync_status, to_char(r.due_date,'YYYY-MM-DD') sync_due_date, r.title sync_title, r.assignee_name sync_assignee_name, r.source_updated_at sync_updated_at, r.removed_at sync_removed_at`;

async function assignmentsOf(planIds: string[], db: pg.Pool | pg.PoolClient | undefined = undefined) {
  if (!planIds.length) return [];
  return query<any>(`select ${ASG_COLS} from plan_assignments a
                       left join tracker_task_records r on r.record_id = 'task:' || a.tracker_task_id::text and r.kind = 'task'
                      where a.plan_id = any($1::uuid[]) order by a.plan_id, a.sort_order, a.created_at`, [planIds], db as any);
}

/**
 * The task's current state for the plan: the newer of what Task Tracker told us directly (creation, retry, check)
 * and what the reporting sync last published. A task created moments ago stays visible before the next snapshot.
 */
export function taskView(a: any) {
  if (a.delivery_status !== "created") return null;
  const direct = { status: a.tracker_status, due_date: a.tracker_due_date, title: a.tracker_title, assignee: a.tracker_assignee_name_now, at: a.tracker_updated_at ? new Date(a.tracker_updated_at).getTime() : 0, source: "tracker" };
  const synced = a.sync_status && !a.sync_removed_at ? { status: a.sync_status, due_date: a.sync_due_date, title: a.sync_title, assignee: a.sync_assignee_name, at: a.sync_updated_at ? new Date(a.sync_updated_at).getTime() : 0, source: "sync" } : null;
  const v = synced && synced.at >= direct.at ? synced : direct;
  const o = trackerOrigin();
  return {
    task_id: a.tracker_task_id, status: a.sync_removed_at && v === direct && direct.status !== "deleted" ? direct.status : v.status, due_date: v.due_date, title: v.title, assignee: v.assignee,
    as_of: v.at ? new Date(v.at).toISOString() : null, from: v.source, open_url: o ? `${o}/#/tasks/${a.tracker_task_id}` : null,
    removed_from_sync: !!a.sync_removed_at, version_read: a.tracker_version, read_at: a.tracker_read_at,
  };
}

function assignmentDto(a: any) {
  return {
    id: a.id, title: a.title, brief: a.brief, due_date: a.due_date, sort_order: a.sort_order,
    // send: false = the item stays in the Marketing Dashboard (never sent to Task Tracker); brand/assignee/due are optional then.
    send: a.send_to_tracker !== false,
    brand: a.tracker_brand_id ? { id: a.tracker_brand_id, name: a.tracker_brand_name } : null,
    assignee: a.tracker_assignee_id ? { id: a.tracker_assignee_id, name: a.tracker_assignee_name } : null,
    delivery: { status: a.delivery_status, error: a.delivery_error, last_attempt_at: a.last_attempt_at },
    task: taskView(a),
  };
}

function planDto(p: any, assignments: any[], full: boolean) {
  const base = {
    id: p.id, business_id: p.business_id, business: BUSINESS_LABEL[p.business_id] ?? p.business_id, name: p.name, status: p.status, published_at: p.published_at,
    prep_start: p.prep_start, campaign_start: p.campaign_start, campaign_end: p.campaign_end, channels: p.channels, categories: p.categories ?? [],
    occasion: p.gift_occasion_id ? { kind: "gift", id: p.gift_occasion_id, name: p.gift_occasion_name, year: p.occurrence_year }
      : p.sheet_occasion_id ? { kind: "sheet", id: p.sheet_occasion_id, name: p.sheet_occasion_name, date: p.sheet_occasion_date } : null,
    promotion: p.promotion_id ? { id: p.promotion_id, title: p.promotion_title } : null,
    objective: p.objective, target_audience: p.target_audience, message_angle: p.message_angle, deliverables: p.deliverables, notes: p.notes,
    version: p.version, updated_at: p.updated_at,
    assignments: assignments.map(assignmentDto),
    task_count: assignments.filter((a) => a.delivery_status === "created").length,
    pending_count: assignments.filter((a) => a.send_to_tracker !== false && a.delivery_status !== "created").length,
    local_count: assignments.filter((a) => a.send_to_tracker === false).length,
    unresolved_count: assignments.filter((a) => a.delivery_status === "sending" || a.delivery_status === "unknown").length,
  };
  if (full) return base;
  // Team view (published plans in the window): the plan as published; no delivery internals.
  // Items kept in the dashboard are part of the published plan too; items still waiting to be sent are not shown.
  return { ...base, assignments: base.assignments.filter((a) => a.task || !a.send).map(({ delivery, ...a }) => ({ ...a, task: a.task && { ...a.task, version_read: undefined, read_at: undefined } })), pending_count: undefined, unresolved_count: undefined, version: undefined };
}

export type PlanFilters = { year?: number | null; business?: string | null; channel?: string | null; category?: string | null; status?: string | null; q?: string | null; occasion?: { gift?: string; year?: number; sheet?: string[] } | null };

export async function listPlans(s: Session, f: PlanFilters = {}) {
  const params: unknown[] = [];
  const where = [visibleSql(s, params)];
  if (f.year) { params.push(f.year); where.push(`(extract(year from p.campaign_start) = $${params.length} or extract(year from p.prep_start) = $${params.length} or p.occurrence_year = $${params.length})`); }
  if (f.business) { params.push(f.business); where.push(`p.business_id = $${params.length}`); }
  if (f.channel) { params.push(f.channel); where.push(`$${params.length} = any(p.channels)`); }
  if (f.category) { params.push(f.category); where.push(`$${params.length} = any(p.categories)`); }
  if (f.status && isPlanningOwner(s)) { params.push(f.status); where.push(`p.status = $${params.length}`); }
  if (f.q) { params.push(`%${f.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`); where.push(`(p.name ilike $${params.length} or coalesce(g.name, o.name, '') ilike $${params.length})`); }
  const rows = await query<any>(`select ${PLAN_COLS} from ${PLAN_FROM} where ${where.join(" and ")} order by p.prep_start, p.campaign_start, p.name limit 500`, params);
  const asg = await assignmentsOf(rows.map((r) => r.id));
  const full = isPlanningOwner(s);
  return rows.map((p) => planDto(p, asg.filter((a) => a.plan_id === p.id), full));
}

export async function getPlan(s: Session, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Plan");
  const params: unknown[] = [id];
  const p = await one<any>(`select ${PLAN_COLS} from ${PLAN_FROM} where p.id = $1 and ${visibleSql(s, params)}`, params);
  if (!p) throw notFound("Plan");   // hidden and missing plans answer the same
  return planDto(p, await assignmentsOf([p.id]), isPlanningOwner(s));
}

/**
 * Plans per occasion for calendar badges and occasion details, filtered by the viewer's visibility.
 * Keys: "gift:<id>:<year>" and "sheet:<occasion uuid>".
 */
export async function plansByOccasion(s: Session, years: number[], sheetIds: string[]) {
  const params: unknown[] = [years, sheetIds];
  const rows = await query<any>(
    `select p.id, p.name, p.business_id, p.status, p.gift_occasion_id, p.occurrence_year, p.sheet_occasion_id,
            to_char(p.prep_start,'YYYY-MM-DD') prep_start, to_char(p.campaign_start,'YYYY-MM-DD') campaign_start, to_char(p.campaign_end,'YYYY-MM-DD') campaign_end,
            (select count(*)::int from plan_assignments a where a.plan_id = p.id and a.delivery_status = 'created') task_count
       from marketing_plans p
      where ((p.gift_occasion_id is not null and p.occurrence_year = any($1::int[])) or p.sheet_occasion_id = any($2::uuid[])) and ${visibleSql(s, params)}
      order by p.business_id, p.campaign_start, p.name`, params);
  const out = new Map<string, any[]>();
  for (const r of rows) {
    const k = r.gift_occasion_id ? `gift:${r.gift_occasion_id}:${r.occurrence_year}` : `sheet:${r.sheet_occasion_id}`;
    out.set(k, [...(out.get(k) ?? []), { id: r.id, name: r.name, business: r.business_id, status: r.status, task_count: r.task_count, campaign_start: r.campaign_start, campaign_end: r.campaign_end, prep_start: r.prep_start }]);
  }
  return out;
}

// ------------------------------------------------------------ writing (owner only)
/** send_to_tracker omitted = true (as before). Brand, assignee and due date are required only for an item to send. */
export type AsgInput = { id?: string; title: string; brief?: string | null; send_to_tracker?: boolean; tracker_brand_id?: string | null; tracker_assignee_id?: string | null; due_date?: string | null };
export type PlanInput = {
  business_id: string; name: string; gift_occasion_id?: string | null; occurrence_year?: number | null; sheet_occasion_id?: string | null; promotion_id?: string | null;
  prep_start: string; campaign_start: string; campaign_end: string; objective?: string | null; channels?: string[]; categories?: string[]; target_audience?: string | null;
  message_angle?: string | null; deliverables?: string | null; notes?: string | null; assignments?: AsgInput[];
};

/** Product categories on a plan: trimmed, de-duplicated (ignoring case), at most 10. */
export function cleanCategories(list: string[] | undefined) {
  const out: string[] = [];
  for (const c of list ?? []) { const t = c.trim().replace(/\s+/g, " "); if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); }
  return out.slice(0, 10);
}

/** Category choices: the existing product categories (reused), plus categories already used on plans this person may see. */
export async function categoryOptions(s: Session) {
  const params: unknown[] = [];
  const rows = await query<{ c: string; src: string }>(
    `select distinct btrim(category) c, 'product' src from products where category is not null and btrim(category) <> ''
     union select distinct unnest(p.categories) c, 'plan' src from marketing_plans p where ${visibleSql(s, params)}`, params);
  const by = new Map<string, { name: string; product: boolean }>();
  for (const r of rows) { const k = r.c.toLowerCase(); const cur = by.get(k) ?? { name: r.c, product: false }; if (r.src === "product") { cur.product = true; cur.name = r.c; } by.set(k, cur); }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function checkLinks(c: pg.PoolClient, v: PlanInput) {
  if (v.gift_occasion_id) {
    const g = (await c.query("select kind, (select array_agg(business_id) from gift_occasion_brands b where b.occasion_id = o.id) brands from gift_occasions o where id = $1 and active", [v.gift_occasion_id])).rows[0];
    if (!g) throw badRequest("Unknown occasion.");
    if (!(g.brands ?? []).includes(v.business_id)) throw badRequest("That occasion does not apply to this brand.");
    if (g.kind === "dated" && !v.occurrence_year) throw badRequest("Choose the occurrence year of the occasion.");
    if (g.kind !== "dated" && v.occurrence_year) throw badRequest("A year-round occasion has no occurrence year.");
  } else if (v.occurrence_year) throw badRequest("An occurrence year needs an occasion.");
  if (v.sheet_occasion_id) {
    const o = (await c.query("select business_id from occasions where id = $1", [v.sheet_occasion_id])).rows[0];
    if (!o) throw badRequest("Unknown spreadsheet occasion.");
    if (v.gift_occasion_id) throw badRequest("Link either a gift occasion or a spreadsheet occasion, not both.");
  }
  if (v.promotion_id) {
    const p = (await c.query("select business_id from promotions where id = $1", [v.promotion_id])).rows[0];
    if (!p) throw badRequest("Unknown promotion.");
    if (p.business_id !== v.business_id) throw badRequest("That promotion belongs to another brand.");
  }
}

/** Directory used to name and pre-check Tracker brands and people. Assignments are checked again by the tracker. */
async function directoryOrNull(): Promise<Directory | null> {
  if (!planningTrackerConfigured()) return null;
  try { return await trackerDirectory(); } catch { return null; }
}

function checkAssignmentAgainst(dir: Directory, business: string, a: { tracker_brand_id: string; tracker_assignee_id: string }) {
  return checkAgainstDirectory(dir, business, { brand_id: a.tracker_brand_id, assignee_id: a.tracker_assignee_id });
}

/**
 * Names the Task Tracker brand and person chosen for a plan item, checked against Task Tracker's directory when it can
 * be read (otherwise the names already stored for the same ids are kept). An item to send needs all of brand, assignee
 * and due date; an item kept in the dashboard needs none, and its assignee (if any) only has to work for the business.
 */
export function nameItem(dir: Directory | null, business: string, a: AsgInput, cur?: { tracker_brand_id: string | null; tracker_brand_name: string | null; tracker_assignee_id: string | null; tracker_assignee_name: string | null }) {
  const send = a.send_to_tracker !== false;
  const brandId = a.tracker_brand_id || null, personId = a.tracker_assignee_id || null, due = a.due_date || null;
  if (send) {
    const miss = [!brandId && "the Task Tracker brand", !personId && "the assignee", !due && "the due date"].filter(Boolean);
    if (miss.length) throw new HttpError(422, "incomplete", `"${a.title}": to send it to Task Tracker, choose ${miss.join(", ")} (or keep it in the dashboard).`);
  }
  let brandName = brandId && cur?.tracker_brand_id === brandId ? cur.tracker_brand_name : null;
  let personName = personId && cur?.tracker_assignee_id === personId ? cur.tracker_assignee_name : null;
  if (dir) {
    if (brandId && personId) {
      const chk = checkAssignmentAgainst(dir, business, { tracker_brand_id: brandId, tracker_assignee_id: personId });
      if (!chk.ok) throw new HttpError(422, chk.code, `"${a.title}": ${chk.message}`);
      brandName = chk.brand.name; personName = chk.person.name;
    } else if (brandId) {
      const b = dir.brands.find((x) => x.id === brandId);
      if (!b || b.business_id !== business) throw new HttpError(422, "invalid_brand", `"${a.title}": that Task Tracker brand is not available for this business.`);
      brandName = b.name;
    } else if (personId) {
      const ids = dir.brands.filter((b) => b.business_id === business).map((b) => b.id);
      const p = dir.people.find((x) => x.id === personId && x.brand_ids.some((id) => ids.includes(id)));
      if (!p) throw new HttpError(422, "invalid_assignee", `"${a.title}": that person does not work on this business in Task Tracker.`);
      personName = p.name;
    }
  }
  if ((brandId && !brandName) || (personId && !personName))
    throw new HttpError(503, "tracker_unavailable", send ? "Task Tracker could not be reached to check the brand and assignee. Try again."
      : "Task Tracker's people list could not be read to name the assignee. Try again, or leave the assignee empty for now.");
  return { send, brandId, brandName, personId, personName, due };
}

async function writeAssignments(c: pg.PoolClient, planId: string, business: string, list: AsgInput[], dir: Directory | null) {
  const existing = (await c.query(`select id, delivery_status, title, brief, send_to_tracker, tracker_brand_id, tracker_assignee_id, to_char(due_date,'YYYY-MM-DD') due_date, tracker_brand_name, tracker_assignee_name
                                     from plan_assignments where plan_id = $1`, [planId])).rows;
  const byId = new Map(existing.map((a: any) => [a.id, a]));
  const keep = new Set<string>();
  const differs = (cur: any, a: AsgInput) => cur.title !== a.title || (cur.brief ?? "") !== (a.brief ?? "") || cur.send_to_tracker !== (a.send_to_tracker !== false)
    || cur.tracker_brand_id !== (a.tracker_brand_id || null) || cur.tracker_assignee_id !== (a.tracker_assignee_id || null) || cur.due_date !== (a.due_date || null);
  for (const [i, a] of list.entries()) {
    const cur = a.id ? byId.get(a.id) : undefined;
    if (a.id && !cur) throw badRequest("An assignment does not belong to this plan.");
    if (cur && (cur.delivery_status === "sending" || cur.delivery_status === "unknown")) {
      // The task may already exist in Task Tracker under this id: nothing about it may change until that is settled.
      if (differs(cur, a))
        throw new HttpError(409, "delivery_unresolved", `"${cur.title}" is being sent to Task Tracker, or its last send got no answer. Use Retry or Check Task Tracker before changing it.`);
      await c.query("update plan_assignments set sort_order = $2 where id = $1", [cur.id, i]);
      keep.add(cur.id); continue;
    }
    if (cur?.delivery_status === "created") {
      // Task Tracker owns a created task: its title, brief, brand and assignee change there. The deadline has its own action.
      if (differs(cur, a))
        throw new HttpError(409, "task_owned_by_tracker", `"${cur.title}" is already a Task Tracker task. Change it in Task Tracker (or use "Update deadline").`);
      await c.query("update plan_assignments set sort_order = $2 where id = $1", [cur.id, i]);
      keep.add(cur.id); continue;
    }
    const n = nameItem(dir, business, a, cur);
    // An item switched to "keep in the dashboard" forgets an earlier refused send.
    const vals = [i, a.title, a.brief || null, n.send, n.brandId, n.brandName, n.personId, n.personName, n.due];
    if (cur) {
      await c.query(`update plan_assignments set sort_order = $2, title = $3, brief = $4, send_to_tracker = $5, tracker_brand_id = $6, tracker_brand_name = $7, tracker_assignee_id = $8,
                       tracker_assignee_name = $9, due_date = $10, delivery_status = case when $5 then delivery_status else 'not_sent' end,
                       delivery_error = case when $5 then delivery_error else null end where id = $1`, [cur.id, ...vals]);
      keep.add(cur.id);
    } else {
      const r = await c.query(`insert into plan_assignments (plan_id, sort_order, title, brief, send_to_tracker, tracker_brand_id, tracker_brand_name, tracker_assignee_id, tracker_assignee_name, due_date)
                               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [planId, ...vals]);
      keep.add(r.rows[0].id);
    }
  }
  for (const a of existing) if (!keep.has(a.id)) {
    if (a.delivery_status === "created") throw new HttpError(409, "task_owned_by_tracker", `"${a.title}" is already a Task Tracker task and cannot be removed from the plan. Delete or reassign it in Task Tracker.`);
    if (a.delivery_status === "sending" || a.delivery_status === "unknown") throw new HttpError(409, "delivery_unresolved", `"${a.title}" is being sent to Task Tracker, or its last send got no answer, so it cannot be removed. Use Retry or Check Task Tracker first.`);
    await c.query("delete from plan_assignments where id = $1", [a.id]);
  }
}

export async function createPlan(s: Session, v: PlanInput) {
  assertOwner(s);
  const dir = v.assignments?.length ? await directoryOrNull() : null;
  const id = await tx(async (c) => {
    await checkLinks(c, v);
    const r = await c.query(`insert into marketing_plans (business_id, name, gift_occasion_id, occurrence_year, sheet_occasion_id, promotion_id, prep_start, campaign_start, campaign_end,
                               objective, channels, target_audience, message_angle, deliverables, notes, created_by, categories)
                             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [v.business_id, v.name, v.gift_occasion_id ?? null, v.occurrence_year ?? null, v.sheet_occasion_id ?? null, v.promotion_id ?? null, v.prep_start, v.campaign_start, v.campaign_end,
        v.objective || null, v.channels ?? [], v.target_audience || null, v.message_angle || null, v.deliverables || null, v.notes || null, s.email, cleanCategories(v.categories)]);
    await writeAssignments(c, r.rows[0].id, v.business_id, v.assignments ?? [], dir);
    return r.rows[0].id as string;
  });
  return getPlan(s, id);
}

/** Which created tasks' deadlines a change of campaign dates affects, and the shifted deadline offered for each. */
function deadlineImpact(before: any, after: PlanInput, asg: any[]) {
  if (before.campaign_start === after.campaign_start && before.campaign_end === after.campaign_end && before.prep_start === after.prep_start) return [];
  const shift = Math.round((Date.parse(after.campaign_start) - Date.parse(before.campaign_start)) / 864e5);
  return asg.filter((a) => a.delivery_status === "created").map((a) => {
    const t = taskView(a)!;
    const current = t.due_date ?? a.due_date;
    const suggested = shift ? addDays(current, shift) : current;
    const outside = current > after.campaign_end || current < after.prep_start;
    return { assignment_id: a.id, title: t.title ?? a.title, current_due_date: current, suggested_due_date: suggested, outside_new_dates: outside };
  }).filter((x) => x.suggested_due_date !== x.current_due_date || x.outside_new_dates);
}

export async function updatePlan(s: Session, id: string, version: number, v: PlanInput) {
  assertOwner(s);
  const dir = v.assignments ? await directoryOrNull() : null;
  let impact: any[] = [];
  await tx(async (c) => {
    const cur = (await c.query(`select id, business_id, version, status, to_char(prep_start,'YYYY-MM-DD') prep_start, to_char(campaign_start,'YYYY-MM-DD') campaign_start, to_char(campaign_end,'YYYY-MM-DD') campaign_end
                                  from marketing_plans where id = $1 for update`, [id])).rows[0];
    if (!cur) throw notFound("Plan");
    if (cur.version !== version) throw new HttpError(409, "conflict", "This plan was changed in another window. Reload, then re-apply your edit.");
    const created = (await c.query("select count(*)::int n from plan_assignments where plan_id = $1 and delivery_status = any($2::text[])", [id, LOCKED_DELIVERY])).rows[0].n;
    if (created && v.business_id !== cur.business_id) throw badRequest("The brand cannot change after tasks were sent to Task Tracker.");
    await checkLinks(c, v);
    impact = deadlineImpact(cur, v, await assignmentsOf([id], c));
    await c.query(`update marketing_plans set business_id = $2, name = $3, gift_occasion_id = $4, occurrence_year = $5, sheet_occasion_id = $6, promotion_id = $7,
                     prep_start = $8, campaign_start = $9, campaign_end = $10, objective = $11, channels = $12, target_audience = $13, message_angle = $14,
                     deliverables = $15, notes = $16, categories = coalesce($17, categories), updated_at = now(), version = version + 1 where id = $1`,
      [id, v.business_id, v.name, v.gift_occasion_id ?? null, v.occurrence_year ?? null, v.sheet_occasion_id ?? null, v.promotion_id ?? null, v.prep_start, v.campaign_start, v.campaign_end,
        v.objective || null, v.channels ?? [], v.target_audience || null, v.message_angle || null, v.deliverables || null, v.notes || null, v.categories ? cleanCategories(v.categories) : null]);
    if (v.assignments) await writeAssignments(c, id, v.business_id, v.assignments, dir);
  });
  return { plan: await getPlan(s, id), deadline_impact: impact };
}

export async function deletePlan(s: Session, id: string) {
  assertOwner(s);
  await tx(async (c) => {
    const p = (await c.query("select id from marketing_plans where id = $1 for update", [id])).rows[0];
    if (!p) throw notFound("Plan");
    const n = (await c.query("select count(*)::int n from plan_assignments where plan_id = $1 and delivery_status = any($2::text[])", [id, LOCKED_DELIVERY])).rows[0].n;
    if (n) throw new HttpError(409, "has_tasks", "This plan has tasks in Task Tracker (or a send still to be settled), so it cannot be deleted.");
    await c.query("delete from marketing_plans where id = $1", [id]);
  });
}

// ------------------------------------------------------------ what is sent to Task Tracker
export { idempotencyKey };

/** The brief the assignee gets: their own task plus the campaign facts needed to do it. Objective, notes and other assignments are not sent. */
export function briefFor(p: any, a: { brief: string | null }) {
  const lines = [
    a.brief?.trim() || null,
    "",
    `Campaign: ${p.name} (${BUSINESS_LABEL[p.business_id] ?? p.business_id})`,
    `Campaign dates: ${formatRange({ start: p.campaign_start, end: p.campaign_end })}`,
    p.channels?.length ? `Channels: ${p.channels.join(", ")}` : null,
    p.target_audience ? `Target audience: ${p.target_audience}` : null,
    p.message_angle ? `Message angle: ${p.message_angle}` : null,
  ].filter((x) => x !== null) as string[];
  while (lines[0] === "") lines.shift();
  return lines.join("\n").slice(0, 2000);
}

async function planRow(id: string, c?: pg.PoolClient) {
  const r = await (c ? c.query(`select ${PLAN_COLS} from ${PLAN_FROM} where p.id = $1`, [id]).then((x) => x.rows[0]) : one<any>(`select ${PLAN_COLS} from ${PLAN_FROM} where p.id = $1`, [id]));
  if (!r) throw notFound("Plan");
  return r;
}

/** Exactly what Publish & send will send for each assignment not yet in Task Tracker, with the pre-checks. */
export async function previewSend(s: Session, id: string) {
  assertOwner(s);
  const p = await planRow(id);
  const all = await assignmentsOf([id]);
  const asg = all.filter((a) => a.send_to_tracker !== false && a.delivery_status !== "created");
  const dir = await directoryOrNull();
  return {
    plan: { id: p.id, name: p.name, status: p.status, version: p.version },
    tracker_connected: planningTrackerConfigured(), directory_checked: !!dir,
    // Items kept in the dashboard: published with the plan, never sent.
    kept: all.filter((a) => a.send_to_tracker === false).map((a) => ({ assignment_id: a.id, title: a.title })),
    items: asg.map((a) => {
      const chk = dir ? checkAssignmentAgainst(dir, p.business_id, a) : null;
      return { assignment_id: a.id, title: a.title, brief: briefFor(p, a), brand: chk?.ok ? chk.brand.name : a.tracker_brand_name, assignee: chk?.ok ? chk.person.name : a.tracker_assignee_name,
        due_date: a.due_date, problem: chk && !chk.ok ? chk.message : null };
    }),
  };
}

const storeTask = (_c: null, id: string, t: TrackerTask) => storeTaskIn("plan_assignments", id, t);

/**
 * Publish (if still a draft) and send every assignment not yet created. Each assignment is sent on its own with its
 * stable key: one failing leaves the others created and linked, and sending again (Retry) can never duplicate.
 * Saving a draft never sends anything.
 */
export async function publishAndSend(s: Session, id: string, version: number) {
  assertOwner(s);
  await tx(async (c) => {
    const p = (await c.query("select version, status from marketing_plans where id = $1 for update", [id])).rows[0];
    if (!p) throw notFound("Plan");
    if (p.version !== version) throw new HttpError(409, "conflict", "This plan was changed in another window. Reload before publishing.");
    if (p.status === "draft") await c.query("update marketing_plans set status = 'published', published_at = now(), updated_at = now(), version = version + 1 where id = $1", [id]);
  });
  const results = await sendPending(id);
  return { plan: await getPlan(s, id), results };
}

/**
 * Records the send of one assignment BEFORE Task Tracker is called: under the plan row lock (the same lock plan
 * edits and deletes take), the assignment is marked "sending" and its current values are read. From then on it can't
 * be edited or removed, so a task created in Task Tracker always has its dashboard row to link to.
 */
async function claimForSend(planId: string, assignmentId: string) {
  return tx(async (c) => {
    const p = (await c.query(`select ${PLAN_COLS} from ${PLAN_FROM} where p.id = $1 for update of p`, [planId])).rows[0];
    if (!p) return null;
    const a = (await c.query(`select id, title, brief, send_to_tracker, tracker_brand_id, tracker_assignee_id, to_char(due_date,'YYYY-MM-DD') due_date, delivery_status,
                                     highest_sent_at, fenced_through
                                from plan_assignments where id = $1 and plan_id = $2 for update`, [assignmentId, planId])).rows[0];
    if (!a || a.delivery_status === "created" || !a.send_to_tracker) return null;   // kept in the dashboard: never sent
    await c.query("update plan_assignments set delivery_status = 'sending', delivery_error = null, last_attempt_at = now() where id = $1", [a.id]);
    const iso = (v: any) => (v ? new Date(v).toISOString() : null);
    return { plan: p, a, previous: a.delivery_status as string, highestSentAt: iso(a.highest_sent_at), fencedThrough: iso(a.fenced_through) };
  });
}

/**
 * Sends one plan's assignments that are not yet created: unsent, refused before, or unresolved (no answer, or a
 * send interrupted mid-way). One send per plan at a time (advisory lock). Unresolved ones are first looked up in
 * Task Tracker by their id; the creation itself is idempotent on that id too, so nothing is ever created twice.
 */
export async function sendPending(planId: string) {
  await planRow(planId);
  // A session-level lock on one dedicated connection (released in finally), so two sends of one plan never overlap.
  const lockConn = await getPool().connect();
  const lock = (await lockConn.query("select pg_try_advisory_lock(hashtextextended($1, 11)) ok", [planId])).rows[0];
  if (!lock?.ok) { lockConn.release(); throw new HttpError(409, "sending", "This plan's tasks are being sent right now. Wait a moment and reload."); }
  const results: any[] = [];
  try {
    // Holding the lock, any "sending" row is left over from an interrupted send: it is unresolved like "unknown".
    const pending = (await assignmentsOf([planId])).filter((a) => a.send_to_tracker !== false && a.delivery_status !== "created");
    if (!pending.length) return results;
    if (!planningTrackerConfigured()) {
      for (const a of pending) if (a.delivery_status === "not_sent" || a.delivery_status === "failed") await setDelivery(a.id, "failed", "Task Tracker is not connected for planning.");
      return pending.map((a) => ({ assignment_id: a.id, outcome: "failed", message: "Task Tracker is not connected for planning." }));
    }
    let dir: Directory | null = null;
    try { dir = await trackerDirectory(); } catch { dir = null; }
    for (const row of pending) {
      const claim = await claimForSend(planId, row.id);
      if (!claim) continue;                                   // removed by an edit before the send started, or created meanwhile
      const { plan: p, a, previous, highestSentAt, fencedThrough } = claim;
      // A plan item added from the Slack review queue carries that Slack request, so Task Tracker never duplicates it.
      const fromReview = await query<{ source_key: string }>("select source_key from review_suggestions where plan_assignment_id = $1", [a.id]);
      const r = await deliverClaimed("plan_assignments", { id: a.id, business: p.business_id, previous, highestSentAt, fencedThrough,
        payload: { brand_id: a.tracker_brand_id, assignee_id: a.tracker_assignee_id, title: a.title, brief: briefFor(p, a), due_date: a.due_date },
        sources: planSources(fromReview[0]?.source_key) }, planId, "plan", dir);
      results.push({ assignment_id: r.id, outcome: r.outcome, existing: r.existing, code: r.code, message: r.message });
    }
    return results;
  } finally {
    await lockConn.query("select pg_advisory_unlock(hashtextextended($1, 11))", [planId]).catch(() => {});
    lockConn.release();
  }
}
const setDelivery = (id: string, status: "failed" | "unknown", msg: string) => setDeliveryIn("plan_assignments", id, status, msg);

/** Re-reads the plan's created tasks from Task Tracker (the "last read" used for deadline conflict checks). */
export async function refreshFromTracker(s: Session, id: string) {
  assertOwner(s);
  // Created tasks are re-read; unresolved sends (no answer) are settled by their id. A send in progress is left alone.
  const all = await assignmentsOf([id]);
  const asg = all.filter((a) => a.delivery_status === "created");
  const unknown = all.filter((a) => a.delivery_status === "unknown");
  const got = await readTrackerTasks([...asg, ...unknown].map((a) => idempotencyKey(a.id)));
  for (const t of got) { const a = [...asg, ...unknown].find((x) => idempotencyKey(x.id) === t.idempotency_key); if (a) await storeTask(null, a.id, t); }
  const missing = asg.filter((a) => !got.some((t) => t.idempotency_key === idempotencyKey(a.id)));
  for (const a of missing) await query("update plan_assignments set tracker_status = 'deleted', tracker_read_at = now() where id = $1", [a.id]);
  // An unresolved send not found yet stays unresolved: the unanswered request could still be finishing. Only a new
  // send with the same id (which Task Tracker serializes with the first) settles it either way.
  return getPlan(s, id);
}

/** Updates one created task's deadline in Task Tracker, only if it has not changed there since it was last read. */
export async function updateDeadline(s: Session, planId: string, assignmentId: string, due: string) {
  assertOwner(s);
  if (!isIsoDate(due)) throw badRequest("Choose a valid date.");
  const a = (await assignmentsOf([planId])).find((x) => x.id === assignmentId);
  if (!a) throw notFound("Assignment");
  if (a.delivery_status !== "created" || !a.tracker_version) throw badRequest("This assignment is not a Task Tracker task yet.");
  const out = await changeTrackerDueDate(idempotencyKey(a.id), due, a.tracker_version);
  if (out.kind === "updated") {
    await storeTask(null, a.id, out.task);
    await query("update plan_assignments set due_date = $2 where id = $1", [a.id, due]);
    return { outcome: "updated", plan: await getPlan(s, planId) };
  }
  if (out.kind === "missing") return { outcome: "missing", message: "The task no longer exists in Task Tracker.", plan: await getPlan(s, planId) };
  // Conflict: keep our copy as it was (so Emilie sees what changed); the current task is returned for comparison.
  return { outcome: "conflict", message: out.message, current: out.task && { title: out.task.title, due_date: out.task.due_date, status: out.task.status, assignee: out.task.assignee.name, version: out.task.version, updated_at: out.task.updated_at },
    plan: await getPlan(s, planId) };
}

/** Accept the tracker's current state as "last read" after a conflict, so a new deadline decision can be made. */
export async function acceptTrackerState(s: Session, planId: string) { return refreshFromTracker(s, planId); }
