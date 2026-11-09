import { GP_SCOPE, GP_SCOPE_LABEL, GP_SOURCE_ID } from "../adapters/grossProfit";
import { CG_SCOPE, CG_SOURCE_ID } from "../adapters/corporateGifting";
import type { Router } from "../router";
import { trackerWorkRows } from "../trackerTasks";
import { query, one } from "../db";
import { badRequest, notFound } from "../http";
import { compared, trend, metricDefs } from "../metricQuery";
import { DateRange, isIsoDate, addDays, comparisonPeriod, ComparisonKind, todayIn, OPERATIONS_TZ, formatRange } from "../../shared/dates";
import { Fig, fig, missing, notApplicable, sumFigs, ratio, purchaseCpa, change } from "../../shared/metrics";
import { rankingScopeLabel, totalWithBreakdown, trackedChannels } from "../../shared/scope";

const BUSINESSES = ["sb", "p2s", "perksradar"] as const;
const HEADLINE: Record<string, string[]> = {
  sb: ["revenue", "orders", "aov", "conversion_rate", "ad_spend"],
  p2s: ["revenue", "orders", "aov", "ad_spend"],
  perksradar: ["signups", "cards_added", "reminders_sent", "emails_opened"],
};
const TREND_METRICS: Record<string, string[]> = {
  sb: ["revenue", "orders", "aov", "add_to_cart_rate", "checkout_rate", "conversion_rate", "ad_spend", "cpa", "roas", "bot_sessions"],
  p2s: ["revenue", "orders", "aov", "ad_spend", "roas"],
  perksradar: ["signups", "cards_added", "emails_opened", "emails_clicked"],
};

export function periodFromQuery(url: URL): { range: DateRange; compare: ComparisonKind | null } | null {
  const s = url.searchParams.get("start"), e = url.searchParams.get("end");
  const c = url.searchParams.get("compare") as ComparisonKind | "none" | null;
  if (s || e) {
    if (!isIsoDate(s) || !isIsoDate(e) || e < s) throw badRequest("Use start and end as YYYY-MM-DD with end on or after start.");
    if (Number(e.slice(0, 4)) - Number(s.slice(0, 4)) > 2) throw badRequest("Ranges are limited to two years.");
  }
  const compare = c === "none" ? null : c && ["previous_period", "same_dates_last_month", "same_dates_last_year"].includes(c) ? c : "previous_period";
  return s && e ? { range: { start: s, end: e }, compare } : null;
}

/** Default period: the latest period any business actually has data for (never an invented range). */
export async function defaultRange(): Promise<DateRange | null> {
  const r = await one<{ s: string; e: string }>(
    `select to_char(period_start,'YYYY-MM-DD') s, to_char(period_end,'YYYY-MM-DD') e from observations
      where status = 'active' and metric_key = 'revenue' and granularity in ('week','month') order by period_end desc, granularity limit 1`);
  if (r) return { start: r.s, end: r.e };
  const d = await one<{ e: string }>("select to_char(max(period_end),'YYYY-MM-DD') e from observations where status = 'active' and granularity = 'day'");
  return d?.e ? { start: addDays(d.e, -6), end: d.e } : null;
}

export async function sourceStatus() {
  const rows = await query(
    `select id, label, business_id, kind, status, blocked_reason, last_success_at, last_failure_at, last_error,
            coalesce((select max(collected_at) from import_runs r where r.source_id = s.id and r.outcome = 'accepted'),
                     -- Task Tracker data is published as snapshots, not import runs.
                     case when s.id = 'pull.task_tracker' then (select max(generated_at) from tracker_snapshots) end) as last_collected
       from source_connections s order by label`);
  const sheets = await query("select id, label, role, business_id, year, last_success_at, last_attempt_at, last_error, active from sheet_sources order by year desc nulls last, label");
  const stale = rows.filter((r: any) => r.status === "failing" || (r.status === "ok" && r.last_success_at && Date.now() - new Date(r.last_success_at).getTime() > 8 * 86400_000));
  return { sources: rows, sheets, staleCount: stale.length + sheets.filter((s: any) => s.last_error).length };
}

