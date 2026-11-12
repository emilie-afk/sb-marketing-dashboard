// Tasks (the dashboard is the editing authority), promotions' dashboard-owned fields, calendar and review items.
import { z } from "zod";
import type { Router } from "../router";
import { query, one, tx } from "../db";
import { badRequest, conflict, notFound, readJson, HttpError } from "../http";
import { isIsoDate, addDays, todayIn, OPERATIONS_TZ } from "../../shared/dates";
import { occurrences } from "../../shared/recurrence";
import { validationErrors } from "../../shared/submission";
import { audit } from "../audit";
import { giftCalendarItems, checkGiftLink } from "./gifts";
import { trackerTaskItems, trackerTaskDetail, trackerCalendar, trackerFreshness, isTrackerId, assertDashboardTask } from "../trackerTasks";

const STATUS = z.enum(["todo", "in_progress", "waiting", "done", "cancelled"]);
const date = z.string().refine(isIsoDate, "must be YYYY-MM-DD");
const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  business_id: z.enum(["sb", "p2s", "perksradar"]),
  activity: z.string().max(120).nullable().optional(),
  owner: z.string().max(120).nullable().optional(),
  status: STATUS.default("todo"),
  due_date: date.nullable().optional(),
  promotion_id: z.string().uuid().nullable().optional(),
  recurrence: z.string().regex(/^(daily|weekly:[1-7]|monthly:([1-9]|[12][0-9]|3[01]|last))$/).nullable().optional(),
  recurrence_until: date.nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  links: z.array(z.object({
    target_type: z.enum(["product", "vendor", "listing", "campaign", "finding", "promotion", "report", "url"]),
    target_id: z.string().max(120).optional(), url: z.string().regex(/^https:\/\/\S+$/).max(2000).optional(), label: z.string().max(200).optional(),
  })).max(30).optional(),
}).refine((t) => !t.recurrence || t.due_date, { message: "A recurring task needs a first due date" });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest("Some fields are not valid.", validationErrors(r.error));
  return r.data;
}

export async function createTask(input: z.infer<typeof taskInput>, actor: string, source = "dashboard", c?: any) {
  const run = async (db: any) => {
    const t = (await db.query(
      `insert into tasks (title, business_id, activity, owner, status, due_date, promotion_id, recurrence, recurrence_until, description, source, created_by, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, case when $5 = 'done' then now() end) returning id`,
      [input.title, input.business_id, input.activity ?? null, input.owner ?? null, input.status, input.due_date ?? null, input.promotion_id ?? null,
        input.recurrence ?? null, input.recurrence_until ?? null, input.description ?? null, source, actor])).rows[0];
    for (const l of input.links ?? []) await db.query("insert into task_links (task_id, target_type, target_id, url, label) values ($1,$2,$3,$4,$5)", [t.id, l.target_type, l.target_id ?? null, l.url ?? null, l.label ?? null]);
    await db.query("insert into task_updates (task_id, actor, changes) values ($1,$2,$3)", [t.id, actor, JSON.stringify({ created: { from: null, to: input.title } })]);
    return t.id as string;
  };
  return c ? run(c) : tx(run);
}

