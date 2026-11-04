// Loads SYNTHETIC demo data through the real import and sync paths. Local only.
// Refused on Netlify, in production, or when the database already has imported data.
import { query, one } from "../server/db";
import { checkSubmission } from "../shared/submission";
import { applySubmission } from "../server/imports";
import { runSheetSync } from "../server/sheetSync";
import { createTask } from "../server/routes/work";
import { buildSnapshot } from "../server/routes/reports";
import { annualWorkbook, seasonalWorkbook, envelope, weekRange, rng, DEMO_VENDORS, listingCheck } from "../tests/fixtures/synthetic";
import { addDays } from "../shared/dates";

export async function seedDemo(log = console.log) {
  if (process.env.NETLIFY || process.env.NODE_ENV === "production" || process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error("Demo data is refused outside local development.");
  const n = await one<{ n: number }>("select (select count(*) from import_runs) + (select count(*) from promotions) + (select count(*) from tasks) as n");
  if (Number(n!.n) > 0) throw new Error("Database already has data. Demo seed only runs on an empty database.");
  const sub = async (body: any, source = "submission.api", submitter = "seed:demo") => {
    const c = checkSubmission(body);
    if (!c.ok) throw new Error(`demo submission invalid: ${JSON.stringify(c.errors)}`);
    const r = await applySubmission(c.value, "demo-seed", source, submitter);
    if (r.outcome !== "accepted") throw new Error(`demo submission ${body.submission_id}: ${r.message}`);
  };
  const R = rng(7);
  // ---- weekly performance, 10 weeks
  for (let i = 9; i >= 0; i--) {
    const w = weekRange(i), season = 1 + (9 - i) * 0.04;
    const web = Math.round((2000 + R() * 800) * season), amz = Math.round(300 + R() * 150), faire = Math.round(R() * 120);
    const other = Math.round(150 + R() * 100);
    const wOrders = Math.round(web / (38 + R() * 6)), aOrders = Math.round(amz / 22), fOrders = faire ? 1 + Math.round(R() * 2) : 0, oOrders = Math.round(other / 30);
    const sessions = Math.round(8000 + R() * 2000), bots = Math.round(sessions * (0.18 + R() * 0.2));
    const spend = Math.round(250 + R() * 80), purchases = Math.round(20 + R() * 10);
    await sub({ ...envelope(`demo-sb-week-${i}`, "sb", w), records: { observations: [
      { metric: "revenue", value: web + amz + faire + other }, { metric: "orders", value: wOrders + aOrders + fOrders + oOrders },
      { metric: "revenue", scope: "channel:online_store", scope_label: "Shopify website", value: web }, { metric: "orders", scope: "channel:online_store", value: wOrders },
      { metric: "revenue", scope: "channel:amazon", scope_label: "Amazon", value: amz }, { metric: "orders", scope: "channel:amazon", value: aOrders },
      { metric: "revenue", scope: "channel:faire", scope_label: "Faire", value: faire }, { metric: "orders", scope: "channel:faire", value: fOrders },
      { metric: "sessions", value: sessions }, { metric: "sessions_added_to_cart", value: Math.round(sessions * 0.047) },
      { metric: "sessions_reached_checkout", value: Math.round(sessions * 0.028) }, { metric: "sessions_converted", value: Math.round(sessions * (0.008 + R() * 0.003)) },
      { metric: "bot_sessions", value: bots }, { metric: "human_sessions", value: sessions - bots },
      { metric: "ad_spend", value: spend }, { metric: "ad_purchases", value: purchases }, { metric: "ad_purchase_value", value: Math.round(purchases * 48) },
    ] } });
    // Gross profit comes from its own integration, with the revenue basis it was calculated on (here: website and
    // Amazon after refunds), which differs from the weekly report's business revenue.
    const basis = Math.round((web + amz) * 0.96);
    await sub({ ...envelope(`demo-sb-gp-${i}`, "sb", w, "week", { completeness: i === 0 ? "provisional" : "complete" }), source: "gross_profit", records: { observations: [
      { metric: "gross_profit", value: Math.round(basis * 0.5) }, { metric: "gross_profit_revenue_basis", value: basis },
      { metric: "product_cost", value: Math.round(basis * 0.3) }, { metric: "shipping_cost", value: Math.round(basis * 0.2) },
    ] } }, "submission.api", "seed:gross-profit");
    const p2sRev = Math.round(300 + R() * 200), p2sOrders = Math.round(p2sRev / 25), etsySpend = Math.round(40 + R() * 20);
    await sub({ ...envelope(`demo-p2s-week-${i}`, "p2s", w), records: { observations: [
      { metric: "revenue", value: p2sRev }, { metric: "orders", value: p2sOrders },
      { metric: "revenue", scope: "channel:etsy", scope_label: "Etsy", value: Math.round(p2sRev * 0.85) }, { metric: "revenue", scope: "channel:kdp", scope_label: "KDP", value: Math.round(p2sRev * 0.15) },
      { metric: "ad_spend", value: etsySpend }, { metric: "ad_purchases", value: Math.round(etsySpend / 9) }, { metric: "ad_purchase_value", value: Math.round(etsySpend * 3.4) },
    ] } });
    // Advertising campaigns
    const camps = [
      { platform: "google", external_id: "g-1", name: "Demo Shopping - Houseplants", spend: Math.round(spend * 0.45), acquisitions: 9, conversion_value: 500 },
      { platform: "google", external_id: "g-2", name: "Demo Shopping - Succulents", spend: Math.round(spend * 0.25), acquisitions: 4, conversion_value: 180 },
      { platform: "google", external_id: "g-3", name: "Demo Search - Gifts", spend: 14.2, acquisitions: 0.5, conversion_value: 20 },
      { platform: "google", external_id: "g-4", name: "Demo Paused - Bundles", spend: 0, acquisitions: 0, conversion_value: 0 },
      { platform: "google", external_id: "g-5", name: "Demo Holiday launch (new)", spend: 0, acquisitions: 0, conversion_value: 0 },
      { platform: "facebook", external_id: "f-1", name: "Demo Conversion - Fall", spend: Math.round(spend * 0.28), acquisitions: 5, conversion_value: 230 },
    ].map((c) => ({ ...c, status: c.external_id === "g-4" ? "Paused" : "Active", status_observed_at: `${addDays(w.end, 3)}T08:00:00Z`, attribution: c.platform === "google" ? "Google data-driven" : "7-day click, 1-day view" }));
    await sub({ ...envelope(`demo-sb-ads-${i}`, "sb", w), source: "ads", records: { campaigns: camps } });
    await sub({ ...envelope(`demo-p2s-ads-${i}`, "p2s", w), source: "ads", records: { campaigns: [
      { platform: "etsy", external_id: "etsy-all", name: "Demo Etsy Ads (all listings)", spend: etsySpend, acquisitions: Math.round(etsySpend / 9), conversion_value: Math.round(etsySpend * 3.4), status: "Active", status_observed_at: `${addDays(w.end, 3)}T08:00:00Z`, attribution: "Etsy 30-day" }] } });
    // Products: 24 synthetic products across vendors (last 2 weeks only)
    if (i <= 1) {
      const products = [];
      for (let k = 0; k < 24; k++) {
        if (i === 1 && k >= 22) continue;               // two new products this week
        const rev = Math.round((20 + R() * 150) * (k < 5 ? 2 : 1) * (i === 0 && k % 4 === 0 ? 1.4 : 1));
        const missingCost = k % 7 === 3;
        products.push({ external_id: `demo-p${k}`, title: `Demo ${["Echeveria", "Haworthia", "Air plant", "Cactus", "Pot", "Gift box"][k % 6]} ${k + 1}`,
          vendor: DEMO_VENDORS[k % DEMO_VENDORS.length], category: ["Succulents", "Succulents", "Air plants", "Cacti", "Pots", "Gift boxes"][k % 6],
          genus: ["Echeveria", "Haworthia", "Tillandsia", "Mammillaria", "", ""][k % 6] || undefined, channel_scope: "channel:online_store",
          revenue: rev, units: Math.max(1, Math.round(rev / 24)), orders: Math.max(1, Math.round(rev / 30)),
          gross_profit: missingCost ? null : Math.round(rev * (0.4 + R() * 0.2)), cost_state: missingCost ? "missing" : "complete" });
      }
      await sub({ ...envelope(`demo-sb-products-${i}`, "sb", w), source: "products", records: { products } });
    }
    await sub({ ...envelope(`demo-sb-activities-${i}`, "sb", w), source: "activities", records: { activities: [
      { type: "social", name: "Social posts", count: 5, count_unit: "social posts per channel" },
      { type: "content", name: "Blog posts published", count: 2, count_unit: "blog posts" },
      { type: "pitching", name: "Journalist pitches sent", count: 6 + (i % 3), count_unit: "pitches" },
      ...(i === 0 ? [{ type: "ai_tool" as const, name: "Marketing Dashboard (created)", count: 1, count_unit: "app" }, { type: "vendor" as const, name: "Holiday terms confirmed with 3 demo vendors" }] : []),
    ] } });
  }
  log("demo: performance, ads, products, activities");

  // ---- listing checks (two overlapping 30-day windows; the second corrects a finding of the first)
  const lr1 = listingCheck("demo-check-1", "2026-10-26");
  await sub({ ...envelope("listing-check:demo-check-1", "p2s", { start: lr1.window_start, end: lr1.window_end }, "rolling_30"), source: "etsy_listing_check", records: { listing_review: lr1 } });
  const lr2 = listingCheck("demo-check-2", "2026-11-02", { priceDigital: 6.99, correction: true });
  await sub({ ...envelope("listing-check:demo-check-2", "p2s", { start: lr2.window_start, end: lr2.window_end }, "rolling_30"), source: "etsy_listing_check", records: { listing_review: lr2 } });
  log("demo: listing checks");

  // ---- spreadsheets through the real sync with a synthetic reader
  const annual = await one<{ id: string }>("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'annual_calendar', 'Demo annual calendar 2026', 'DEMOannualFILEid0000000001', 'xlsx', 'demo-seed') returning id");
  const seasonal = await one<{ id: string }>("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2026, 'seasonal_program', 'Demo Nov to Dec program', 'DEMOseasonFILEid0000000001', 'google_sheet', 'demo-seed') returning id");
  await runSheetSync(annual!.id, "manual", "demo-seed", async () => annualWorkbook(2026));
  await runSheetSync(seasonal!.id, "manual", "demo-seed", async () => seasonalWorkbook(2026, { conflictDates: true }));
  await query("update promotions set execution_status = 'launched', owner = 'Demo Owner A' where code = 'DEMOHARVEST'");
  await query("update promotions set execution_status = 'preparing', owner = 'Demo Owner B', prep_deadline = '2026-11-10' where code = 'DEMOTHANKS'");
  log("demo: promotions");

  // ---- tasks
  const thanks = await one<{ id: string }>("select id from promotions where code = 'DEMOTHANKS'");
  const t = (o: any) => createTask({ status: "todo", ...o }, "demo-seed");
  await t({ title: "Design demo Thanksgiving banner", business_id: "sb", activity: "Creative", owner: "Demo Owner B", status: "in_progress", due_date: "2026-11-06", promotion_id: thanks!.id });
  await t({ title: "Schedule demo Thanksgiving emails", business_id: "sb", activity: "Email", owner: "Demo Owner A", due_date: "2026-11-09", promotion_id: thanks!.id });
  await t({ title: "Confirm demo vendor BF/CM dates", business_id: "sb", activity: "Vendor", owner: "Demo Owner A", status: "waiting", due_date: "2026-11-05" });
  await t({ title: "Weekly social schedule", business_id: "sb", activity: "Social", owner: "Demo Owner C", due_date: "2026-10-26", recurrence: "weekly:1" });
  await t({ title: "Refresh demo P2S listing photos", business_id: "p2s", activity: "Listing", owner: "Demo Owner C", status: "done", due_date: "2026-10-30" });
  await t({ title: "Draft demo Perksradar outreach list", business_id: "perksradar", activity: "Outreach", owner: "Demo Owner B", due_date: "2026-11-12" });
  log("demo: tasks");

  // ---- a published weekly report, then a later data correction that must not change it
  const w0 = weekRange(0);
  const snap = await buildSnapshot(null, w0.start, w0.end);
  const rep = await one<{ id: string }>("insert into reports (kind, business_id, period_start, period_end, title, created_by) values ('weekly', null, $1, $2, 'Weekly report, demo week', 'demo-seed') returning id", [w0.start, w0.end]);
  await query("insert into report_revisions (report_id, revision, state, content, source_runs, created_by, published_at) values ($1, 1, 'published', $2, $3, 'demo-seed', now())", [rep!.id, JSON.stringify(snap.content), snap.runs]);
  log("demo: report");
}