export async function businessHeadline(b: string, range: DateRange, compare: ComparisonKind | null) {
  const metrics = [];
  for (const k of HEADLINE[b]) metrics.push(await compared(b, k, "all", range, compare));
  return metrics;
}

export async function advertising(b: string | null, range: DateRange, includeZero = false) {
  const rows = await query<any>(
    `select c.id, c.business_id, c.platform, c.name, c.external_id,
            p.spend::float8 spend, p.acquisitions::float8 acquisitions, p.conversion_value::float8 conversion_value, p.acquisition_event, p.attribution,
            p.reported_cpa::float8 reported_cpa, p.reported_roas::float8 reported_roas,
            p.daily_budget::float8 daily_budget, p.budget_note,
            to_char(p.period_start,'YYYY-MM-DD') period_start, to_char(p.period_end,'YYYY-MM-DD') period_end, p.timezone,
            (select status from campaign_status_history h where h.campaign_id = c.id order by observed_at desc limit 1) as current_status,
            (select observed_at from campaign_status_history h where h.campaign_id = c.id order by observed_at desc limit 1) as status_observed_at,
            exists (select 1 from campaign_inclusions i where i.campaign_id = c.id) as explicitly_included
       from ad_campaigns c join campaign_performance p on p.campaign_id = c.id and p.status = 'active'
      where ($1::text is null or c.business_id = $1) and p.period_start = $2 and p.period_end = $3
      order by c.business_id, c.platform, p.spend desc nulls last`, [b, range.start, range.end]);
  const groups = new Map<string, any>();
  for (const r of rows) {
    // Zero spend is not inactivity; zero-spend rows are hidden from performance tables unless explicitly included.
    if (!includeZero && (r.spend === 0 || r.spend === null) && !r.explicitly_included) continue;
    const key = `${r.business_id}|${r.platform}`;
    if (!groups.has(key)) groups.set(key, { business: r.business_id, platform: r.platform, campaigns: [] });
    const spend: Fig = r.spend === null ? missing() : fig(r.spend);
    const acq: Fig = r.acquisitions === null ? missing() : fig(r.acquisitions);
    const val: Fig = r.conversion_value === null ? missing() : fig(r.conversion_value);
    groups.get(key).campaigns.push({
      id: r.id, name: r.name, status: r.current_status ?? "Unknown", statusObservedAt: r.status_observed_at,
      dailyBudget: r.daily_budget === null ? missing(r.budget_note ?? undefined) : { ...fig(r.daily_budget), ...(r.budget_note ? { note: r.budget_note } : {}) },
      spend, cpa: r.acquisitions === null && r.reported_cpa !== null ? { state: "value", value: r.reported_cpa, note: "As reported" } : purchaseCpa(spend, acq),
      roas: r.conversion_value === null && r.reported_roas !== null ? { state: "value", value: r.reported_roas, note: "As reported" } : ratio(val, spend),
      acquisitionEvent: r.acquisition_event, attribution: r.attribution, explicitlyIncluded: r.explicitly_included, _acq: acq, _val: val,
    });
  }
  return [...groups.values()].map((g) => {
    // Platform totals only when every campaign shares the same acquisition event and attribution.
    const events = new Set(g.campaigns.map((c: any) => `${c.acquisitionEvent}|${c.attribution ?? ""}`));
    const spend = sumFigs(g.campaigns.map((c: any) => c.spend));
    const totals = events.size === 1
      ? { spend, cpa: purchaseCpa(spend, sumFigs(g.campaigns.map((c: any) => c._acq))), roas: ratio(sumFigs(g.campaigns.map((c: any) => c._val)), spend) }
      : { spend, cpa: missing("Campaigns use different acquisition events or attribution"), roas: missing("Campaigns use different attribution") };
    g.campaigns.forEach((c: any) => { delete c._acq; delete c._val; });
    return { ...g, totals, period: range };
  });
}

