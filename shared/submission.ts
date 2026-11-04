// The validated import model. Scheduled tasks submit through the API or by appending rows to the intake
// spreadsheet; both paths produce this same payload and go through the same validation.
import { z } from "zod";
import { isIsoDate } from "./dates";

export const SCHEMA_VERSION = 1;

const isoDate = z.string().refine(isIsoDate, "must be a valid YYYY-MM-DD date");
const tz = z.string().min(3).max(64).refine((t) => { try { new Intl.DateTimeFormat("en", { timeZone: t }); return true; } catch { return false; } }, "unknown timezone");
const money = z.number().finite();
const nonNeg = z.number().finite().min(0);
const valueState = z.enum(["value", "missing", "not_applicable", "incomplete"]);
const safeText = (max: number) => z.string().trim().min(1).max(max);
const url = z.string().max(2000).regex(/^https:\/\/[^\s]+$/, "must be an https URL");
const id = z.string().regex(/^[A-Za-z0-9_.:-]{3,120}$/, "use letters, numbers, . _ : - (3 to 120 characters)");

export const observationSchema = z.object({
  metric: z.string().regex(/^[a-z0-9_]{2,60}$/),
  scope: z.string().regex(/^[a-z0-9_:.-]{1,80}$/).default("all"),
  scope_label: z.string().max(120).optional(),
  period_start: isoDate.optional(),             // defaults to the submission period
  period_end: isoDate.optional(),
  granularity: z.enum(["day", "week", "month", "rolling_30", "custom"]).optional(),
  value: z.number().finite().nullable(),
  state: valueState.default("value"),
  attribution: z.string().max(120).optional(),
}).refine((o) => (o.state === "value") === (o.value !== null), { message: "value must be set exactly when state is 'value' (zero is a value; use 'missing' for no data)" });

export const campaignSchema = z.object({
  platform: z.string().regex(/^[a-z0-9_]{2,30}$/),
  external_id: z.string().min(1).max(120),
  name: safeText(300),
  status: z.string().max(40).optional(),         // current status as observed
  status_observed_at: z.string().datetime({ offset: true }).optional(),
  spend: money.nullable(),
  acquisitions: nonNeg.nullable().optional(),
  acquisition_event: z.string().max(60).default("purchase"),
  conversion_value: money.nullable().optional(),
  attribution: z.string().max(120).optional(),
  reported_cpa: money.nullable().optional(),
  reported_roas: money.nullable().optional(),
}).refine((c) => !c.status || c.status_observed_at, { message: "status needs status_observed_at" });

export const activitySchema = z.object({
  type: z.enum(["content", "social", "pitching", "vendor", "ai_tool", "outreach", "listing", "other"]),
  name: safeText(300),
  count: nonNeg.nullable().optional(),
  count_unit: z.string().max(80).optional(),     // keeps the meaning, e.g. "social posts per channel"
  link: url.optional(),
}).refine((a) => a.count === undefined || a.count === null || !!a.count_unit, { message: "a count needs count_unit so it keeps its meaning" });

export const productRowSchema = z.object({
  external_id: z.string().min(1).max(120),
  title: safeText(300),
  vendor: z.string().max(120).optional(),
  category: z.string().max(120).optional(),
  genus: z.string().max(120).optional(),
  url: url.optional(),
  channel_scope: z.string().regex(/^[a-z0-9_:,.-]{2,120}$/),
  revenue: money.nullable(),
  units: nonNeg.nullable(),
  orders: nonNeg.nullable().optional(),
  gross_profit: money.nullable().optional(),     // null when cost is missing; never send 0 for unknown cost
  cost_state: z.enum(["complete", "partial", "missing", "not_applicable"]).default("missing"),
}).refine((p) => p.cost_state === "complete" || p.cost_state === "partial" || p.gross_profit === null || p.gross_profit === undefined,
  { message: "gross_profit must be null when cost is missing" });

