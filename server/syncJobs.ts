// Background sync jobs (spreadsheets and the Plant Revenue Breakdown pull).
//
// Netlify stops scheduled functions after 30 seconds, and a spreadsheet read may take up to the reader's deadline.
// So the scheduled function and "Refresh from spreadsheet" only queue a job and start the background function
// (netlify/functions/sheet-sync-background.ts, up to 15 minutes), which runs the sync.
//
// - Authenticated: the start request is signed with a key derived from SESSION_SECRET (HMAC-SHA256 over the
//   timestamp and body) and must be recent. A job runs only if it is still queued, so a replayed request does nothing.
// - No overlap: a unique index allows one queued or running job per spreadsheet (and one pull). A second request
//   while one is active reports "already running". A job whose lease has passed is marked abandoned first.
// - Last good data is kept: a failed or stopped job never changes promotions or figures (see runSheetSync).
import { createHmac, timingSafeEqual } from "node:crypto";
import { one, query, tx } from "./db";
import { HttpError } from "./http";
import { runSheetSync, dueSources } from "./sheetSync";
import { pullPlantBreakdown, plantBreakdownConfigured } from "./adapters/plantBreakdown";
import { logServerError, redact } from "./redact";

export const JOB_LIMITS = {
  leaseMinutes: 16,            // background functions stop after 15 minutes
  signatureMaxAgeMs: 5 * 60_000,
  dispatchTimeoutMs: 8_000,
};
export const BACKGROUND_PATH = "/.netlify/functions/sheet-sync-background";
const SIG_HEADER = "x-mkd-job-signature";
const TS_HEADER = "x-mkd-job-timestamp";

type Job = { id: string; kind: "sheet" | "plant_breakdown"; sheet_source_id: string | null; trigger: "schedule" | "manual"; actor: string };
export type EnqueueResult = { outcome: "queued"; job_id: string } | { outcome: "already_running"; job_id: string | null } | { outcome: "failed"; job_id: string; error: string };

function jobKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "misconfigured", "SESSION_SECRET is not configured (min 32 chars).");
  return createHmac("sha256", s).update("mkd-sync-job-v1").digest();
}
export function signJob(body: string, ts: string) {
  return createHmac("sha256", jobKey()).update(`${ts}.${body}`).digest("hex");
}
export function verifyJobRequest(body: string, ts: string | null, sig: string | null, now = Date.now()) {
  if (!ts || !sig || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(now - Number(ts)) > JOB_LIMITS.signatureMaxAgeMs) return false;
  const want = Buffer.from(signJob(body, ts), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

// Starts the background function for one job. Replaced in tests.
type Dispatcher = (jobId: string) => Promise<void>;
const defaultDispatcher: Dispatcher = async (jobId) => {
  const base = (process.env.URL || process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("No https site address (URL or APP_BASE_URL) to start the background sync.");
  const body = JSON.stringify({ job_id: jobId });
  const ts = String(Date.now());
  const r = await fetch(`${base}${BACKGROUND_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TS_HEADER]: ts, [SIG_HEADER]: signJob(body, ts) },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(JOB_LIMITS.dispatchTimeoutMs),
  });
  await r.body?.cancel().catch(() => {});
  if (r.status !== 202 && !r.ok) throw new Error(`Background sync did not start (HTTP ${r.status}).`);
};
let dispatcher: Dispatcher = defaultDispatcher;
export function _setDispatcherForTests(d: Dispatcher | null) { dispatcher = d ?? defaultDispatcher; }
export const jobHeaders = { SIG_HEADER, TS_HEADER };

async function abandonExpired(kind: Job["kind"], sourceId: string | null) {
  await query(
    `update sync_jobs set status = 'abandoned', finished_at = now(), error = 'The background sync stopped before finishing. Previous data is unchanged.'
      where kind = $1 and sheet_source_id is not distinct from $2::uuid and status in ('queued','running') and lease_until < now()`, [kind, sourceId]);
}

async function enqueue(kind: Job["kind"], sourceId: string | null, trigger: Job["trigger"], actor: string): Promise<EnqueueResult> {
  await abandonExpired(kind, sourceId);
  const row = await one<{ id: string }>(
    `insert into sync_jobs (kind, sheet_source_id, trigger, actor, lease_until) values ($1,$2,$3,$4, now() + make_interval(mins => $5))
     on conflict do nothing returning id`, [kind, sourceId, trigger, actor, JOB_LIMITS.leaseMinutes]);
  if (!row) {
    const active = await one<{ id: string }>(`select id from sync_jobs where kind = $1 and sheet_source_id is not distinct from $2::uuid and status in ('queued','running')`, [kind, sourceId]);
    return { outcome: "already_running", job_id: active?.id ?? null };
  }
  try {
    await dispatcher(row.id);
    return { outcome: "queued", job_id: row.id };
  } catch (e) {
    logServerError("sync-dispatch", e);
    const error = "The background sync could not be started. Previous data is unchanged. Try again.";
    await query("update sync_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1 and status = 'queued'", [row.id, error]);
    return { outcome: "failed", job_id: row.id, error };
  }
}

/** "Refresh from spreadsheet": queue one spreadsheet. */
export async function enqueueSheetSync(sourceId: string, trigger: Job["trigger"], actor: string) {
  const src = await one("select id from sheet_sources where id = $1 and active", [sourceId]);
  if (!src) throw new HttpError(404, "not_found", "Spreadsheet source not found or inactive.");
  return enqueue("sheet", sourceId, trigger, actor);
}

/** Scheduled function: queue every due spreadsheet (and the hourly pull). Does no reading itself. */
export async function enqueueScheduled(now = new Date()) {
  const work: Promise<EnqueueResult>[] = (await dueSources()).map((s) => enqueue("sheet", s.id, "schedule", "schedule"));
  if (plantBreakdownConfigured() && now.getUTCMinutes() < 15) work.push(enqueue("plant_breakdown", null, "schedule", "schedule"));
  return Promise.all(work);
}

/** Background function: runs one job if it is still queued and its lease is valid. */
export async function runJob(jobId: string) {
  const job = await tx(async (c) => {
    const r = await c.query<Job>(
      `update sync_jobs set status = 'running', started_at = now(), lease_until = now() + make_interval(mins => $2)
        where id = $1 and status = 'queued' and lease_until > now() returning id, kind, sheet_source_id, trigger, actor`, [jobId, JOB_LIMITS.leaseMinutes]);
    return r.rows[0] ?? null;
  });
  if (!job) return { ran: false as const };
  try {
    const result: any = job.kind === "sheet"
      ? await runSheetSync(job.sheet_source_id!, job.trigger, job.actor)
      : await pullPlantBreakdown(job.actor);
    const failed = result?.outcome === "failed";
    await query("update sync_jobs set status = $2, finished_at = now(), result = $3, error = $4 where id = $1 and status = 'running'",
      [job.id, failed ? "failed" : "succeeded", JSON.stringify(result ?? null), failed ? redact(String(result.error ?? "Sync failed."), 500) : null]);
    return { ran: true as const, result };
  } catch (e) {
    logServerError("sync-job", e);
    const msg = e instanceof HttpError ? e.message : "The sync failed. Previous data is unchanged.";
    await query("update sync_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1 and status = 'running'", [job.id, redact(msg, 500)]);
    return { ran: true as const, result: { outcome: "failed", error: msg } };
  }
}

export async function getJob(jobId: string) {
  return one(`select j.id, j.kind, j.status, j.trigger, j.queued_at, j.started_at, j.finished_at, j.result, j.error, s.label
                from sync_jobs j left join sheet_sources s on s.id = j.sheet_source_id where j.id = $1`, [jobId]);
}
export async function activeJobs() {
  return query(`select id, kind, sheet_source_id, status, queued_at, started_at from sync_jobs where status in ('queued','running') and lease_until > now()`);
}