export async function promotionsSummary(b: string | null, today: string) {
  const rows = await query<any>(
    `select p.id, p.business_id, p.kind, p.title, to_char(p.start_date,'YYYY-MM-DD') start_date, to_char(p.end_date,'YYYY-MM-DD') end_date, p.offer, p.code,
            p.execution_status, p.owner, p.review_state, to_char(p.prep_deadline,'YYYY-MM-DD') prep_deadline, p.missing_from_source_since,
            (select count(*) from tasks t where t.promotion_id = p.id and t.status <> 'cancelled')::int as task_count,
            (select count(*) from tasks t where t.promotion_id = p.id and t.status = 'done')::int as task_done
       from promotions p
      where ($1::text is null or p.business_id = $1) and p.kind in ('promotion','special_collection','launch')
        and p.end_date >= $2 and p.start_date <= ($2::date + 45)
      order by p.start_date`, [b, today]);
  return {
    current: rows.filter((r) => r.start_date <= today),
    upcoming: rows.filter((r) => r.start_date > today),
    note: "Being inside its dates does not mean a promotion launched. Execution status is recorded separately.",
  };
}

export async function workSummary(b: string | null, today: string) {
  // Dashboard tasks plus read-only Task Tracker records (one-time tasks and occurrences, never whole series).
  const tracker = await trackerWorkRows(b, today);
  const own = await query<any>(
    `select t.id, t.title, t.business_id, t.activity, t.owner, t.status, to_char(t.due_date,'YYYY-MM-DD') due_date, t.promotion_id, t.completed_at, t.recurrence
       from tasks t where ($1::text is null or t.business_id = $1) and (t.status <> 'done' or t.completed_at > now() - interval '14 days') and t.status <> 'cancelled'
      order by t.due_date nulls last limit 400`, [b]);
  const rows = [...own.map((r: any) => ({ ...r, source: "dashboard", read_only: false })), ...tracker];
  const acts = await query<any>(
    `select a.business_id, a.activity_type, a.name, a.count::float8 count, a.count_unit, to_char(a.period_start,'YYYY-MM-DD') period_start, to_char(a.period_end,'YYYY-MM-DD') period_end, a.link
       from activities a where a.status = 'active' and ($1::text is null or a.business_id = $1) and a.period_end >= ($2::date - 35) order by a.period_end desc, a.name limit 60`, [b, today]);
  const soon = addDays(today, 7);
  return {
    inProgress: rows.filter((r) => r.status === "in_progress"),
    dueSoon: rows.filter((r) => r.status !== "done" && r.due_date && r.due_date <= soon),
    overdue: rows.filter((r) => r.status !== "done" && r.due_date && r.due_date < today),
    waiting: rows.filter((r) => r.status === "waiting"),
    recentlyCompleted: rows.filter((r) => r.status === "done"),
    activities: acts,
  };
}

