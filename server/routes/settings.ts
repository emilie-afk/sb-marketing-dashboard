import { z } from "zod";
import type { Router } from "../router";
import { query, one } from "../db";
import { badRequest, notFound, readJson, HttpError } from "../http";
import { createClient, listClients, revokeClient } from "../automation";
import { enqueueSheetSync, getJob, activeJobs } from "../syncJobs";
import { json } from "../http";
import { readerConfigured } from "../sheetsReader";
import { sourceStatus } from "./dashboard";
import { audit } from "../audit";
import { excludedBrands, trackedChannels } from "../../shared/scope";

const FILE_ID = /^[A-Za-z0-9_-]{20,80}$/;
/** Accepts a Drive or Sheets link or a bare file id; stores only the id. */
export function fileIdFrom(input: string): string | null {
  const s = input.trim();
  const m = /\/(?:spreadsheets\/d|file\/d)\/([A-Za-z0-9_-]{20,80})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{20,80})/.exec(s);
  const id = m ? m[1] : s;
  return FILE_ID.test(id) ? id : null;
}

export function registerSettings(r: Router) {
  r.get("/settings", async ({ session }) => ({
    ...(await sourceStatus()),
    sheetReaderConfigured: readerConfigured(),
    activeJobs: await activeJobs(),
    syncRuns: await query(`select r.id, s.label, r.trigger, r.started_at, r.finished_at, r.outcome, r.created_count, r.updated_count, r.unchanged_count, r.review_count, r.error, r.tabs_read
                             from sync_runs r join sheet_sources s on s.id = r.sheet_source_id order by r.started_at desc limit 30`),
    imports: await query(`select id, source_id, business_id, submission_id, revision, corrects_submission_id, to_char(period_start,'YYYY-MM-DD') period_start,
                                 to_char(period_end,'YYYY-MM-DD') period_end, completeness, outcome, accepted_count, rejected_count, errors, actor, received_at, status
                            from import_runs order by received_at desc limit 50`),
    scopeRules: { excludedBrands: excludedBrands(), trackedChannels: trackedChannels() },
    clients: session.role === "admin" ? await listClients() : [],
    role: session.role,
  }));

  r.post("/settings/sheet-sources", async ({ req, session }) => {
    const b = z.object({
      business_id: z.enum(["sb", "p2s", "perksradar"]), year: z.number().int().min(2020).max(2100).nullable(),
      role: z.enum(["annual_calendar", "seasonal_program", "intake"]), label: z.string().trim().min(2).max(120),
      file: z.string().min(10).max(500), file_kind: z.enum(["google_sheet", "xlsx"]), sync_interval_minutes: z.number().int().min(15).max(10080).default(360),
    }).safeParse(await readJson(req));
    if (!b.success) throw badRequest("Check the spreadsheet details.");
    if (b.data.role !== "intake" && !b.data.year) throw badRequest("Calendar spreadsheets need a year.");
    const id = fileIdFrom(b.data.file);
    if (!id) throw badRequest("That does not look like a Google Drive or Sheets link.");
    const row = await one<{ id: string }>(
      `insert into sheet_sources (business_id, year, role, label, file_id, file_kind, sync_interval_minutes, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [b.data.business_id, b.data.year, b.data.role, b.data.label, id, b.data.file_kind, b.data.sync_interval_minutes, session.email]);
    await audit(session.email, "sheet_source.create", "sheet_source", row!.id);
    return { id: row!.id };
  }, "admin");
  r.patch("/settings/sheet-sources/:id", async ({ req, params, session }) => {
    const b = z.object({ active: z.boolean().optional(), sync_interval_minutes: z.number().int().min(15).max(10080).optional(), label: z.string().trim().min(2).max(120).optional() }).strict().safeParse(await readJson(req));
    if (!b.success || !Object.keys(b.data).length) throw badRequest("Nothing to change.");
    const keys = Object.keys(b.data);
    const res = await query(`update sheet_sources set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning id`, [params.id, ...keys.map((k) => (b.data as any)[k])]);
    if (!res.length) throw notFound("Spreadsheet source");
    await audit(session.email, "sheet_source.update", "sheet_source", params.id, b.data);
    return { ok: true };
  }, "admin");
  // "Refresh from spreadsheet"
  // Queues the sync and starts the background function; the page follows the job until it finishes.
  r.post("/settings/sheet-sources/:id/refresh", async ({ params, session }) => {
    const r = await enqueueSheetSync(params.id, "manual", session.email);
    return json(r, r.outcome === "queued" ? 202 : r.outcome === "already_running" ? 200 : 503);
  });
  r.get("/settings/sync-jobs/:id", async ({ params }) => {
    if (!/^[0-9a-f-]{36}$/.test(params.id)) throw notFound("Sync job");
    const j = await getJob(params.id);
    if (!j) throw notFound("Sync job");
    return j;
  });

  r.post("/settings/automation-clients", async ({ req, session }) => {
    const b = z.object({ label: z.string().trim().min(2).max(120), sources: z.array(z.string().regex(/^[a-z0-9_.*-]{1,60}$/)).min(1).max(20), businesses: z.array(z.enum(["sb", "p2s", "perksradar"])).min(1) })
      .safeParse(await readJson(req));
    if (!b.success) throw badRequest("Label, sources and businesses are required.");
    const c = await createClient(b.data.label, b.data.sources, b.data.businesses, session.email);
    await audit(session.email, "automation_client.create", "automation_client", c.id);
    return { id: c.id, token: c.token, note: "Copy this token now. It is not shown again." };
  }, "admin");
  r.post("/settings/automation-clients/:id/revoke", async ({ params, session }) => {
    await revokeClient(params.id);
    await audit(session.email, "automation_client.revoke", "automation_client", params.id);
    return { ok: true };
  }, "admin");
  r.post("/settings/campaigns/:id/include", async ({ req, params, session }) => {
    const b = await readJson(req);
    if (b.include === false) await query("delete from campaign_inclusions where campaign_id = $1", [params.id]);
    else await query("insert into campaign_inclusions (campaign_id, included_by, note) values ($1,$2,$3) on conflict do nothing", [params.id, session.email, typeof b.note === "string" ? b.note.slice(0, 300) : null]);
    return { ok: true };
  });
}

export { HttpError };