export function registerWork(r: Router) {
  // ---------------- tasks
  r.get("/tasks", async ({ url }) => {
    const b = url.searchParams.get("business"), owner = url.searchParams.get("owner"), status = url.searchParams.get("status");
    const today = todayIn(OPERATIONS_TZ);
    const from = url.searchParams.get("from") ?? addDays(today, -14), to = url.searchParams.get("to") ?? addDays(today, 42);
    if (!isIsoDate(from) || !isIsoDate(to)) throw badRequest("from and to must be dates");
    const tasks = await query<any>(
      `select t.*, to_char(t.due_date,'YYYY-MM-DD') due_date, to_char(t.recurrence_until,'YYYY-MM-DD') recurrence_until, p.title as promotion_title,
              (select count(*) from attachments a where a.owner_type = 'task' and a.owner_id = t.id::text)::int as file_count,
              (select coalesce(json_agg(json_build_object('id', l.id, 'target_type', l.target_type, 'target_id', l.target_id, 'url', l.url, 'label', l.label)), '[]') from task_links l where l.task_id = t.id) as links
         from tasks t left join promotions p on p.id = t.promotion_id
        where ($1::text is null or t.business_id = $1) and ($2::text is null or t.owner = $2) and ($3::text is null or t.status = $3)
        order by t.due_date nulls last, t.created_at`, [b, owner, status]);
    const occ = await query<any>("select task_id, to_char(due_date,'YYYY-MM-DD') due_date, status, owner, completed_at from task_occurrences where due_date between $1 and $2", [from, to]);
    const occBy = new Map(occ.map((o) => [`${o.task_id}|${o.due_date}`, o]));
    // Recurring tasks are expanded into occurrences for the window; each occurrence keeps its own status.
    const items = tasks.flatMap((t) => {
      if (!t.recurrence) return [{ ...t, occurrence: null }];
      return occurrences(t.recurrence, t.due_date, { start: from, end: to }, t.recurrence_until).map((d) => {
        const o = occBy.get(`${t.id}|${d}`);
        return { ...t, due_date: d, status: o?.status ?? "todo", owner: o?.owner ?? t.owner, occurrence: d, series_status: t.status };
      });
    });
    // Read-only copies from the Task Tracker (one-way pull). Edited only in the Task Tracker.
    const tracker = await trackerTaskItems({ business: b, owner, status, from, to });
    return { items: [...items.map((t) => ({ ...t, source: t.source ?? "dashboard", read_only: false })), ...tracker], window: { from, to }, today, tracker: await trackerFreshness() };
  });
  r.get("/tasks/:id", async ({ params }) => {
    if (isTrackerId(params.id)) return trackerTaskDetail(params.id);
    const t = await one<any>("select t.*, to_char(t.due_date,'YYYY-MM-DD') due_date from tasks t where id = $1", [params.id]);
    if (!t) throw notFound("Task");
    return {
      task: t,
      links: await query("select * from task_links where task_id = $1", [params.id]),
      history: await query("select at, actor, changes, comment from task_updates where task_id = $1 order by at desc", [params.id]),
      files: await query("select id, filename, content_type, size_bytes, uploaded_by, uploaded_at from attachments where owner_type = 'task' and owner_id = $1", [params.id]),
    };
  });
  r.post("/tasks", async ({ req, session }) => {
    const input = parse(taskInput, await readJson(req));
    const id = await createTask(input, session.email);
    await audit(session.email, "task.create", "task", id);
    return { id };
  });
  r.patch("/tasks/:id", async ({ req, params, session }) => {
    assertDashboardTask(params.id);
    const body = await readJson(req);
    const version = Number(body.version);
    const patch = parse(z.object({
      title: z.string().trim().min(1).max(300).optional(), activity: z.string().max(120).nullable().optional(), owner: z.string().max(120).nullable().optional(),
      status: STATUS.optional(), due_date: date.nullable().optional(), promotion_id: z.string().uuid().nullable().optional(),
      description: z.string().max(5000).nullable().optional(), comment: z.string().max(2000).optional(),
    }).strict(), Object.fromEntries(Object.entries(body).filter(([k]) => k !== "version")));
    return tx(async (c) => {
      const cur = (await c.query("select * from tasks where id = $1 for update", [params.id])).rows[0];
      if (!cur) throw notFound("Task");
      if (cur.version !== version) throw conflict();
      const { comment, ...fields } = patch;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, v] of Object.entries(fields)) {
        const from = cur[k] instanceof Date ? cur[k].toISOString().slice(0, 10) : cur[k];
        if ((from ?? null) !== (v ?? null)) changes[k] = { from, to: v };
      }
      const keys = Object.keys(changes);
      if (keys.length) {
        await c.query(`update tasks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now(), version = version + 1 where id = $1`,
          [params.id, ...keys.map((k) => changes[k].to)]);
        await c.query("update tasks set completed_at = case when status = 'done' then coalesce(completed_at, now()) else null end where id = $1", [params.id]);
      }
      if (keys.length || comment) await c.query("insert into task_updates (task_id, actor, changes, comment) values ($1,$2,$3,$4)", [params.id, session.email, JSON.stringify(changes), comment ?? null]);
      return { ok: true, version: keys.length ? version + 1 : version };
    });
  });
  r.patch("/tasks/:id/occurrences/:date", async ({ req, params, session }) => {
    assertDashboardTask(params.id);
    if (!isIsoDate(params.date)) throw badRequest("Invalid occurrence date");
    const body = parse(z.object({ status: STATUS, owner: z.string().max(120).nullable().optional() }), await readJson(req));
    const t = await one<any>("select recurrence, to_char(due_date,'YYYY-MM-DD') due_date, to_char(recurrence_until,'YYYY-MM-DD') until from tasks where id = $1", [params.id]);
    if (!t?.recurrence) throw badRequest("This task does not repeat.");
    if (!occurrences(t.recurrence, t.due_date, { start: params.date, end: params.date }, t.until).length) throw badRequest("No occurrence on that date.");
    await query(`insert into task_occurrences (task_id, due_date, status, owner, completed_at) values ($1,$2,$3,$4, case when $3 = 'done' then now() end)
                 on conflict (task_id, due_date) do update set status = excluded.status, owner = coalesce(excluded.owner, task_occurrences.owner), completed_at = excluded.completed_at`,
      [params.id, params.date, body.status, body.owner ?? null]);
    await query("insert into task_updates (task_id, actor, changes) values ($1,$2,$3)", [params.id, session.email, JSON.stringify({ [`occurrence ${params.date}`]: { from: null, to: body.status } })]);
    return { ok: true };
  });

  // ---------------- promotions (dashboard-owned fields only; source fields come from the spreadsheet)
  r.get("/promotions/:id", async ({ params }) => {
    const p = await one<any>(`select p.*, to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date,
                                     g.name gift_occasion_name, g.kind gift_occasion_kind
                                from promotions p left join gift_occasions g on g.id = p.gift_occasion_id where p.id = $1`, [params.id]);
    if (!p) throw notFound("Promotion");
    const sourceOwned = !!(await one("select 1 from promotion_source_links where promotion_id = $1 limit 1", [params.id]));
    return {
      promotion: p,
      // Spreadsheet promotions keep their name, offer and dates in the spreadsheet; dashboard-created ones are edited here.
      sourceOwned,
      sources: await query("select s.label, s.role, l.last_tab, l.last_seen_at from promotion_source_links l join sheet_sources s on s.id = l.sheet_source_id where l.promotion_id = $1", [params.id]),
      history: await query("select changed_at, changed_by, changes from promotion_revisions where promotion_id = $1 order by changed_at desc limit 100", [params.id]),
      tasks: await query("select id, title, status, owner, to_char(due_date,'YYYY-MM-DD') due_date from tasks where promotion_id = $1 order by due_date nulls last", [params.id]),
      reviews: await query("select id, kind, details, created_at from review_items where promotion_id = $1 and resolved_at is null", [params.id]),
      files: await query("select id, filename, content_type, size_bytes, uploaded_at from attachments where owner_type = 'promotion' and owner_id = $1", [params.id]),
    };
  });
  const PROMO_STATUS = z.enum(["planned", "preparing", "ready", "launched", "ended", "cancelled"]);
  const giftYear = z.number().int().min(2000).max(2100).nullable().optional();
  // Create a dashboard-owned promotion (e.g. from a gift occasion). Spreadsheet promotions keep coming from the sync.
  r.post("/promotions", async ({ req, session }) => {
    const b = parse(z.object({
      business_id: z.enum(["sb", "p2s", "perksradar"]), title: z.string().trim().min(1).max(300), offer: z.string().trim().max(500).nullable().optional(),
      execution_status: PROMO_STATUS.default("planned"), owner: z.string().max(120).nullable().optional(), start_date: date, end_date: date,
      gift_occasion_id: z.string().max(60).nullable().optional(), gift_occasion_year: giftYear,
    }).strict(), await readJson(req));
    if (b.end_date < b.start_date) throw badRequest("The end date is before the start date.");
    const link = await checkGiftLink(b.gift_occasion_id, b.gift_occasion_year, b.business_id);
    return tx(async (c) => {
      const p = (await c.query(
        `insert into promotions (business_id, year, kind, title, offer, start_date, end_date, date_text, execution_status, owner, gift_occasion_id, gift_occasion_year, created_by)
         values ($1,$2,'promotion',$3,$4,$5,$6,'Set in the dashboard',$7,$8,$9,$10,$11) returning id, version`,
        [b.business_id, Number(b.start_date.slice(0, 4)), b.title, b.offer ?? null, b.start_date, b.end_date, b.execution_status, b.owner ?? null, link.id, link.year, session.email])).rows[0];
      await c.query("insert into promotion_revisions (promotion_id, changed_by, changes) values ($1,$2,$3)",
        [p.id, session.email, JSON.stringify({ created: { from: null, to: b.title }, ...(link.id ? { gift_occasion: { from: null, to: link.year ? `${link.id} ${link.year}` : link.id } } : {}) })]);
      return { id: p.id, version: p.version };
    });
  });
  r.patch("/promotions/:id", async ({ req, params, session }) => {
    const body = await readJson(req);
    const patch = parse(z.object({
      execution_status: PROMO_STATUS.optional(),
      execution_note: z.string().max(2000).nullable().optional(), owner: z.string().max(120).nullable().optional(),
      // Dashboard-owned on every promotion:
      gift_occasion_id: z.string().max(60).nullable().optional(), gift_occasion_year: giftYear,
      // Only for promotions created in the dashboard (spreadsheet promotions change in the spreadsheet):
      title: z.string().trim().min(1).max(300).optional(), offer: z.string().trim().max(500).nullable().optional(), start_date: date.optional(), end_date: date.optional(),
      version: z.number().int(),
    }).strict(), body);
    const { version, ...fields } = patch;
    const keys = Object.keys(fields);
    if (!keys.length) throw badRequest("Nothing to change.");
    const cur = await one<any>("select id, business_id, title, offer, to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date, execution_status, execution_note, owner, gift_occasion_id, gift_occasion_year from promotions where id = $1", [params.id]);
    if (!cur) throw notFound("Promotion");
    const sourceKeys = keys.filter((k) => ["title", "offer", "start_date", "end_date"].includes(k));
    if (sourceKeys.length && await one("select 1 from promotion_source_links where promotion_id = $1 limit 1", [params.id]))
      throw badRequest("This promotion comes from the promotion spreadsheet: change its name, offer and dates there.");
    const next = { ...cur, ...fields };
    if ((next.start_date && !next.end_date) || (!next.start_date && next.end_date) || (next.start_date && next.end_date < next.start_date)) throw badRequest("Set a start and end date, with the end on or after the start.");
    if ("gift_occasion_id" in fields || "gift_occasion_year" in fields) {
      if (fields.gift_occasion_id === null) { next.gift_occasion_year = null; (fields as any).gift_occasion_year = null; }
      const link = await checkGiftLink(next.gift_occasion_id, next.gift_occasion_year, cur.business_id);
      (fields as any).gift_occasion_id = link.id; (fields as any).gift_occasion_year = link.year;
    }
    const setKeys = Object.keys(fields);
    if ("start_date" in fields) { setKeys.push("year"); (fields as any).year = Number(next.start_date.slice(0, 4)); }
    const res = await query(`update promotions set ${setKeys.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_at = now(), version = version + 1
                             where id = $1 and version = $2 returning version`, [params.id, version, ...setKeys.map((k) => (fields as any)[k])]);
    if (!res.length) throw conflict();
    const changes = Object.fromEntries(Object.keys(fields).filter((k) => k !== "year" && cur[k] !== (fields as any)[k]).map((k) => [k, { from: cur[k] ?? null, to: (fields as any)[k] }]));
    if (Object.keys(changes).length) await query("insert into promotion_revisions (promotion_id, changed_by, changes) values ($1,$2,$3)", [params.id, session.email, JSON.stringify(changes)]);
    return { ok: true, version: res[0].version };
  });

  // ---------------- calendar (one record set, several views)
  r.get("/calendar", async ({ url }) => {
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw badRequest("from and to are required dates");
    const b = url.searchParams.get("business");
    const types = (url.searchParams.get("types") ?? "occasion,promotion,launch,task").split(",");
    const items: any[] = [];
    let undated: any[] = [];
    if (types.includes("gift")) {
      const g = await giftCalendarItems(from, to, b, url.searchParams.get("seasonal") !== "0");
      items.push(...g.items); undated = g.undated;
    }
    if (types.includes("occasion"))
      for (const o of await query<any>(`select id, business_id, name, to_char(occasion_date,'YYYY-MM-DD') d, occasion_type, selected_promotion_id
                                          from occasions where occasion_date between $1 and $2 and ($3::text is null or business_id = $3)`, [from, to, b]))
        items.push({ type: "occasion", id: o.id, business: o.business_id, title: o.name, start: o.d, end: o.d, detail: o.occasion_type, promotionId: o.selected_promotion_id });
    if (types.includes("promotion") || types.includes("launch"))
      for (const p of await query<any>(`select p.id, p.business_id, p.kind, p.title, to_char(p.start_date,'YYYY-MM-DD') s, to_char(p.end_date,'YYYY-MM-DD') e, p.execution_status, p.code,
                                               to_char(p.prep_deadline,'YYYY-MM-DD') prep, to_char(p.feature_date,'YYYY-MM-DD') feature, p.review_state, g.name gift_name, p.gift_occasion_year gift_year
                                          from promotions p left join gift_occasions g on g.id = p.gift_occasion_id
                                         where p.start_date <= $2 and p.end_date >= $1 and ($3::text is null or p.business_id = $3)`, [from, to, b])) {
        const type = p.kind === "launch" || p.kind === "milestone" ? "launch" : "promotion";
        const gift = p.gift_name ? `${p.gift_name}${p.gift_year ? ` ${p.gift_year}` : ""}` : null;
        if (types.includes(type)) items.push({ type, id: p.id, business: p.business_id, title: p.title, start: p.s, end: p.e, detail: [p.code, gift && `Gift occasion: ${gift}`].filter(Boolean).join(" · ") || null, status: p.execution_status, kind: p.kind, review: p.review_state, giftOccasion: gift });
        if (p.prep && p.prep >= from && p.prep <= to && types.includes("task")) items.push({ type: "deadline", id: p.id, business: p.business_id, title: `Prep deadline: ${p.title}`, start: p.prep, end: p.prep });
        if (p.feature && p.feature >= from && p.feature <= to && types.includes("launch")) items.push({ type: "launch", id: p.id, business: p.business_id, title: `Feature: ${p.title}`, start: p.feature, end: p.feature });
      }
    if (types.includes("task")) {
      const tasks = await query<any>("select id, title, business_id, status, recurrence, to_char(due_date,'YYYY-MM-DD') due_date, to_char(recurrence_until,'YYYY-MM-DD') until from tasks where due_date is not null and status <> 'cancelled' and ($1::text is null or business_id = $1)", [b]);
      for (const t of tasks) for (const d of occurrences(t.recurrence, t.due_date, { start: from, end: to }, t.until))
        items.push({ type: "task", id: t.id, business: t.business_id, title: t.title, start: d, end: d, status: t.recurrence ? undefined : t.status, occurrence: t.recurrence ? d : null });
    }
    if (types.includes("task")) items.push(...(await trackerCalendar(from, to, b)));
    items.sort((a, b2) => (a.start < b2.start ? -1 : a.start > b2.start ? 1 : a.type.localeCompare(b2.type)));
    return { items, undated, from, to, timezoneNote: "Promotion dates follow the spreadsheet (Pacific time for offers). Task deadlines use Vietnam time. Gift occasions are all-day U.S. dates." };
  });
  // An occasion becomes an execution record only when someone selects it for use.
  r.post("/occasions/:id/select", async ({ params, session }) => {
    return tx(async (c) => {
      const o = (await c.query("select * from occasions where id = $1 for update", [params.id])).rows[0];
      if (!o) throw notFound("Occasion");
      if (o.selected_promotion_id) return { promotion_id: o.selected_promotion_id, existing: true };
      const d = o.occasion_date instanceof Date ? o.occasion_date.toISOString().slice(0, 10) : o.occasion_date;
      const p = (await c.query(`insert into promotions (business_id, year, kind, title, start_date, end_date, date_text, created_by) values ($1,$2,'promotion',$3,$4,$4,'selected occasion',$5) returning id`,
        [o.business_id, Number(String(d).slice(0, 4)), o.name, d, session.email])).rows[0];
      await c.query("update occasions set selected_promotion_id = $2 where id = $1", [params.id, p.id]);
      return { promotion_id: p.id, existing: false };
    });
  });

  // ---------------- review queue
  r.get("/review-items", async () => query(
    `select ri.*, p.title as promotion_title, f.statement as finding_statement from review_items ri
       left join promotions p on p.id = ri.promotion_id left join findings f on f.id = ri.finding_id
      where ri.resolved_at is null order by ri.created_at desc limit 300`));
  r.post("/review-items/:id/resolve", async ({ req, params, session }) => {
    const body = parse(z.object({ resolution: z.string().trim().min(1).max(1000) }), await readJson(req));
    const item = await one<any>("update review_items set resolved_at = now(), resolved_by = $2, resolution = $3 where id = $1 and resolved_at is null returning promotion_id", [params.id, session.email, body.resolution]);
    if (!item) throw new HttpError(404, "not_found", "Review item not found or already resolved.");
    if (item.promotion_id) {
      const open = await one<any>("select count(*)::int n from review_items where promotion_id = $1 and resolved_at is null", [item.promotion_id]);
      if (!open.n) await query("update promotions set review_state = 'ok' where id = $1", [item.promotion_id]);
    }
    return { ok: true };
  });
}