export async function productsAndVendors(b: string, range: DateRange, compare: ComparisonKind | null, filters: { channel?: string; vendor?: string; category?: string } = {}) {
  const cmp = compare ? comparisonPeriod(range, compare) : null;
  const load = async (r: DateRange) => query<any>(
    `select o.product_id, p.title, p.category, p.genus, p.url, v.id as vendor_id, v.name as vendor, o.channel_scope,
            o.revenue::float8 revenue, o.units::float8 units, o.orders::float8 orders, o.gross_profit::float8 gross_profit, o.cost_state, o.completeness
       from product_observations o join products p on p.id = o.product_id left join vendors v on v.id = p.vendor_id
      where o.status = 'active' and o.business_id = $1 and o.period_start = $2 and o.period_end = $3
        and ($4::text is null or o.channel_scope = $4) and ($5::text is null or v.id::text = $5) and ($6::text is null or p.category = $6)`,
    [b, r.start, r.end, filters.channel ?? null, filters.vendor ?? null, filters.category ?? null]);
  const cur = await load(range);
  const prior = cmp ? await load(cmp) : [];
  // A product absent from a period that HAS data had zero sales; if the comparison period has no data at all, there is no comparison.
  const priorHasData = prior.length > 0;
  const key = (r: any) => `${r.product_id}|${r.channel_scope}`;
  const priorBy = new Map(prior.map((r) => [key(r), r]));
  const curKeys = new Set(cur.map(key));
  // Profit is only a plain figure when every cost is known. Partial costs are labelled incomplete; missing costs are missing.
  const gpOf = (r: any): Fig => r.cost_state === "complete" && r.gross_profit !== null ? fig(r.gross_profit)
    : r.cost_state === "partial" && r.gross_profit !== null ? { state: "incomplete", value: r.gross_profit, note: "Some costs are missing, so profit is overstated" }
    : r.cost_state === "not_applicable" ? notApplicable() : missing("Cost missing");
  const priorFig = (p: any) => (p ? (p.revenue === null ? missing() : fig(p.revenue)) : priorHasData ? fig(0) : missing("No data for the comparison period"));
  const products: any[] = cur.map((r) => {
    const rev = r.revenue === null ? missing() : fig(r.revenue);
    const gp = gpOf(r);
    return { ...r, revenueFig: rev, grossProfit: gp, margin: gp.value !== null ? ratio(gp, rev) : gp,
      change: change(rev, priorFig(priorBy.get(key(r))), "currency", "up"), isNew: priorHasData && !priorBy.get(key(r)), dropped: false };
  });
  // Products that sold in the comparison period but not now: when this period has data, their sales fell to zero.
  if (cur.length) for (const p of prior) {
    if (curKeys.has(key(p))) continue;
    products.push({ ...p, revenue: 0, units: 0, orders: 0, gross_profit: null, revenueFig: fig(0), grossProfit: notApplicable("No sales this period"),
      margin: notApplicable("No sales this period"), change: change(fig(0), priorFig(p), "currency", "up"), isNew: false, dropped: true });
  }
  const vendors = new Map<string, any>();
  for (const p of products) {
    const k = p.vendor_id ?? "none";
    if (!vendors.has(k)) vendors.set(k, { id: p.vendor_id, name: p.vendor ?? "No vendor", rows: [], prior: [] });
    vendors.get(k).rows.push(p);
  }
  for (const p of prior) vendors.get(p.vendor_id ?? "none")?.prior.push(p);
  // Margin only over products whose profit is known (complete or partial). Any cost gap keeps it labelled incomplete.
  const vendorMargin = (rows: any[], gp: Fig): Fig => {
    if (gp.state === "not_applicable") return notApplicable("No sales this period");
    const known = rows.filter((r) => r.grossProfit.value !== null);
    if (!known.length) return missing("Product costs are missing");
    const m = ratio(sumFigs(known.map((r) => r.grossProfit)), sumFigs(known.map((r) => r.revenueFig)));
    const gaps = rows.some((r) => r.grossProfit.state === "missing" || r.grossProfit.state === "incomplete");
    return gaps && m.value !== null ? { state: "incomplete", value: m.value, note: "Covers products with known costs only" } : m;
  };
  const costGap = (r: any) => r.grossProfit.state === "missing" || r.grossProfit.state === "incomplete";
  const vendorRows = [...vendors.values()].map((v) => {
    const revenue = sumFigs(v.rows.map((r: any) => r.revenueFig));
    const gp = sumFigs(v.rows.map((r: any) => r.grossProfit));
    const priorRev = priorHasData ? (v.prior.length ? sumFigs(v.prior.map((r: any) => (r.revenue === null ? missing() : fig(r.revenue)))) : fig(0)) : missing("No data for the comparison period");
    return {
      id: v.id, name: v.name, revenue,
      orders: sumFigs(v.rows.map((r: any) => (r.orders === null ? missing() : fig(r.orders)))),
      units: sumFigs(v.rows.map((r: any) => (r.units === null ? missing() : fig(r.units)))),
      grossProfit: gp, margin: vendorMargin(v.rows, gp),
      missingCostProducts: v.rows.filter(costGap).length,
      droppedProducts: v.rows.filter((r: any) => r.dropped).length,
      change: change(revenue, priorRev, "currency", "up"),
    };
  }).sort((a, b) => (b.revenue.value ?? 0) - (a.revenue.value ?? 0));
  const selling = products.filter((p) => !p.dropped);
  const byRev = [...selling].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
  // Profit leaders rank complete figures only; products with partial or missing costs are counted, not ranked.
  const withGp = selling.filter((p) => p.grossProfit.state === "value").sort((a, b) => (b.grossProfit.value ?? 0) - (a.grossProfit.value ?? 0));
  const moved = products.filter((p) => p.change.absolute !== null && !p.isNew);
  const channels = [...new Set(cur.map((r) => r.channel_scope))];
  return {
    period: range, comparison: cmp, scopeLabel: rankingScopeLabel(channels), channels,
    revenueLeaders: byRev.slice(0, 10), profitLeaders: withGp.slice(0, 10),
    growing: moved.filter((p) => (p.change.absolute ?? 0) > 0).sort((a, b) => (b.change.absolute ?? 0) - (a.change.absolute ?? 0)).slice(0, 10),
    declining: moved.filter((p) => (p.change.absolute ?? 0) < 0).sort((a, b) => (a.change.absolute ?? 0) - (b.change.absolute ?? 0)).slice(0, 10),
    newGaining: selling.filter((p) => p.isNew && (p.revenue ?? 0) > 0).sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0)).slice(0, 10),
    vendors: vendorRows, products: [...byRev, ...products.filter((p) => p.dropped)],
    costCoverage: {
      products: selling.length,
      missingCost: selling.filter((p) => p.grossProfit.state === "missing").length,
      partialCost: selling.filter((p) => p.grossProfit.state === "incomplete").length,
    },
    categories: [...new Set(cur.map((r) => r.category).filter(Boolean))].sort(),
  };
}

