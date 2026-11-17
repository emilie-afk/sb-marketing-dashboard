// One-way spreadsheet sync: spreadsheet to dashboard. Never writes to a spreadsheet, never deletes promotions.
// A failed read changes nothing and keeps the last successful data visible.
import type pg from "pg";
import { one, query, tx } from "./db";
import { HttpError } from "./http";
import { SheetReader, sheetReader, ReadOptions } from "./sheetsReader";
import { createHash } from "node:crypto";
import { parseDailyAnalytics, parseEosMonths } from "../shared/scorecardParse";
import { applyPulled } from "./adapters/pullApply";
import { todayIn, OPERATIONS_TZ, addDays, daysInMonth } from "../shared/dates";
import { parseAnnualCalendar, parseSeasonalProgram, Sheet, Cell, SOURCE_FIELDS, ParsedWorkbook } from "../shared/calendarParse";
import { planSync, ExistingPromotion, SourceRole } from "../shared/promotionSync";
import { checkSubmission } from "../shared/submission";
import { applySubmission, Receipt } from "./imports";
import { logServerError, redact } from "./redact";

type SheetSource = { id: string; business_id: string; year: number | null; role: SourceRole | "daily_analytics" | "eos_scorecard"; file_id: string; file_kind: "google_sheet" | "xlsx"; label: string };

export async function runSheetSync(sourceId: string, trigger: "schedule" | "manual", actor: string, reader: SheetReader = sheetReader) {
  const src = await one<SheetSource>("select id, business_id, year, role, file_id, file_kind, label from sheet_sources where id = $1 and active", [sourceId]);
  if (!src) throw new HttpError(404, "not_found", "Spreadsheet source not found or inactive.");
  await query("update sheet_sources set last_attempt_at = now() where id = $1", [src.id]);
  const run = (await one<{ id: string }>("insert into sync_runs (sheet_source_id, trigger, actor) values ($1,$2,$3) returning id", [src.id, trigger, actor]))!;

  let sheets: Sheet[];
  try {
    sheets = await reader(src.file_id, src.file_kind, readOptions(src.role));
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "The spreadsheet could not be read.";
    if (!(e instanceof HttpError)) logServerError("sheet-read", e);
    await fail(run.id, src.id, msg);
    return { outcome: "failed" as const, error: msg, sync_run_id: run.id };
  }

  try {
    if (src.role === "intake") return await syncIntake(src, sheets, run.id, actor);
    if (src.role === "daily_analytics" || src.role === "eos_scorecard") return await syncFigures(src, sheets, run.id, actor);
    const parsed = src.role === "annual_calendar" ? parseAnnualCalendar(sheets, src.year!) : parseSeasonalProgram(sheets, src.year!);
    return await applyCalendar(src, parsed, run.id, actor);
  } catch (e) {
    logServerError("sheet-sync", e);
    const msg = e instanceof HttpError ? e.message : "The spreadsheet was read but could not be applied. Nothing changed.";
    await fail(run.id, src.id, msg);
    return { outcome: "failed" as const, error: msg, sync_run_id: run.id };
  }
}

// The two figure workbooks are large (one formatted tab per month or year); only recent tabs and their top rows hold figures.
const FIGURES_FROM_YEAR = 2025;
function readOptions(role: SheetSource["role"]): ReadOptions | undefined {
  const recent = (n: string) => { const y = /(\d{4})\s*$/.exec(n.trim()); return !!y && Number(y[1]) >= FIGURES_FROM_YEAR; };
  if (role === "daily_analytics") return { tabs: recent, maxRows: 80 };
  if (role === "eos_scorecard") return { tabs: recent, maxRows: 60 };
  return undefined;
}

/**
 * Daily Analytics Report → daily revenue and orders; EOS scorecard → month totals. One submission per business and
 * month; a month whose figures changed in the spreadsheet is sent as a correction of the earlier one, an unchanged
 * month writes nothing.
 */