const fmt = z.enum(["digital", "printed", "physical"]);
const listingId = z.string().regex(/^[0-9]{4,20}$/);
export const listingReviewSchema = z.object({
  run_id: id,
  window_start: isoDate,
  window_end: isoDate,
  scope_note: safeText(300),
  excluded_listing_ids: z.array(listingId).default([]),
  listings: z.array(z.object({
    listing_id: listingId, title: safeText(300), url: url.optional(),
    clicks: nonNeg.nullable(), orders: nonNeg.nullable(), spend: money.nullable(),
  })).max(200),
  our_options: z.array(z.object({
    listing_id: listingId, option_key: z.string().min(1).max(80), label: safeText(200), format: fmt,
    size: z.string().max(60).optional(), pages: z.number().int().positive().optional(), pack_qty: z.number().int().positive().optional(),
    addons: z.string().max(200).optional(), price: nonNeg,
  })).max(2000).default([]),
  keywords: z.array(z.object({
    listing_id: listingId, keyword: safeText(200), kind: z.enum(["reported", "fallback_title_phrase"]),
    views: nonNeg.nullable().optional(), clicks: nonNeg.nullable().optional(), orders: nonNeg.nullable().optional(),
    sample_size: z.number().int().min(0).optional(), sampling_scope: z.string().max(200).optional(),
    min_price: nonNeg.optional(), median_price: nonNeg.optional(), max_price: nonNeg.optional(), pct_digital: z.number().min(0).max(100).optional(),
  }).refine((k) => k.median_price === undefined || (k.sample_size !== undefined && !!k.sampling_scope), { message: "market price statistics need sample_size and sampling_scope" })
    .refine((k) => k.kind === "reported" || (k.views == null && k.clicks == null && k.orders == null), { message: "a fallback title phrase has no reported views, clicks or orders" })).max(2000).default([]),
  competitor_options: z.array(z.object({
    listing_id: listingId, keyword: z.string().max(200).optional(), competitor_listing_id: z.string().regex(/^[0-9]{4,20}$/).optional(),
    competitor_url: url, competitor_title: z.string().max(300).optional(), option_label: safeText(200), format: fmt,
    size: z.string().max(60).optional(), pages: z.number().int().positive().optional(), pack_qty: z.number().int().positive().optional(),
    addons: z.string().max(200).optional(), price: nonNeg, original_price: nonNeg.optional(),
    price_basis: z.enum(["option", "from_price"]).default("option"), bestseller: z.boolean().optional(), review_count: z.number().int().min(0).optional(),
  })).max(5000).default([]),
  findings: z.array(z.object({
    finding_key: id, listing_id: listingId.optional(),
    category: z.enum(["pricing", "title", "description", "specification", "options", "keyword", "other"]),
    statement: safeText(2000), is_suggestion: z.boolean().default(false),
    sensitive_topic: z.enum(["guarantee", "shipping_promise", "proof", "product_option"]).optional(),
    depends_on: z.array(id).default([]),
  })).max(2000).default([]),
  corrections: z.array(z.object({
    supersedes_run_id: id, supersedes_finding_key: id, replacement_finding_key: id.optional(), reason: safeText(1000),
  })).max(500).default([]),
}).refine((r) => r.window_end >= r.window_start, { message: "window_end is before window_start" });

export const submissionSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  submission_id: id,
  source: z.string().regex(/^[a-z0-9_.-]{2,60}$/),
  business: z.enum(["sb", "p2s", "perksradar"]),
  period: z.object({ start: isoDate, end: isoDate, granularity: z.enum(["day", "week", "month", "rolling_30", "custom"]), timezone: tz })
    .refine((p) => p.end >= p.start, { message: "period end is before start" }),
  collected_at: z.string().datetime({ offset: true }),
  completeness: z.enum(["complete", "partial", "provisional", "incomplete"]),
  corrects: id.optional(),                        // the submission_id this one corrects
  records: z.object({
    observations: z.array(observationSchema).max(5000).optional(),
    campaigns: z.array(campaignSchema).max(1000).optional(),
    activities: z.array(activitySchema).max(1000).optional(),
    products: z.array(productRowSchema).max(5000).optional(),
    listing_review: listingReviewSchema.optional(),
  }).refine((r) => Object.values(r).some((v) => v !== undefined), { message: "records is empty" }),
  source_refs: z.array(z.object({ label: z.string().max(200), url: url.optional() })).max(50).optional(),
});
export type Submission = z.infer<typeof submissionSchema>;