export async function latestReports(limit = 6) {
  return query(`select r.id, r.kind, r.business_id, to_char(r.period_start,'YYYY-MM-DD') period_start, to_char(r.period_end,'YYYY-MM-DD') period_end, r.title,
                       (select max(revision) from report_revisions v where v.report_id = r.id and v.state = 'published') as published_revision,
                       (select max(published_at) from report_revisions v where v.report_id = r.id) as published_at
                  from reports r order by r.period_end desc limit $1`, [limit]);
}

export async function overview(range: DateRange, compare: ComparisonKind | null) {
  const today = todayIn(OPERATIONS_TZ);
  const businesses = [];
  for (const b of BUSINESSES) {
    const name = (await one<{ name: string }>("select name from businesses where id = $1", [b]))!.name;
    businesses.push({ id: b, name, metrics: await businessHeadline(b, range, compare) });
  }
  const sbChannels = [];
  for (const [ch, label] of Object.entries(trackedChannels())) sbChannels.push({ scope: `channel:${ch}`, label, ...(await channelFigures("sb", `channel:${ch}`, range)) });
  const sbTotal = await channelFigures("sb", "all", range);
  return {
    period: { ...range, label: formatRange(range) },
    comparison: compare ? comparisonPeriod(range, compare) : null,
    status: await sourceStatus(),
    businesses,
    sbChannels: totalWithBreakdown(sbTotal, sbChannels),
    trends: await trendsFor(range.end),
    advertising: await advertising(null, range),
    promotions: await promotionsSummary(null, today),
    work: await workSummary(null, today),
    products: await productsAndVendors("sb", range, compare),
    reports: await latestReports(),
    today,
  };
}

async function channelFigures(b: string, scope: string, range: DateRange) {
  const r = await compared(b, "revenue", scope, range, null), o = await compared(b, "orders", scope, range, null);
  return { revenue: r.value.state === "value" ? r.value.value : null, orders: o.value.state === "value" ? o.value.value : null };
}

export async function trendsFor(end: string, metrics?: Record<string, string[]>, scope = "all") {
  const out: any[] = [];
  for (const [b, keys] of Object.entries(metrics ?? TREND_METRICS)) for (const k of keys) {
    const t = await trend(b, k, scope, end);
    if (t.points.some((p) => p.value.state !== "missing")) out.push({ business: b, ...t });
  }
  return out;
}