async function syncFigures(src: SheetSource, sheets: Sheet[], runId: string, actor: string) {
  const today = todayIn(OPERATIONS_TZ);
  const daily = src.role === "daily_analytics";
  const batches = daily ? parseDailyAnalytics(sheets, { fromYear: FIGURES_FROM_YEAR, through: addDays(today, -1) }) : parseEosMonths(sheets, { fromYear: FIGURES_FROM_YEAR, today });
  if (!batches.length) throw new HttpError(422, "no_figures", daily ? "No month tabs with daily figures were found (tabs named like \"October 2026\")." : "No finished month columns were found (year tabs with \"TOTAL (MONTH)\" columns).");
  const who = daily ? { sourceId: "sheet.daily_analytics", submitter: `sheet:${src.id}`, submissionSource: "daily_analytics" }
    : { sourceId: "sheet.eos_scorecard", submitter: `sheet:${src.id}`, submissionSource: "eos_scorecard" };
  const receipts: any[] = [];
  for (const b of batches) {
    const [y, m] = b.month.split("-").map(Number);
    const family = `${daily ? "dar" : "eos"}:${b.business}:${b.month}`;
    const records = { observations: b.observations };
    const hash = createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 16);
    const body = {
      schema_version: 1, submission_id: `${family}:${hash}`, source: who.submissionSource, business: b.business,
      period: { start: `${b.month}-01`, end: `${b.month}-${String(daysInMonth(y, m)).padStart(2, "0")}`, granularity: "month", timezone: "America/Los_Angeles" },
      collected_at: new Date().toISOString(), completeness: "complete", records,
      source_refs: [{ label: `${src.label}: ${b.month}` }],
    };
    const r: any = await applyPulled(body, family, who, `sheet:${src.label}`);
    receipts.push({ label: `${b.business} ${b.month}`, outcome: r.outcome, submission_id: r.submission_id, notes: b.notes });
  }
  const changed = receipts.filter((r) => r.outcome === "accepted").length, unchanged = receipts.filter((r) => r.outcome === "unchanged").length;
  const problems = receipts.filter((r) => r.outcome === "rejected" || r.outcome === "failed");
  const outcome = problems.length ? "partial" : "succeeded";
  await query(`update sync_runs set finished_at = now(), outcome = $2, tabs_read = $3, created_count = $4, unchanged_count = $5, review_count = $6, error = $7 where id = $1`,
    [runId, outcome, JSON.stringify(receipts.map((r) => ({ tab: r.label, kind: r.outcome, dataRows: 0, blank: false, skipped: r.notes.length ? redact(r.notes.join("; "), 500) : undefined }))), changed, unchanged, problems.length,
      problems.length ? `${problems.length} month(s) rejected` : null]);
  await query("update sheet_sources set last_success_at = now(), last_error = $2 where id = $1", [src.id, problems.length ? `${problems.length} month(s) rejected` : null]);
  await query("update source_connections set status = $2, last_success_at = now(), last_error = $3, updated_at = now() where id = $1", [who.sourceId, problems.length ? "failing" : "ok", problems.length ? `${problems.length} month(s) rejected` : null]);
  return { outcome, sync_run_id: runId, receipts };
}

async function fail(runId: string, srcId: string, msg: string) {
  await query("update sync_runs set finished_at = now(), outcome = 'failed', error = $2 where id = $1", [runId, redact(msg, 500)]);
  await query("update sheet_sources set last_error = $2 where id = $1", [srcId, redact(msg, 500)]);
}

// Test hook: runs inside the transaction after existing promotions are read (used to force concurrent syncs to overlap).
let afterReadHook: ((src: SheetSource) => Promise<void>) | null = null;
export function _setAfterCalendarReadForTests(h: typeof afterReadHook) { afterReadHook = h; }