/** Readable validation errors with paths, for receipts. */
export function validationErrors(e: z.ZodError) {
  return e.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), message: i.message }));
}

/**
 * Envelope check first (whole submission rejected if it fails), then each record on its own so a receipt can
 * list accepted and rejected records. Any rejected record marks the import as incomplete.
 */
export const envelopeSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  submission_id: id,
  source: z.string().regex(/^[a-z0-9_.-]{2,60}$/),
  business: z.enum(["sb", "p2s", "perksradar"]),
  period: z.object({ start: isoDate, end: isoDate, granularity: z.enum(["day", "week", "month", "rolling_30", "custom"]), timezone: tz })
    .refine((p) => p.end >= p.start, { message: "period end is before start" }),
  collected_at: z.string().datetime({ offset: true }),
  completeness: z.enum(["complete", "partial", "provisional", "incomplete"]),
  corrects: id.optional(),
  records: z.object({
    observations: z.array(z.unknown()).max(5000).optional(),
    campaigns: z.array(z.unknown()).max(1000).optional(),
    activities: z.array(z.unknown()).max(1000).optional(),
    products: z.array(z.unknown()).max(5000).optional(),
    listing_review: z.unknown().optional(),
  }).strict().refine((r) => Object.values(r).some((v) => v !== undefined), { message: "records is empty" }),
  source_refs: z.array(z.object({ label: z.string().max(200), url: url.optional() })).max(50).optional(),
});

export type RecordKind = "observations" | "campaigns" | "activities" | "products";
export const RECORD_SCHEMAS = { observations: observationSchema, campaigns: campaignSchema, activities: activitySchema, products: productRowSchema };

export type CheckedSubmission = {
  envelope: z.infer<typeof envelopeSchema>;
  accepted: { observations: z.infer<typeof observationSchema>[]; campaigns: z.infer<typeof campaignSchema>[]; activities: z.infer<typeof activitySchema>[]; products: z.infer<typeof productRowSchema>[]; listing_review?: z.infer<typeof listingReviewSchema> };
  rejected: { kind: string; index: number; errors: { path: string; message: string }[] }[];
};

export function checkSubmission(body: unknown): { ok: false; errors: { path: string; message: string }[] } | { ok: true; value: CheckedSubmission } {
  const env = envelopeSchema.safeParse(body);
  if (!env.success) return { ok: false, errors: validationErrors(env.error) };
  const accepted: CheckedSubmission["accepted"] = { observations: [], campaigns: [], activities: [], products: [] };
  const rejected: CheckedSubmission["rejected"] = [];
  for (const kind of ["observations", "campaigns", "activities", "products"] as RecordKind[]) {
    (env.data.records[kind] ?? []).forEach((rec, index) => {
      const r = (RECORD_SCHEMAS[kind] as z.ZodTypeAny).safeParse(rec);
      if (r.success) (accepted[kind] as unknown[]).push(r.data);
      else rejected.push({ kind, index, errors: validationErrors(r.error) });
    });
  }
  // A correction that carries gross profit or its revenue basis must carry both, for the same scope and period, so a
  // corrected profit can never end up paired with nothing or with a stale basis.
  if (env.data.corrects) {
    const key = (o: { scope: string; period_start?: string; period_end?: string; granularity?: string }) => `${o.scope}|${o.period_start ?? ""}|${o.period_end ?? ""}|${o.granularity ?? ""}`;
    const gp = new Set(accepted.observations.filter((o) => o.metric === "gross_profit").map(key));
    const basis = new Set(accepted.observations.filter((o) => o.metric === "gross_profit_revenue_basis").map(key));
    const unpaired = [...gp].filter((k) => !basis.has(k)).concat([...basis].filter((k) => !gp.has(k)));
    if (unpaired.length) return { ok: false, errors: [{ path: "records.observations", message: "A correction must send gross_profit and gross_profit_revenue_basis together, for the same scope and period" }] };
  }
  if (env.data.records.listing_review !== undefined) {
    const r = listingReviewSchema.safeParse(env.data.records.listing_review);
    if (r.success) accepted.listing_review = r.data;
    else rejected.push({ kind: "listing_review", index: 0, errors: validationErrors(r.error) });
  }
  return { ok: true, value: { envelope: env.data, accepted, rejected } };
}
