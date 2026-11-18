// Pull adapter for the Corporate Gifting app's read-only reporting API (GET /api/reporting/v1/months).
//   CORPORATE_GIFTING_API_URL           the Corporate Gifting site origin
//   CORPORATE_GIFTING_REPORTING_SECRET  that app's CORPORATE_REPORTING_SECRET (its own revocable credential)
//
// Ownership: this integration is the source of corporate channel figures (scope channel:corporate): monthly
// revenue, and Shopify order and unit counts. Corporate revenue is shown separately and never added to business
// totals. Orders and units count Shopify orders only, so for a month that also has manual revenue they are sent
// as incomplete (never as a figure that would understate them).
// A month whose content revision changed is sent as a correction of the earlier submission.
import { z } from "zod";
import { applyPulled, walkPages } from "./pullApply";
import { originOf, getJson, sendJson } from "./reportingClient";
import { HttpError } from "../http";

export const CG_SOURCE_ID = "pull.corporate_gifting";
export const CG_SUBMITTER = "pull:corporate_gifting";
export const CG_SCOPE = "channel:corporate";
const CG_WHO = { sourceId: "pull.corporate_gifting", submitter: "pull:corporate_gifting", submissionSource: "corporate_gifting" };
const MAX_PAGES = 20;

export const corporateGiftingCredentials = () => !!originOf(process.env.CORPORATE_GIFTING_API_URL) && (process.env.CORPORATE_GIFTING_REPORTING_SECRET ?? "").length >= 32;
/**
 * Off until the ownership change is confirmed: corporate channel figures move from the weekly report task to this
 * pull, and the weekly report's existing channel:corporate rows must be reconciled first. Credentials alone do not
 * connect it; CORPORATE_GIFTING_PULL_ENABLED=true does, deliberately.
 */
export const corporateGiftingConfigured = () => corporateGiftingCredentials() && process.env.CORPORATE_GIFTING_PULL_ENABLED === "true";
export const corporateGiftingHeld = () => corporateGiftingCredentials() && process.env.CORPORATE_GIFTING_PULL_ENABLED !== "true"
  ? "Credentials are set, but the pull stays off until the ownership change for corporate figures is confirmed (CORPORATE_GIFTING_PULL_ENABLED)." : null;

const cents = z.number().int();
const monthSchema = z.object({
  id: z.string().regex(/^cg:month:\d{4}-\d{2}$/), revision: z.string().regex(/^[0-9a-f]{16}$/),
  period: z.object({ start: z.string(), end: z.string(), granularity: z.literal("month"), timezone: z.string() }),
  completeness: z.enum(["complete", "provisional", "partial"]), completeness_reasons: z.array(z.string()),
  totals: z.object({ net_revenue_cents: cents, shopify_net_revenue_cents: cents, manual_net_revenue_cents: cents, manual_entries: cents.min(0), shopify_orders: cents.min(0), shopify_units: cents.min(0) }).passthrough(),
});
const pageSchema = z.object({ ok: z.literal(true), schema_version: z.literal(1), as_of: z.string().nullable(), months: z.array(z.unknown()), next_cursor: z.string().nullable() });
type Month = z.infer<typeof monthSchema>;

export function monthToSubmission(m: Month, asOf: string | null) {
  const month = m.period.start.slice(0, 7);
  // The source's count of manual entries, not their net amount: a sale and its refund cancel out to zero but are still manual.
  const manual = m.totals.manual_entries > 0;
  const count = (metric: string, v: number) => manual
    ? { metric, scope: CG_SCOPE, value: null, state: "incomplete" as const }      // manual revenue has no order counts
    : { metric, scope: CG_SCOPE, value: v };
  return {
    schema_version: 1,
    submission_id: `cg:${month}:${m.revision}`,
    source: "corporate_gifting", business: "sb" as const,
    period: { start: m.period.start, end: m.period.end, granularity: "month" as const, timezone: m.period.timezone },
    collected_at: new Date(asOf ?? Date.now()).toISOString(),
    completeness: m.completeness,
    records: {
      observations: [
        { metric: "revenue", scope: CG_SCOPE, scope_label: "Corporate gifting", value: m.totals.net_revenue_cents / 100 },
        count("orders", m.totals.shopify_orders),
        count("units", m.totals.shopify_units),
      ],
    },
    source_refs: [{ label: `Corporate Gifting ${month}${m.completeness_reasons.length ? ` (${m.completeness_reasons.join(", ").replace(/_/g, " ")})` : ""}` }],
  };
}