export function registerDashboard(r: Router) {
  r.get("/overview", async ({ url }) => {
    const p = periodFromQuery(url);
    const range = p?.range ?? (await defaultRange());
    if (!range) return { empty: true, status: await sourceStatus(), message: "No performance data has been imported yet." };
    return overview(range, p ? p.compare : "previous_period");
  });
  r.get("/status", async () => sourceStatus());
  r.get("/metrics", async () => [...(await metricDefs()).values()]);
  r.get("/business/:id/:section", async ({ params, url }) => {
    const b = params.id;
    if (!BUSINESSES.includes(b as any)) throw notFound("Business");
    const p = periodFromQuery(url);
    const range = p?.range ?? (await defaultRange());
    const compare = p ? p.compare : "previous_period";
    const today = todayIn(OPERATIONS_TZ);
    const empty = { empty: true, message: "No data has been imported for this business yet." };
    switch (params.section) {
      case "summary":
        if (!range) return { ...empty, promotions: await promotionsSummary(b, today), work: await workSummary(b, today) };
        return { period: { ...range, label: formatRange(range) }, metrics: await businessHeadline(b, range, compare), trends: await trendsFor(range.end, { [b]: TREND_METRICS[b] }),
          advertising: await advertising(b, range), promotions: await promotionsSummary(b, today), work: await workSummary(b, today),
          products: b === "sb" ? await productsAndVendors(b, range, compare) : null };
      case "sales": case "vendors": case "products":
        if (!range) return empty;
        return { ...(await productsAndVendors(b, range, compare, {
          channel: url.searchParams.get("channel") || undefined, vendor: url.searchParams.get("vendor") || undefined, category: url.searchParams.get("category") || undefined })), periodLabel: formatRange(range) };
      case "advertising":
        if (!range) return empty;
        return { period: { ...range, label: formatRange(range) }, platforms: await advertising(b, range, url.searchParams.get("zero") === "1") };
      case "promotions":
        return { promotions: await promotionList(b), today };
      case "activities":
        return { work: await workSummary(b, today) };
      case "profitability": {
        if (!range) return empty;
        // Gross profit and its costs are reported by the Gross Profit app for the Shopify store, never as the business
        // total. Margin uses the revenue basis sent with that gross profit; business revenue is shown for context only.
        const keys = ["gross_profit", "gross_profit_revenue_basis", "margin", "product_cost", "shipping_cost"];
        const metrics = []; for (const k of keys) metrics.push(await compared(b, k, GP_SCOPE, range, compare));
        metrics.push(await compared(b, "revenue", "all", range, compare));
        return { period: { ...range, label: formatRange(range) }, metrics, scopeLabel: GP_SCOPE_LABEL,
          trends: await trendsFor(range.end, { [b]: ["gross_profit", "margin"] }, GP_SCOPE),
          products: await productsAndVendors(b, range, compare), source: await one("select * from source_connections where id = $1", [GP_SOURCE_ID]) };
      }
      case "corporate":
        return { source: await one("select * from source_connections where id = $1", [CG_SOURCE_ID]),
          metrics: range ? [await compared(b, "revenue", CG_SCOPE, range, compare), await compared(b, "orders", CG_SCOPE, range, compare), await compared(b, "units", CG_SCOPE, range, compare)] : [],
          note: "Corporate revenue may overlap other sales channels and is never added to business totals." };
      default: throw notFound("Section");
    }
  });
}

export async function promotionList(b: string | null) {
  return query(
    `select p.*, to_char(p.start_date,'YYYY-MM-DD') start_date, to_char(p.end_date,'YYYY-MM-DD') end_date, to_char(p.prep_deadline,'YYYY-MM-DD') prep_deadline,
            to_char(p.feature_date,'YYYY-MM-DD') feature_date,
            (select count(*) from tasks t where t.promotion_id = p.id and t.status <> 'cancelled')::int as task_count,
            (select count(*) from tasks t where t.promotion_id = p.id and t.status = 'done')::int as task_done,
            (select count(*) from review_items ri where ri.promotion_id = p.id and ri.resolved_at is null)::int as open_reviews,
            (select string_agg(distinct s.label, ', ') from promotion_source_links l join sheet_sources s on s.id = l.sheet_source_id where l.promotion_id = p.id) as sources
       from promotions p where ($1::text is null or p.business_id = $1) order by p.start_date nulls last, p.title`, [b]);
}