async function applyCalendar(src: SheetSource, parsed: ParsedWorkbook, runId: string, actor: string) {
  return tx(async (c) => {
    // Annual and seasonal spreadsheets of the same business can describe the same promotions, and their background
    // jobs may run at the same time. One transaction-scoped lock per business serializes calendar application, taken
    // before anything is read, so each sync plans against the other's committed promotions and ownership links.
    // Transaction-scoped (released at commit or rollback), so it is safe behind a transaction-mode connection pooler.
    await c.query("select pg_advisory_xact_lock(hashtext('mkd.calendar'), hashtext($1))", [src.business_id]);
    // Occasions: source-owned fields only; the "selected for use" link is the dashboard's.
    for (const o of parsed.occasions) {
      await c.query(
        `insert into occasions (sheet_source_id, business_id, identity_key, name, occasion_date, occasion_type, note) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (business_id, identity_key) do update set name = excluded.name, occasion_date = excluded.occasion_date,
           occasion_type = excluded.occasion_type, note = excluded.note, sheet_source_id = excluded.sheet_source_id`,
        [src.id, src.business_id, o.identityKey, o.name, o.date, o.type, o.note]);
    }

    const links = (await c.query(
      "select identity_key as \"identityKey\", promotion_id as \"promotionId\", last_tab as \"lastTab\", last_seen_at as \"lastSeenAt\" from promotion_source_links where sheet_source_id = $1",
      [src.id])).rows;
    const promos = await candidatePromotions(c, src);
    if (afterReadHook) await afterReadHook(src);
    const plan = planSync({ role: src.role as SourceRole, parsed, links, promotions: promos });

    for (const cr of plan.create) {
      const r = cr.record;
      const cols = SOURCE_FIELDS.filter((f) => (r as any)[f] !== undefined);
      const vals = cols.map((f) => (r as any)[f]);
      const id = (await c.query(
        `insert into promotions (business_id, year, kind, created_by, ${cols.join(", ")})
         values ($1, $2, $3, $4, ${cols.map((_, i) => `$${i + 5}`).join(", ")}) returning id`,
        [src.business_id, yearOf(r.start_date, src.year!), r.kind, `sync:${src.label}`, ...vals])).rows[0].id;
      await upsertLink(c, src.id, id, cr.key, r);
      await c.query("insert into promotion_revisions (promotion_id, sync_run_id, changed_by, changes) values ($1,$2,$3,$4)",
        [id, runId, `sync:${src.label}`, JSON.stringify({ created: { from: null, to: r.title } })]);
    }
    for (const l of plan.link) await upsertLink(c, src.id, l.promotionId, l.key, l.record);
    for (const u of plan.update) {
      const fields = Object.keys(u.changes);
      await c.query(
        `update promotions set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = now(), version = version + 1 where id = $1`,
        [u.promotionId, ...fields.map((f) => u.changes[f].to)]);
      await c.query("insert into promotion_revisions (promotion_id, sync_run_id, changed_by, changes) values ($1,$2,$3,$4)",
        [u.promotionId, runId, `sync:${src.label}`, JSON.stringify(u.changes)]);
      await upsertLink(c, src.id, u.promotionId, u.key, u.record);
    }
    for (const u of [...plan.unchanged, ...plan.touchLinks]) await upsertLink(c, src.id, u.promotionId, u.key, u.record);
    for (const m of plan.missing)
      await c.query("update promotions set missing_from_source_since = now(), review_state = 'needs_review' where id = $1 and missing_from_source_since is null", [m.promotionId]);
    for (const id of plan.reappeared)
      await c.query("update promotions set missing_from_source_since = null where id = $1", [id]);
    let reviews = 0;
    for (const rv of plan.reviews) {
      const dup = await c.query(
        `select 1 from review_items where resolved_at is null and kind = $1 and coalesce(promotion_id::text, '') = coalesce($2::text, '')
           and details->>'identity' is not distinct from $3 and coalesce(details->>'tab','') = coalesce($4,'')`,
        [rv.kind, rv.promotionId ?? null, (rv.details.identity as string) ?? null, (rv.details.tab as string) ?? null]);
      if (dup.rowCount) continue;
      await c.query("insert into review_items (kind, promotion_id, sync_run_id, details) values ($1,$2,$3,$4)",
        [rv.kind, rv.promotionId ?? null, runId, JSON.stringify({ ...rv.details, source: src.label })]);
      if (rv.promotionId && (rv.kind === "conflict" || rv.kind === "ambiguous_match"))
        await c.query("update promotions set review_state = 'needs_review' where id = $1", [rv.promotionId]);
      reviews++;
    }
    const outcome = parsed.tabs.some((t) => t.skipped) || parsed.issues.length ? "partial" : "succeeded";
    await c.query(
      `update sync_runs set finished_at = now(), outcome = $2, tabs_read = $3, created_count = $4, updated_count = $5, unchanged_count = $6, review_count = $7 where id = $1`,
      [runId, outcome, JSON.stringify(parsed.tabs), plan.create.length, plan.update.length, plan.unchanged.length + plan.link.length, reviews]);
    await c.query("update sheet_sources set last_success_at = now(), last_error = null where id = $1", [src.id]);
    return { outcome, sync_run_id: runId, created: plan.create.length, updated: plan.update.length, unchanged: plan.unchanged.length, reviews, issues: parsed.issues };
  });
}

