// Weekly and monthly reports. A revision freezes its figures and the import runs they came from; published
// revisions never change (database trigger). Corrections create a new revision.
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Router } from "../router";
import { query, one, tx } from "../db";
import { badRequest, notFound, readJson, HttpError, json, forbidden } from "../http";
import { isIsoDate, formatRange, todayIn, OPERATIONS_TZ, dayCount } from "../../shared/dates";
import { businessHeadline, advertising, productsAndVendors } from "./dashboard";
import { periodWithin, overlapShare } from "../../shared/coverage";
import { blobStore } from "../blobStore";
import { audit } from "../audit";
import { hit, subjectKey } from "../rateLimit";

export const ATTACHMENT_TYPES: Record<string, { ext: string[]; magic?: (b: Uint8Array) => boolean }> = {
  "image/png": { ext: ["png"], magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/jpeg": { ext: ["jpg", "jpeg"], magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  "image/webp": { ext: ["webp"], magic: (b) => String.fromCharCode(...b.slice(8, 12)) === "WEBP" },
  "application/pdf": { ext: ["pdf"], magic: (b) => String.fromCharCode(...b.slice(0, 5)) === "%PDF-" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: ["xlsx"], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  "text/csv": { ext: ["csv"] },
  "application/zip": { ext: ["zip"], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
};
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export function checkAttachment(filename: string, type: string, data: Uint8Array): string | null {
  const t = ATTACHMENT_TYPES[type];
  if (!t) return "This file type is not allowed. Use PNG, JPEG, WebP, PDF, XLSX, CSV or ZIP.";
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (!t.ext.includes(ext)) return "The file extension does not match its type.";
  if (data.byteLength === 0) return "The file is empty.";
  if (data.byteLength > MAX_ATTACHMENT_BYTES) return "Files are limited to 15 MB.";
  if (t.magic && !t.magic(data)) return "The file content does not match its type.";
  if (/[\/\\\x00-\x1f]/.test(filename) || filename.length > 200) return "Invalid file name.";
  return null;
}

export async function storeAttachment(owner_type: string, owner_id: string, file: File, actor: string) {
  const data = new Uint8Array(await file.arrayBuffer());
  const problem = checkAttachment(file.name, file.type, data);
  if (problem) throw badRequest(problem);
  const key = `${owner_type}/${randomUUID()}`;
  await (await blobStore()).put(key, data);
  const row = await one<{ id: string }>(
    `insert into attachments (owner_type, owner_id, filename, content_type, size_bytes, sha256, storage_key, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [owner_type, owner_id, file.name, file.type, data.byteLength, createHash("sha256").update(data).digest("hex"), key, actor]);
  return row!.id;
}

/** Freezes the report content from current saved data, with the import runs it used. */
/** Activities that overlap the report period; counts of periods running past it are prorated by days. */
export async function activitiesInPeriod(b: string | null, start: string, end: string) {
  return query(
    `select a.business_id, a.activity_type, a.name, a.count::float8 count, a.count_unit, to_char(a.period_start,'YYYY-MM-DD') period_start,
            to_char(a.period_end,'YYYY-MM-DD') period_end, a.link, a.import_run_id
       from activities a where a.status = 'active' and ($1::text is null or a.business_id = $1)
        and a.period_end >= $2 and a.period_start <= $3 order by a.period_start, a.name`, [b, start, end])
    // Work counts for a period that runs past the report period are divided by the share of its days inside it
    // (a Saturday–Friday week with 6 of its 7 days in November counts 6/7 of its tasks there).
    .then((rows: any[]) => rows.flatMap((a) => {
      const share = overlapShare({ start: a.period_start, end: a.period_end }, { start, end });
      if (share <= 0) return [];
      if (share === 1 || a.count === null) return [a];
      return [{ ...a, count: Math.round(a.count * share * 10) / 10, prorated: { days_inside: Math.round(share * dayCount({ start: a.period_start, end: a.period_end })), days_total: dayCount({ start: a.period_start, end: a.period_end }), full_count: a.count } }];
    }));
}

/** Promotions that ran during the report period (overlapping it). No future window. */
export async function promotionsInPeriod(b: string | null, start: string, end: string) {
  return query(
    `select p.id, p.business_id, p.kind, p.title, to_char(p.start_date,'YYYY-MM-DD') start_date, to_char(p.end_date,'YYYY-MM-DD') end_date, p.offer, p.code,
            p.execution_status, p.owner, p.review_state, p.missing_from_source_since,
            (select count(*) from tasks t where t.promotion_id = p.id and t.status <> 'cancelled')::int as task_count,
            (select count(*) from tasks t where t.promotion_id = p.id and t.status = 'done')::int as task_done
       from promotions p
      where ($1::text is null or p.business_id = $1) and p.kind in ('promotion','special_collection','launch')
        and p.start_date <= $3 and p.end_date >= $2
      order by p.start_date`, [b, start, end]);
}

/** Freezes the report content for exactly its period, with the import runs it used. */
export async function buildSnapshot(b: string | null, start: string, end: string) {
  const range = { start, end };
  const today = todayIn(OPERATIONS_TZ);
  const businesses = b ? [b] : ["sb", "p2s", "perksradar"];
  const performance: any[] = [];
  for (const id of businesses) performance.push({ business: id, metrics: await businessHeadline(id, range, "previous_period") });
  const activities = await activitiesInPeriod(b, start, end);
  const runs = (await query<{ id: string; s: string; e: string; g: string }>(
    `select distinct import_run_id as id, to_char(period_start,'YYYY-MM-DD') s, to_char(period_end,'YYYY-MM-DD') e, granularity::text g from observations where status = 'active' and ($1::text is null or business_id = $1) and period_end >= $2 and period_start <= $3
     union select distinct import_run_id, to_char(p.period_start,'YYYY-MM-DD'), to_char(p.period_end,'YYYY-MM-DD'), p.granularity::text from campaign_performance p join ad_campaigns c on c.id = p.campaign_id where p.status = 'active' and ($1::text is null or c.business_id = $1) and p.period_end >= $2 and p.period_start <= $3
     union select distinct import_run_id, to_char(period_start,'YYYY-MM-DD'), to_char(period_end,'YYYY-MM-DD'), 'exact' from product_observations where status = 'active' and ($1::text is null or business_id = $1) and period_start = $2 and period_end = $3`, [b, start, end]))
    .filter((x) => x.g === "exact" || periodWithin({ start: x.s, end: x.e, granularity: x.g }, range));
  const runIds = new Set([...runs.map((r) => r.id), ...activities.map((a: any) => a.import_run_id)].filter(Boolean));
  return {
    content: {
      period: { start, end, label: formatRange(range) }, generated_on: today,
      performance, advertising: await advertising(b, range),
      promotions: { current: await promotionsInPeriod(b, start, end), upcoming: [], note: "Promotions whose dates overlap this period. Dates do not prove a launch; see execution status." },
      activities: activities.map(({ import_run_id, ...a }: any) => a),
      products: !b || b === "sb" ? await productsAndVendors("sb", range, "previous_period") : null,
    },
    runs: [...runIds] as string[],
  };
}

export function registerReports(r: Router) {
  r.get("/reports", async ({ url }) => {
    const kind = url.searchParams.get("kind"), b = url.searchParams.get("business");
    return query(`select r.*, to_char(period_start,'YYYY-MM-DD') period_start, to_char(period_end,'YYYY-MM-DD') period_end,
                         (select json_agg(json_build_object('revision', v.revision, 'state', v.state, 'published_at', v.published_at, 'corrects_revision', v.corrects_revision) order by v.revision)
                            from report_revisions v where v.report_id = r.id) as revisions
                    from reports r where ($1::text is null or kind = $1) and ($2::text is null or business_id is not distinct from nullif($2, 'all'))
                   order by r.period_end desc limit 200`, [kind, b]);
  });
  r.get("/reports/:id", async ({ params, url }) => {
    const rep = await one<any>("select *, to_char(period_start,'YYYY-MM-DD') period_start, to_char(period_end,'YYYY-MM-DD') period_end from reports where id = $1", [params.id]);
    if (!rep) throw notFound("Report");
    const want = url.searchParams.get("revision");
    const revs = await query<any>("select id, revision, state, corrects_revision, correction_note, created_by, created_at, published_at from report_revisions where report_id = $1 order by revision", [params.id]);
    const pick = want ? revs.find((v) => v.revision === Number(want)) : [...revs].reverse().find((v) => v.state === "published") ?? revs[revs.length - 1];
    const rev = pick ? await one<any>("select * from report_revisions where id = $1", [pick.id]) : null;
    const files = rev ? await query("select id, filename, content_type, size_bytes, structured_review, uploaded_by, uploaded_at from attachments where owner_type = 'report_revision' and owner_id = $1", [rev.id]) : [];
    return { report: rep, revisions: revs, revision: rev, files };
  });
  r.post("/reports", async ({ req, session }) => {
    const body = z.object({ kind: z.enum(["weekly", "monthly"]), business_id: z.enum(["sb", "p2s", "perksradar"]).nullable(), period_start: z.string(), period_end: z.string(), title: z.string().max(200).optional() })
      .safeParse(await readJson(req));
    if (!body.success || !isIsoDate(body.data.period_start) || !isIsoDate(body.data.period_end) || body.data.period_end < body.data.period_start) throw badRequest("Kind, business and a valid period are required.");
    const d = body.data;
    const snap = await buildSnapshot(d.business_id, d.period_start, d.period_end);
    return tx(async (c) => {
      const rep = (await c.query(
        `insert into reports (kind, business_id, period_start, period_end, title, created_by) values ($1,$2,$3,$4,$5,$6)
         on conflict (kind, business_id, period_start, period_end) do nothing returning id`,
        [d.kind, d.business_id, d.period_start, d.period_end, d.title ?? `${d.kind === "weekly" ? "Weekly" : "Monthly"} report, ${formatRange({ start: d.period_start, end: d.period_end })}`, session.email])).rows[0];
      if (!rep) throw new HttpError(409, "exists", "A report for this period already exists. Open it and add a revision.");
      await c.query("insert into report_revisions (report_id, revision, state, content, source_runs, created_by) values ($1,1,'draft',$2,$3,$4)", [rep.id, JSON.stringify(snap.content), snap.runs, session.email]);
      return { id: rep.id, revision: 1 };
    });
  });
  r.post("/reports/:id/publish", async ({ params, session }) => {
    const v = await one<any>("update report_revisions set state = 'published', published_at = now() where id = (select id from report_revisions where report_id = $1 and state = 'draft' order by revision desc limit 1) returning revision", [params.id]);
    if (!v) throw new HttpError(409, "no_draft", "There is no draft revision to publish.");
    await audit(session.email, "report.publish", "report", params.id, { revision: v.revision });
    return { ok: true, revision: v.revision };
  });
  // Correction: a new draft revision from the current saved data (or the same content with a note); earlier revisions stay.
  r.post("/reports/:id/revisions", async ({ req, params, session }) => {
    const body = z.object({ note: z.string().trim().min(3).max(2000), refresh: z.boolean().default(true) }).safeParse(await readJson(req));
    if (!body.success) throw badRequest("Describe what this revision corrects.");
    const rep = await one<any>("select *, to_char(period_start,'YYYY-MM-DD') ps, to_char(period_end,'YYYY-MM-DD') pe from reports where id = $1", [params.id]);
    if (!rep) throw notFound("Report");
    const last = await one<any>("select revision, state, content, source_runs from report_revisions where report_id = $1 order by revision desc limit 1", [params.id]);
    if (last?.state === "draft") throw new HttpError(409, "draft_exists", "Publish or discard the current draft first.");
    const snap = body.data.refresh ? await buildSnapshot(rep.business_id, rep.ps, rep.pe) : { content: last.content, runs: last.source_runs };
    const next = (last?.revision ?? 0) + 1;
    await query("insert into report_revisions (report_id, revision, state, content, source_runs, corrects_revision, correction_note, created_by) values ($1,$2,'draft',$3,$4,$5,$6,$7)",
      [params.id, next, JSON.stringify(snap.content), snap.runs, last?.revision ?? null, body.data.note, session.email]);
    return { ok: true, revision: next };
  });
  r.delete("/reports/:id/draft", async ({ params }) => {
    await query("delete from report_revisions where report_id = $1 and state = 'draft'", [params.id]);
    return { ok: true };
  }, "editor");

  // ---------------- private attachments
  r.post("/attachments", async ({ req, session }) => {
    await hit({ bucket: `upload:${subjectKey(session.sub)}`, limit: 120, windowSec: 3600 });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_ATTACHMENT_BYTES + 100_000) throw new HttpError(413, "too_large", "Files are limited to 15 MB.");
    const form = await req.formData().catch(() => null);
    if (!form) throw badRequest("Send the file as multipart form data.");
    const file = form.get("file"), owner_type = String(form.get("owner_type") ?? ""), owner_id = String(form.get("owner_id") ?? "");
    if (!(file instanceof File)) throw badRequest("No file received.");
    if (owner_id.startsWith("tracker:")) throw forbidden("Task Tracker tasks are read-only here; attach files in the Task Tracker.");
    if (!["report_revision", "task", "promotion"].includes(owner_type) || !/^[0-9a-f-]{36}$/.test(owner_id)) throw badRequest("Unknown attachment owner.");
    const table = owner_type === "report_revision" ? "report_revisions" : owner_type === "task" ? "tasks" : "promotions";
    const owner = await one<any>(`select * from ${table} where id = $1`, [owner_id]);
    if (!owner) throw notFound("Owner");
    if (owner_type === "report_revision" && owner.state === "published") throw new HttpError(409, "immutable", "Published revisions cannot change. Create a correction revision and attach files there.");
    const id = await storeAttachment(owner_type, owner_id, file, session.email);
    await audit(session.email, "attachment.upload", owner_type, owner_id, { attachment: id });
    return { id };
  });
  r.get("/attachments/:id", async ({ params }) => {
    if (!/^[0-9a-f-]{36}$/.test(params.id)) throw notFound("File");
    const a = await one<any>("select * from attachments where id = $1", [params.id]);
    if (!a) throw notFound("File");
    const data = await (await blobStore()).get(a.storage_key);
    if (!data) throw notFound("File content");
    const inline = a.content_type.startsWith("image/") || a.content_type === "application/pdf";
    return new Response(data as BodyInit, { headers: {
      "content-type": a.content_type, "content-length": String(data.byteLength), "cache-control": "private, no-store",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${a.filename.replace(/[^A-Za-z0-9._ -]/g, "_")}"`,
      "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:",
    } });
  });
}
export { json };