export async function pullCorporateGifting(actor = CG_SUBMITTER) {
  if (!corporateGiftingConfigured()) return { outcome: "not_configured" as const, results: [], problems: [] };
  const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
  const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
  const results: any[] = [];
  let asOf: string | null = null;
  const problems = await walkPages<unknown>("Corporate Gifting", MAX_PAGES, async (cursor) => {
    const page = pageSchema.parse(await getJson(origin, `/api/reporting/v1/months?limit=24${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, headers, "Corporate Gifting"));
    asOf = page.as_of;
    return { items: page.months, next: page.next_cursor };
  }, async (item) => {
    const parsed = monthSchema.safeParse(item);
    if (!parsed.success) { results.push({ outcome: "rejected", reason: "unexpected month format" }); return; }
    const m = parsed.data, month = m.period.start.slice(0, 7);
    results.push({ month, ...(await applyPulled(monthToSubmission(m, asOf), `cg:${month}:`, CG_WHO, actor)) });
  });
  return { outcome: problems.length ? "incomplete" as const : "done" as const, results, problems };
}

// All-time corporate sample box signups, read from the Corporate Gifting app (the only source; the signup rows and
// contact details stay in its private Google Sheet). Count only. Not tied to the dashboard's date filter, and
// independent of CORPORATE_GIFTING_PULL_ENABLED (that switch governs the monthly figures pull). A successful count
// is cached for two minutes so page views stay well inside the source's reporting rate limit; a failure is never
// cached and never shown as zero.
const sampleSignupsSchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal(1),
  count: z.number().int().nonnegative(),
  checked_at: z.string().optional(),
});
export type SampleSignups = { count: number; checked_at: string | null } | { count: null; reason: "not_configured" | "unavailable" };
const SAMPLE_CACHE_MS = 2 * 60_000;
let sampleCache: { at: number; value: { count: number; checked_at: string | null } } | null = null;
/** Tests only. */
export function _clearSampleSignupsCache() { sampleCache = null; }

export async function corporateSampleSignups(now = Date.now()): Promise<SampleSignups> {
  if (!corporateGiftingCredentials()) return { count: null, reason: "not_configured" };
  if (sampleCache && now - sampleCache.at < SAMPLE_CACHE_MS) return sampleCache.value;
  try {
    const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
    const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
    const report = sampleSignupsSchema.parse(await getJson(origin, "/api/reporting/v1/sample-signups", headers, "Corporate Gifting sample signups"));
    const value = { count: report.count, checked_at: report.checked_at ?? null };
    sampleCache = { at: now, value };
    return value;
  } catch {
    return { count: null, reason: "unavailable" };
  }
}

// Corporate gifting workflow summary from the Corporate Gifting app (its Supplier Resources / Slack workflow):
// sample box progress, open and overdue follow-ups, and recent decisions and blockers as one-line titles. Only these
// fields are kept (anything else the source sends is dropped); supplier files, quotes, terms, contacts and Slack
// messages stay in the Corporate Gifting app. Live read with a two-minute cache, like the signup count.
const sampleStatusCounts = z.object({
  requested: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), shipped: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(),
});
const workflowSchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal(1),
  as_of: z.string().nullable(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sample_progress: z.object({ tracked: z.number().int().nonnegative(), by_status: sampleStatusCounts }),
  follow_ups: z.object({ open: z.number().int().nonnegative(), overdue: z.number().int().nonnegative() }),
  recent: z.array(z.object({
    kind: z.enum(["decision", "blocker"]),
    title: z.string().max(120),
    supplier: z.string().max(120).nullable(),
    at: z.string(),
    status: z.enum(["open", "done", "cancelled"]),
  })).max(8),
});
export type CorporateWorkflow = z.infer<typeof workflowSchema> | { ok: false; reason: "not_configured" | "unavailable" };
let workflowCache: { at: number; value: z.infer<typeof workflowSchema> } | null = null;
/** Tests only. */
export function _clearWorkflowCache() { workflowCache = null; }

export async function corporateWorkflow(now = Date.now()): Promise<CorporateWorkflow> {
  if (!corporateGiftingCredentials()) return { ok: false, reason: "not_configured" };
  if (workflowCache && now - workflowCache.at < SAMPLE_CACHE_MS) return workflowCache.value;
  try {
    const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
    const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
    const value = workflowSchema.parse(await getJson(origin, "/api/reporting/v1/corporate-workflow", headers, "Corporate Gifting workflow"));
    workflowCache = { at: now, value };
    return value;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

// Corporate Gifts tasks (explicit, open actions for its marketplaces) that this dashboard turns into Task Tracker
// tasks after the planning owner's review. Read with the same reporting credential; the only write on that
// connection is the delivery receipt (in review / delivered with the Task Tracker task id / failed / dismissed /
// resolved). "resolved" (handled without a task) is shared by both apps: Corporate Gifts lists it in the feed when it
// was resolved there, and advertises `capabilities: ["resolved"]` once it accepts "resolved" receipts. Until then the
// dashboard holds its own resolutions back instead of sending a state Corporate Gifts would refuse.
const cgTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(300),
  brief: z.string().max(1500).nullable(),
  owner_hint: z.string().max(80).nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  slack_status: z.enum(["open", "done", "cancelled"]),
  content_version: z.number().int().min(1),
  delivery_status: z.enum(["pending", "in_review", "delivered", "failed", "dismissed", "resolved"]),
  delivered_version: z.number().int().nullable(),
  tracker_task_id: z.string().max(80).nullable(),
  // Links must point at the Corporate Gifting app itself (its configured origin).
  partners: z.array(z.object({ name: z.string().min(1).max(120), url: z.string().url().max(500).refine((u) => {
    try { return new URL(u).origin === originOf(process.env.CORPORATE_GIFTING_API_URL); } catch { return false; }
  }, "must link to the Corporate Gifting app") })).max(20),
});
export type CgTask = z.infer<typeof cgTaskSchema>;
const cgTasksPage = z.object({ ok: z.literal(true), schema_version: z.literal(1), as_of: z.string(), tasks: z.array(z.unknown()).max(200),
  capabilities: z.array(z.string().max(40)).max(20).optional() });

export async function fetchCorporateTasks(since: string | null): Promise<{ as_of: string; tasks: CgTask[]; rejected: number; resolvedSupported: boolean }> {
  if (!corporateGiftingCredentials()) throw new HttpError(503, "not_configured", "Corporate Gifting is not connected.");
  const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
  const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
  const page = cgTasksPage.parse(await getJson(origin, `/api/reporting/v1/corporate-tasks${since ? `?since=${encodeURIComponent(since)}` : ""}`, headers, "Corporate Gifting tasks"));
  const tasks: CgTask[] = [];
  let rejected = 0;
  for (const t of page.tasks) { const r = cgTaskSchema.safeParse(t); if (r.success) tasks.push(r.data); else rejected++; }
  return { as_of: page.as_of, tasks, rejected, resolvedSupported: (page.capabilities ?? []).includes("resolved") };
}

export type TaskReceipt = {
  id: string; content_version: number; state: "in_review" | "delivered" | "failed" | "dismissed" | "resolved";
  tracker?: { task_id: string; status: "open" | "done" | "deleted"; assignee?: string | null; due_date?: string | null; open_url?: string | null };
  error?: string;
};
export async function sendTaskReceipts(receipts: TaskReceipt[]) {
  if (!receipts.length) return { ok: true };
  if (!corporateGiftingCredentials()) throw new HttpError(503, "not_configured", "Corporate Gifting is not connected.");
  const origin = originOf(process.env.CORPORATE_GIFTING_API_URL)!;
  const headers = { authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` };
  const r = await sendJson(origin, "POST", "/api/reporting/v1/corporate-task-receipts", headers, { receipts }, "Corporate Gifting receipts");
  if (r.status !== 200) throw new HttpError(502, "receipts_failed", `Corporate Gifting did not accept the delivery receipts (${r.status}).`);
  return r.body;
}
