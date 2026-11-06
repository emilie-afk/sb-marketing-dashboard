// Applies a checked submission. Rules:
// - Same source + submission_id + identical content: 'unchanged' receipt, nothing written twice.
// - Same submission_id with different content: rejected; a change must be sent as a correction ('corrects').
// - A correction supersedes the prior run's records (kept for history) and adds a new revision.
// - A period already reported by another submission is rejected unless the new one is a correction.
// - Any failure rolls back; the last successful data stays in place and the failure is recorded.
// - Ownership: duplicate detection and corrections only ever match runs from the same submitter (integration),
//   business and envelope source, so one integration can never replace or correct another's data.
import { createHash } from "node:crypto";
import type pg from "pg";
import { tx, one, query, getPool } from "./db";
import { HttpError } from "./http";
import { CheckedSubmission } from "../shared/submission";
import { applyCorrections } from "../shared/listingReview";
import { isExcludedBrand } from "../shared/scope";
import { logServerError } from "./redact";

export type Receipt = {
  outcome: "accepted" | "unchanged" | "rejected" | "failed";
  import_run_id?: string;
  submission_id: string;
  revision?: number;
  accepted: Record<string, number>;
  rejected: { kind: string; index: number; errors: { path: string; message: string }[] }[];
  message: string;
  last_successful_at?: string | null;
};

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const contentHash = (s: CheckedSubmission) => createHash("sha256").update(stable({ e: { ...s.envelope, records: undefined }, a: s.accepted })).digest("hex");

const counts = (s: CheckedSubmission) => ({
  observations: s.accepted.observations.length, campaigns: s.accepted.campaigns.length, activities: s.accepted.activities.length,
  products: s.accepted.products.length, listing_review: s.accepted.listing_review ? 1 : 0,
});

export async function applySubmission(sub: CheckedSubmission, actor: string, sourceId: string, submitter: string): Promise<Receipt> {
  const env = sub.envelope;
  const scope = [sourceId, submitter, env.business, env.source];
  const SCOPE_SQL = "source_id = $1 and submitter = $2 and business_id = $3 and submission_source = $4";
  const hash = contentHash(sub);
  const base = { submission_id: env.submission_id, accepted: counts(sub), rejected: sub.rejected };

  const existing = await one<{ id: string; content_hash: string; revision: number }>(
    `select id, content_hash, revision from import_runs where ${SCOPE_SQL} and submission_id = $5 and status = 'active'`, [...scope, env.submission_id]);
  if (existing) {
    if (existing.content_hash === hash) {
      await recordRun(sourceId, submitter, env, hash, "unchanged", actor, sub, existing.revision, null);
      return { ...base, outcome: "unchanged", import_run_id: existing.id, revision: existing.revision, message: "Already received with identical content. Nothing changed." };
    }
    return reject(`Submission ${env.submission_id} was already accepted with different content. Send a new submission_id with "corrects": "${env.submission_id}".`);
  }

  try {
    const receipt = await tx(async (c) => {
      let revision = 1, prior: { id: string; revision: number } | null = null;
      if (env.corrects) {
        prior = (await c.query(`select id, revision from import_runs where ${SCOPE_SQL} and submission_id = $5 and status = 'active' for update`, [...scope, env.corrects])).rows[0] ?? null;
        if (!prior) throw new HttpError(409, "unknown_correction_target", `No accepted submission ${env.corrects} from this integration, business and source to correct.`);
        revision = prior.revision + 1;
      }
      const run = (await c.query(
        `insert into import_runs (source_id, business_id, submission_id, schema_version, content_hash, revision, corrects_submission_id,
           period_start, period_end, timezone, collected_at, completeness, outcome, accepted_count, rejected_count, errors, actor, status, submitter, submission_source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'accepted',$13,$14,$15,$16,'active',$17,$18) returning id`,
        [sourceId, env.business, env.submission_id, env.schema_version, hash, revision, env.corrects ?? null, env.period.start, env.period.end,
          env.period.timezone, env.collected_at, sub.rejected.length ? "incomplete" : env.completeness,
          Object.values(counts(sub)).reduce((a, b) => a + b, 0), sub.rejected.length, JSON.stringify(sub.rejected), actor, submitter, env.source])).rows[0];
      if (prior) await supersedeRun(c, prior.id, run.id);
      await writeRecords(c, sub, run.id, sourceId, { submitter, business: env.business, source: env.source });
      await c.query("update source_connections set status = 'ok', last_success_at = now(), last_error = null, updated_at = now() where id = $1", [sourceId]);
      return { ...base, outcome: "accepted" as const, import_run_id: run.id, revision,
        message: sub.rejected.length ? `Accepted with ${sub.rejected.length} rejected record(s). The import is marked incomplete.` : "Accepted." };
    });
    return receipt;
  } catch (e) {
    if (e instanceof HttpError) return reject(e.message);
    const pgErr = e as { code?: string };
    if (pgErr.code === "23505") return reject("Figures for this period and scope were already reported by another submission. If that submission is yours, send a correction of it; data sent by another integration cannot be replaced.");
    logServerError("import", e);
    await recordRun(sourceId, submitter, env, hash, "failed", actor, sub, 0, "server error").catch(() => {});
    await query("update source_connections set status = 'failing', last_failure_at = now(), last_error = $2, updated_at = now() where id = $1", [sourceId, "Import failed; previous data kept"]).catch(() => {});
    const last = await one<{ at: string }>(`select max(received_at) as at from import_runs where ${SCOPE_SQL} and outcome = 'accepted'`, scope).catch(() => null);
    return { ...base, outcome: "failed", message: "Import failed. Previous data is unchanged.", last_successful_at: last?.at ?? null };
  }

  async function reject(message: string): Promise<Receipt> {
    await recordRun(sourceId, submitter, env, hash, "rejected", actor, sub, 0, message);
    return { ...base, outcome: "rejected", message };
  }
}