const yearOf = (d: string | null, fallback: number) => (d ? Number(d.slice(0, 4)) : fallback);

async function upsertLink(c: pg.PoolClient, srcId: string, promotionId: string, key: string, r: { tab: string; row: number }) {
  await c.query(
    `insert into promotion_source_links (promotion_id, sheet_source_id, identity_key, last_tab, last_row, last_values, last_seen_at)
     values ($1,$2,$3,$4,$5,$6, now())
     on conflict (sheet_source_id, identity_key) do update set promotion_id = excluded.promotion_id, last_tab = excluded.last_tab,
       last_row = excluded.last_row, last_values = excluded.last_values, last_seen_at = now()`,
    [promotionId, srcId, key, r.tab, r.row, JSON.stringify(r)]);
}

async function candidatePromotions(c: pg.PoolClient, src: SheetSource): Promise<ExistingPromotion[]> {
  const rows = (await c.query(
    `select p.*, coalesce((select array_agg(distinct s.role) from promotion_source_links l join sheet_sources s on s.id = l.sheet_source_id
                           where l.promotion_id = p.id and l.sheet_source_id <> $3), '{}') as other_roles
       from promotions p where p.business_id = $1 and p.year between $2 - 1 and $2 + 1`,
    [src.business_id, src.year, src.id])).rows;
  return rows.map((p: any) => ({
    id: p.id, code: p.code, kind: p.kind, start_date: p.start_date, end_date: p.end_date, missing_from_source_since: p.missing_from_source_since,
    fields: Object.fromEntries(SOURCE_FIELDS.map((f) => [f, p[f]])), otherSourceRoles: p.other_roles,
  }));
}

// ------------------------------------------------------------ intake spreadsheet
// Tabs and their columns are documented in docs/INTAKE_SHEET.md. Each tab row maps to the same validated
// submission model as the API, so both paths share validation, idempotency and corrections.
const txt = (c: Cell) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString() : String(c).trim());
function num(c: Cell): number | undefined | null {
  const s = txt(c);
  if (s === "") return undefined;
  if (/^(n\/a|na|missing|-)$/i.test(s)) return null;
  const v = Number(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : (NaN as any);
}
const int = (c: Cell) => { const v = num(c); return v === undefined || v === null ? undefined : v; };
const bool = (c: Cell) => { const s = txt(c).toLowerCase(); return s === "" ? undefined : ["y", "yes", "true", "1"].includes(s); };
const date = (c: Cell) => (c instanceof Date ? c.toISOString().slice(0, 10) : txt(c).slice(0, 10));
const dt = (c: Cell) => (c instanceof Date ? c.toISOString() : txt(c));
const opt = (c: Cell) => txt(c) || undefined;

function table(sheets: Sheet[], name: string): Record<string, Cell>[] {
  const sh = sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (!sh || !sh.rows.length) return [];
  const hdr = sh.rows[0].map((h) => txt(h).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return sh.rows.slice(1).filter((r) => r.some((c) => txt(c) !== "")).map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? null])));
}