async function recordRun(sourceId: string, submitter: string, env: CheckedSubmission["envelope"], hash: string, outcome: string, actor: string, sub: CheckedSubmission, revision: number, error: string | null) {
  await query(
    `insert into import_runs (source_id, business_id, submission_id, schema_version, content_hash, revision, corrects_submission_id, period_start, period_end,
       timezone, collected_at, completeness, outcome, accepted_count, rejected_count, errors, actor, status, submitter, submission_source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,'none',$17,$18)`,
    [sourceId, env.business, env.submission_id, env.schema_version, hash, Math.max(revision, 0), env.corrects ?? null, env.period.start, env.period.end,
      env.period.timezone, env.collected_at, env.completeness, outcome, sub.rejected.length,
      JSON.stringify(error ? [{ path: "", message: error }, ...sub.rejected] : sub.rejected), actor, submitter, env.source]);
}

async function supersedeRun(c: pg.PoolClient, priorId: string, newId: string) {
  await c.query("update import_runs set status = 'superseded', superseded_by = $2 where id = $1", [priorId, newId]);
  for (const t of ["observations", "product_observations", "campaign_performance", "activities", "listing_review_runs"])
    await c.query(`update ${t} set status = 'superseded' where import_run_id = $1`, [priorId]);
}

type Owner = { submitter: string; business: string; source: string };
async function writeRecords(c: pg.PoolClient, sub: CheckedSubmission, runId: string, sourceId: string, owner: Owner) {
  const env = sub.envelope, p = env.period;
  for (const o of sub.accepted.observations) {
    if (o.scope_label && isExcludedBrand(o.scope_label)) continue;
    await c.query(
      `insert into observations (import_run_id, source_id, business_id, metric_key, scope_key, scope_label, period_start, period_end, granularity,
         timezone, value, value_state, completeness, collected_at, attribution)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [runId, sourceId, env.business, o.metric, o.scope, o.scope_label ?? null, o.period_start ?? p.start, o.period_end ?? p.end,
        o.granularity ?? p.granularity, p.timezone, o.value, o.state, env.completeness, env.collected_at, o.attribution ?? null]);
  }
  for (const k of sub.accepted.campaigns) {
    const camp = (await c.query(
      `insert into ad_campaigns (business_id, platform, external_id, name, submitter, submission_source) values ($1,$2,$3,$4,$5,$6)
       on conflict (business_id, platform, external_id, submitter, submission_source) do update set name = excluded.name returning id`,
      [env.business, k.platform, k.external_id, k.name, owner.submitter, owner.source])).rows[0];
    if (k.status) await c.query("insert into campaign_status_history (campaign_id, status, observed_at, import_run_id) values ($1,$2,$3,$4)", [camp.id, k.status, k.status_observed_at, runId]);
    await c.query(
      `insert into campaign_performance (campaign_id, import_run_id, period_start, period_end, granularity, timezone, spend, acquisitions,
         acquisition_event, conversion_value, attribution, reported_cpa, reported_roas, daily_budget, budget_note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [camp.id, runId, p.start, p.end, p.granularity, p.timezone, k.spend, k.acquisitions ?? null, k.acquisition_event, k.conversion_value ?? null,
        k.attribution ?? null, k.reported_cpa ?? null, k.reported_roas ?? null, k.daily_budget ?? null, k.budget_note ?? null]);
  }
  for (const a of sub.accepted.activities) {
    await c.query(
      `insert into activities (import_run_id, business_id, activity_type, name, count, count_unit, period_start, period_end, link)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [runId, env.business, a.type, a.name, a.count ?? null, a.count_unit ?? null, p.start, p.end, a.link ?? null]);
  }
  for (const r of sub.accepted.products) {
    if (r.vendor && isExcludedBrand(r.vendor)) continue;
    const vendorId = r.vendor ? (await c.query(
      "insert into vendors (business_id, name) values ($1,$2) on conflict (business_id, name) do update set name = excluded.name returning id",
      [env.business, r.vendor])).rows[0].id : null;
    const ident = [sourceId, owner.submitter, owner.source, env.business, r.external_id];
    let pid = (await c.query(
      "select product_id from product_source_ids where source_id = $1 and submitter = $2 and submission_source = $3 and business_id = $4 and external_id = $5",
      ident)).rows[0]?.product_id;
    if (!pid) {
      pid = (await c.query("insert into products (business_id, title, vendor_id, category, genus, url, first_seen) values ($1,$2,$3,$4,$5,$6,$7) returning id",
        [env.business, r.title, vendorId, r.category ?? null, r.genus ?? null, r.url ?? null, p.start])).rows[0].id;
      await c.query("insert into product_source_ids (source_id, submitter, submission_source, business_id, external_id, product_id) values ($1,$2,$3,$4,$5,$6)", [...ident, pid]);
    } else {
      await c.query("update products set title = $2, vendor_id = coalesce($3, vendor_id), category = coalesce($4, category), genus = coalesce($5, genus), url = coalesce($6, url) where id = $1",
        [pid, r.title, vendorId, r.category ?? null, r.genus ?? null, r.url ?? null]);
    }
    await c.query(
      `insert into product_observations (import_run_id, product_id, business_id, channel_scope, period_start, period_end, granularity, timezone,
         revenue, units, orders, gross_profit, cost_state, completeness)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [runId, pid, env.business, r.channel_scope, p.start, p.end, p.granularity, p.timezone, r.revenue, r.units, r.orders ?? null,
        r.cost_state === "complete" || r.cost_state === "partial" ? r.gross_profit ?? null : null, r.cost_state, env.completeness]);
  }
  if (sub.accepted.listing_review) await writeListingReview(c, sub, runId, owner);
}

async function writeListingReview(c: pg.PoolClient, sub: CheckedSubmission, runId: string, owner: Owner) {
  const lr = sub.accepted.listing_review!, env = sub.envelope;
  // History is append-only: a corrected check is sent as a NEW run_id whose corrections reference the earlier findings.
  // The earlier run stays (marked superseded when its submission was corrected).
  const old = (await c.query("select run_id from listing_review_runs where run_id = $1", [lr.run_id])).rows[0];
  if (old) throw new HttpError(409, "duplicate_run", `Listing check ${lr.run_id} already exists. Send corrected data under a new run_id with corrections that reference the earlier findings.`);
  await c.query(
    `insert into listing_review_runs (run_id, import_run_id, business_id, window_start, window_end, timezone, collected_at, scope_note, excluded_listing_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [lr.run_id, runId, env.business, lr.window_start, lr.window_end, env.period.timezone, env.collected_at, lr.scope_note, lr.excluded_listing_ids]);
  const listed = new Set(lr.listings.map((l) => l.listing_id));
  for (const l of lr.listings) {
    if (lr.excluded_listing_ids.includes(l.listing_id)) throw new HttpError(422, "excluded_listing", `Listing ${l.listing_id} is excluded from this check but was included.`);
    await c.query("insert into listing_results (run_id, listing_id, title, url, clicks, orders, spend) values ($1,$2,$3,$4,$5,$6,$7)",
      [lr.run_id, l.listing_id, l.title, l.url ?? null, l.clicks, l.orders, l.spend]);
  }
  const needListing = (id: string, what: string) => { if (!listed.has(id)) throw new HttpError(422, "unknown_listing", `${what} refers to listing ${id}, which is not in this check.`); };
  for (const o of lr.our_options) {
    needListing(o.listing_id, "An option");
    await c.query("insert into listing_options (run_id, listing_id, option_key, label, format, size, pages, pack_qty, addons, price) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [lr.run_id, o.listing_id, o.option_key, o.label, o.format, o.size ?? null, o.pages ?? null, o.pack_qty ?? null, o.addons ?? null, o.price]);
  }
  for (const k of lr.keywords) {
    needListing(k.listing_id, "A keyword");
    await c.query("insert into listing_keywords (run_id, listing_id, keyword, kind, views, clicks, orders) values ($1,$2,$3,$4,$5,$6,$7)",
      [lr.run_id, k.listing_id, k.keyword, k.kind, k.views ?? null, k.clicks ?? null, k.orders ?? null]);
    if (k.sample_size !== undefined && k.sampling_scope)
      await c.query(`insert into market_samples (run_id, keyword, sample_size, sampling_scope, min_price, median_price, max_price, pct_digital)
                     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (run_id, keyword) do nothing`,
        [lr.run_id, k.keyword, k.sample_size, k.sampling_scope, k.min_price ?? null, k.median_price ?? null, k.max_price ?? null, k.pct_digital ?? null]);
  }
  for (const o of lr.competitor_options) {
    needListing(o.listing_id, "A competitor option");
    await c.query(
      `insert into competitor_options (run_id, listing_id, keyword, competitor_listing_id, competitor_url, competitor_title, option_label, format, size, pages,
         pack_qty, addons, price, original_price, price_basis, bestseller, review_count) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [lr.run_id, o.listing_id, o.keyword ?? null, o.competitor_listing_id ?? null, o.competitor_url, o.competitor_title ?? null, o.option_label, o.format,
        o.size ?? null, o.pages ?? null, o.pack_qty ?? null, o.addons ?? null, o.price, o.original_price ?? null, o.price_basis, o.bestseller ?? null, o.review_count ?? null]);
  }
  for (const f of lr.findings) {
    if (f.listing_id) needListing(f.listing_id, "A finding");
    await c.query(
      `insert into findings (finding_key, run_id, listing_id, category, statement, is_suggestion, sensitive_topic, depends_on)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [f.finding_key, lr.run_id, f.listing_id ?? null, f.category, f.statement, f.is_suggestion || !!f.sensitive_topic, f.sensitive_topic ?? null, f.depends_on]);
  }
  if (lr.corrections.length) await applyFindingCorrections(c, lr.corrections.map((x) => ({ ...x, replacementRunId: lr.run_id })), `import:${runId}`, owner);
}

/** Supersedes findings (any run) and flags everything that depended on them for review. */
export async function applyFindingCorrections(c: pg.PoolClient,
  corrections: { supersedes_run_id: string; supersedes_finding_key: string; replacement_finding_key?: string; reason: string; replacementRunId?: string }[], actor: string,
  owner?: Owner) {
  for (const corr of corrections) {
    // Imported corrections may only touch findings from checks the same integration submitted for the same business and source.
    // (Team members correcting in the dashboard pass no owner.)
    const target = (await c.query(
      `select f.id, f.run_id from findings f join listing_review_runs r on r.run_id = f.run_id left join import_runs i on i.id = r.import_run_id
        where f.run_id = $1 and f.finding_key = $2
          and ($3::text is null or (i.submitter = $3 and i.business_id = $4 and i.submission_source = $5))`,
      [corr.supersedes_run_id, corr.supersedes_finding_key, owner?.submitter ?? null, owner?.business ?? null, owner?.source ?? null])).rows[0];
    if (!target) throw new HttpError(422, "unknown_finding", `Correction refers to finding ${corr.supersedes_finding_key} in check ${corr.supersedes_run_id}, which this integration did not submit for this business and source, or which does not exist.`);
    const repl = corr.replacement_finding_key
      ? (await c.query("select id from findings where run_id = $1 and finding_key = $2", [corr.replacementRunId ?? corr.supersedes_run_id, corr.replacement_finding_key])).rows[0]
      : null;
    await c.query("insert into finding_corrections (supersedes_finding_id, replacement_finding_id, reason, corrected_by) values ($1,$2,$3,$4)",
      [target.id, repl?.id ?? null, corr.reason, actor]);
    // Dependents can be in the same run (by key). Re-evaluate with the shared rule.
    const rows = (await c.query("select id, finding_key as key, state, depends_on, sensitive_topic, is_suggestion from findings where run_id = $1", [target.run_id])).rows;
    const result = applyCorrections(rows, [{ supersedes: corr.supersedes_finding_key, replacement: corr.replacement_finding_key, reason: corr.reason }]);
    await c.query("update findings set state = 'superseded', superseded_by = $2 where id = $1", [target.id, repl?.id ?? null]);
    for (const key of result.flagged) {
      const f = rows.find((r: any) => r.key === key);
      await c.query("update findings set state = 'needs_review' where id = $1", [f.id]);
      await c.query("insert into review_items (kind, finding_id, details) values ('finding_dependency', $1, $2)",
        [f.id, JSON.stringify({ message: `Depends on finding ${corr.supersedes_finding_key}, which was corrected: ${corr.reason}` })]);
    }
  }
}

export async function lastSuccess(sourceId: string) {
  return one<{ at: string | null }>("select max(received_at) as at from import_runs where source_id = $1 and outcome = 'accepted'", [sourceId]);
}
export { getPool };