export function intakeToSubmissions(sheets: Sheet[]) {
  const subs: { body: any; label: string }[] = [];
  const by = (rows: Record<string, Cell>[], key: string) => {
    const m = new Map<string, Record<string, Cell>[]>();
    for (const r of rows) { const k = txt(r[key]); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  };
  // Listing checks: one submission per Checks row.
  const results = by(table(sheets, "Listing results"), "run_id"), options = by(table(sheets, "Our options"), "run_id");
  const keywords = by(table(sheets, "Keywords"), "run_id"), comps = by(table(sheets, "Competitor options"), "run_id");
  const findings = by(table(sheets, "Findings"), "run_id"), corrections = by(table(sheets, "Corrections"), "run_id");
  for (const ch of table(sheets, "Checks")) {
    const runId = txt(ch.run_id);
    if (!runId) continue;
    subs.push({ label: `Check ${runId}`, body: {
      schema_version: 1, submission_id: `listing-check:${runId}`, source: "etsy_listing_check", business: txt(ch.business) || "p2s",
      period: { start: date(ch.window_start), end: date(ch.window_end), granularity: "rolling_30", timezone: txt(ch.timezone) },
      collected_at: dt(ch.collected_at), completeness: txt(ch.completeness) || "complete",
      records: { listing_review: {
        run_id: runId, window_start: date(ch.window_start), window_end: date(ch.window_end), scope_note: txt(ch.scope_note),
        excluded_listing_ids: txt(ch.excluded_listing_ids).split(/[,\s]+/).filter(Boolean),
        listings: (results.get(runId) ?? []).map((r) => ({ listing_id: txt(r.listing_id), title: txt(r.title), url: opt(r.url), clicks: num(r.clicks) ?? null, orders: num(r.orders) ?? null, spend: num(r.spend) ?? null })),
        our_options: (options.get(runId) ?? []).map((r) => ({ listing_id: txt(r.listing_id), option_key: txt(r.option_key) || txt(r.label), label: txt(r.label), format: txt(r.format).toLowerCase(), size: opt(r.size), pages: int(r.pages), pack_qty: int(r.pack_qty), addons: opt(r.addons), price: num(r.price) })),
        keywords: (keywords.get(runId) ?? []).map((r) => ({ listing_id: txt(r.listing_id), keyword: txt(r.keyword), kind: txt(r.kind).toLowerCase().replace(/\s+/g, "_"), views: num(r.views), clicks: num(r.clicks), orders: num(r.orders), sample_size: int(r.sample_size), sampling_scope: opt(r.sampling_scope), min_price: int(r.min_price), median_price: int(r.median_price), max_price: int(r.max_price), pct_digital: int(r.pct_digital) })),
        competitor_options: (comps.get(runId) ?? []).map((r) => ({ listing_id: txt(r.listing_id), keyword: opt(r.keyword), competitor_listing_id: opt(r.competitor_listing_id), competitor_url: txt(r.competitor_url), competitor_title: opt(r.competitor_title), option_label: txt(r.option_label), format: txt(r.format).toLowerCase(), size: opt(r.size), pages: int(r.pages), pack_qty: int(r.pack_qty), addons: opt(r.addons), price: num(r.price), original_price: int(r.original_price), price_basis: opt(r.price_basis) ?? "option", bestseller: bool(r.bestseller), review_count: int(r.review_count) })),
        findings: (findings.get(runId) ?? []).map((r) => ({ finding_key: txt(r.finding_key), listing_id: opt(r.listing_id), category: txt(r.category).toLowerCase(), statement: txt(r.statement), is_suggestion: bool(r.is_suggestion) ?? false, sensitive_topic: opt(r.sensitive_topic), depends_on: txt(r.depends_on).split(/[,\s]+/).filter(Boolean) })),
        corrections: (corrections.get(runId) ?? []).map((r) => ({ supersedes_run_id: txt(r.supersedes_run_id), supersedes_finding_key: txt(r.supersedes_finding_key), replacement_finding_key: opt(r.replacement_finding_key), reason: txt(r.reason) })),
      } },
    } });
  }
  // Generic submissions: envelope in "Submissions", records in Metrics / Campaigns / Activities / Products.
  const metrics = by(table(sheets, "Metrics"), "submission_id"), camps = by(table(sheets, "Campaigns"), "submission_id");
  const acts = by(table(sheets, "Activities"), "submission_id"), prods = by(table(sheets, "Products"), "submission_id");
  for (const s of table(sheets, "Submissions")) {
    const id = txt(s.submission_id);
    if (!id) continue;
    const recs: any = {};
    if (metrics.has(id)) recs.observations = metrics.get(id)!.map((r) => { const v = num(r.value); const state = txt(r.state) || (v === undefined || v === null ? "missing" : "value"); return { metric: txt(r.metric), scope: txt(r.scope) || "all", scope_label: opt(r.scope_label), value: state === "value" ? v ?? null : null, state, attribution: opt(r.attribution) }; });
    if (camps.has(id)) recs.campaigns = camps.get(id)!.map((r) => ({ platform: txt(r.platform).toLowerCase(), external_id: txt(r.external_id) || txt(r.name), name: txt(r.name), status: opt(r.status), status_observed_at: opt(dt(r.status_observed_at)), spend: num(r.spend) ?? null, acquisitions: num(r.acquisitions) ?? null, acquisition_event: txt(r.acquisition_event) || "purchase", conversion_value: num(r.conversion_value) ?? null, attribution: opt(r.attribution), reported_cpa: num(r.reported_cpa), reported_roas: num(r.reported_roas), daily_budget: num(r.daily_budget) ?? null, budget_note: opt(r.budget_note) }));
    if (acts.has(id)) recs.activities = acts.get(id)!.map((r) => ({ type: txt(r.type).toLowerCase(), name: txt(r.name), count: num(r.count), count_unit: opt(r.count_unit), link: opt(r.link) }));
    if (prods.has(id)) recs.products = prods.get(id)!.map((r) => ({ external_id: txt(r.external_id), title: txt(r.title), vendor: opt(r.vendor), category: opt(r.category), genus: opt(r.genus), url: opt(r.url), channel_scope: txt(r.channel_scope), revenue: num(r.revenue) ?? null, units: num(r.units) ?? null, orders: num(r.orders), gross_profit: num(r.gross_profit) ?? null, cost_state: txt(r.cost_state) || "missing" }));
    subs.push({ label: `Submission ${id}`, body: {
      schema_version: 1, submission_id: id, source: txt(s.source) || "intake", business: txt(s.business),
      period: { start: date(s.period_start), end: date(s.period_end), granularity: txt(s.granularity), timezone: txt(s.timezone) },
      collected_at: dt(s.collected_at), completeness: txt(s.completeness), corrects: opt(s.corrects), records: recs,
    } });
  }
  const decisions = table(sheets, "Action decisions").map((r) => ({
    run_id: txt(r.run_id), finding_key: txt(r.finding_key), decision: txt(r.decision).toLowerCase(), decided_by: txt(r.decided_by),
    decided_at: dt(r.decided_at), note: opt(r.note), implemented_at: opt(dt(r.implemented_at)), implementation_note: opt(r.implementation_note),
  }));
  return { subs, decisions };
}

async function syncIntake(src: SheetSource, sheets: Sheet[], runId: string, actor: string) {
  const { subs, decisions } = intakeToSubmissions(sheets);
  const receipts: (Receipt & { label: string })[] = [];
  for (const s of subs) {
    const checked = checkSubmission(s.body);
    if (!checked.ok) { receipts.push({ label: s.label, outcome: "rejected", submission_id: String(s.body.submission_id), accepted: {}, rejected: [{ kind: "envelope", index: 0, errors: checked.errors }], message: "Rejected: the submission row is invalid." }); continue; }
    receipts.push({ label: s.label, ...(await applySubmission(checked.value, `sheet:${src.label}`, "sheet.intake", `sheet:${src.id}`)) });
  }
  let decisionCount = 0;
  for (const d of decisions) {
    if (!["approved", "rejected", "deferred"].includes(d.decision)) continue;
    // Decisions from this spreadsheet only apply to findings from checks this same spreadsheet submitted.
    const f = await one<{ id: string; state: string }>(
      `select f.id, f.state from findings f join listing_review_runs r on r.run_id = f.run_id join import_runs i on i.id = r.import_run_id
        where f.run_id = $1 and f.finding_key = $2 and i.submitter = $3 and i.source_id = 'sheet.intake'`, [d.run_id, d.finding_key, `sheet:${src.id}`]);
    if (!f) continue;
    const exists = await one("select 1 from action_decisions where finding_id = $1 and decision = $2 and decided_by = $3", [f.id, d.decision, d.decided_by || "sheet"]);
    if (exists) {
      if (d.implemented_at) await query("update action_decisions set implemented_at = coalesce(implemented_at, $2), implementation_note = coalesce(implementation_note, $3) where finding_id = $1 and decision = $4",
        [f.id, d.implemented_at, d.implementation_note ?? null, d.decision]);
      continue;
    }
    if (d.decision === "approved" && f.state !== "active") continue;   // superseded or needs-review findings cannot be approved
    await query("insert into action_decisions (finding_id, decision, decided_by, decided_at, note, implemented_at, implementation_note) values ($1,$2,$3,coalesce($4::timestamptz, now()),$5,$6,$7)",
      [f.id, d.decision, d.decided_by || "sheet", d.decided_at || null, d.note ?? null, d.implemented_at ?? null, d.implementation_note ?? null]);
    decisionCount++;
  }
  const accepted = receipts.filter((r) => r.outcome === "accepted").length, unchanged = receipts.filter((r) => r.outcome === "unchanged").length;
  const problems = receipts.filter((r) => r.outcome === "rejected" || r.outcome === "failed");
  const outcome = problems.length ? "partial" : "succeeded";
  await query(`update sync_runs set finished_at = now(), outcome = $2, tabs_read = $3, created_count = $4, unchanged_count = $5, review_count = $6, error = $7 where id = $1`,
    [runId, outcome, JSON.stringify(receipts.map((r) => ({ tab: r.label, kind: r.outcome, dataRows: 0, blank: false, skipped: r.outcome === "rejected" ? r.message : undefined }))),
      accepted, unchanged, problems.length, problems.length ? `${problems.length} submission(s) rejected; see receipts` : null]);
  await query("update sheet_sources set last_success_at = now(), last_error = $2 where id = $1", [src.id, problems.length ? `${problems.length} submission(s) rejected` : null]);
  return { outcome, sync_run_id: runId, receipts, decisions: decisionCount };
}

/** Sources whose interval has elapsed. Called by the scheduled function. */
export async function dueSources() {
  return query<{ id: string }>(
    `select id from sheet_sources where active and (last_attempt_at is null or last_attempt_at < now() - make_interval(mins => sync_interval_minutes)) order by last_attempt_at nulls first limit 10`);
}
