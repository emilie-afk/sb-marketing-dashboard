// SYNTHETIC test and demo data. Every vendor, product, campaign, listing and figure here is invented.
// The spreadsheet layouts exercise awkward structures (moving columns, rows repeated across tabs,
// year-less dates, blank month tabs). All names, dates, codes and percentages are made up.
import type { Sheet } from "../../shared/calendarParse";
import { addDays } from "../../shared/dates";

export const DEMO_VENDORS = ["Fernwood Growers (demo)", "Cactus Lane (demo)", "Moss & Stone (demo)", "Tilly Air Co (demo)", "Clay Pot Studio (demo)", "Leafline Nursery (demo)"];

export function annualWorkbook(year = 2026, opts: { renameValentine?: boolean; dropSpring?: boolean; blankMarch?: boolean; changeFebDates?: boolean } = {}): Sheet[] {
  return [
    { name: `Holiday Calendar ${year}`, rows: [
      ["Month", "Date", "", "Event", "", "Type", "Note"],
      ["January", "1 Jan", "Thursday", "Demo New Year", "", "Federal Holiday", ""],
      ["February", "14 Feb", "Saturday", "Demo Valentine", "", "", ""],
      ["", "17 Feb", "Tuesday", "Demo Lunar New Year", "", "", ""],
      ["November", "26 Nov", "Thursday", "Demo Thanksgiving", "", "Federal Holiday", ""],
      ["", "27 Nov", "Friday", "Demo Black Friday", "", "Observance", ""],
    ] },
    { name: `Jan ${year}`, rows: [["Date", "", "", "Code"], ["Jan 5 - 14", "New year demo plants", "12% off", "DEMONEW"], ["Jan 18 - Feb 2", "Demo love week", "8% off", "DEMOLOVE"]] },
    // Columns move: here the discount comes before the name and a link column appears.
    { name: `Feb ${year}`, rows: [["Date", "", "", "Code"],
      [opts.changeFebDates ? "Feb 5 - Feb 19" : "Feb 4 - Feb 19", opts.renameValentine ? "Valentine plant week (demo)" : "Demo Valentine week", "8% off", "DEMOVDAY", "https://admin.shopify.com/store/demo-store/discounts/1000000001"],
      ["Jan 18 - Feb 2", "Demo love week", "8% off", "DEMOLOVE"]] },   // repeated from January
    { name: `March ${year}`, rows: opts.blankMarch ? [["Date", "", "discount", "Code"]] : [["Date", "", "discount", "Code"],
      ...(opts.dropSpring ? [] : [["Mar 3 - 16", "Demo spring time", "", "DEMOSPRING"]]), ["Mar 18 - Apr 1", "Demo Easter", "6%", ""]] },
    { name: `Apr ${year}`, rows: [["Date", "Discount", "", "Code"], ["Apr 3 - Apr 20", "12%", "Demo Earth Day", "DEMOEARTH"]] },
    { name: `Nov ${year}`, rows: [["Date", "", "", "Code"]] },        // empty: owned by the seasonal program
    { name: `Dec ${year}`, rows: [["Date", "", "", "Code"]] },
  ];
}

export function seasonalWorkbook(year = 2026, opts: { conflictDates?: boolean } = {}): Sheet[] {
  return [
    { name: "Promotion calendar", rows: [
      ["No.", "Occasion", "Duration", "Promotion", "Code", "Promotion channels", "Promotion materials"],
      ["", "", "", "", "", "", ""],
      ["", "Demo free printable", `Dec 1, ${year}`, "Demo calendar", "", "", ""],
      ["1", "Demo harvest", `Nov 2–11, ${year}`, "5% off all orders", "DEMOHARVEST", "Website, email, social", "Seasonal banner"],
      ["2", "Demo thanks", `Nov 12–24, ${year}`, "5% off all orders", "DEMOTHANKS", "Website, email, social", "Thank-you message"],
      ["3", "Demo Thanksgiving day", "26-Nov", "Demo vendor 12%; others 5%", "Invented setup note.", "", ""],
      ["4", "Demo Black Friday", `Nov 27–29, ${year}`, "Participating products up to 20%", "Invented setup note.", "Website, email, social", "Banner"],
      ["", "Vendor offers", "Duration", "Customer promotion", "Code", "", ""],
      ["", "Fernwood Growers (demo)", opts.conflictDates ? "Nov 24–Dec 30" : "Nov 25–Dec 30", "12%; 20% Nov 27–30", "", "", ""],
      ["", "Invented note row.", "", "", "", "", ""],
    ] },
    { name: "Vendor discounts", rows: [
      ["Vendor", "Regular offer period", "Vendor cost reduction", "Customer discount", "BF / CM dates", "BF / CM cost reduction", "BF / CM customer discount", "Terms / pending confirmation"],
      ["Fernwood Growers (demo)", `Nov 25–Dec 30, ${year}`, 0.07, 0.12, `Nov 27–30, ${year}`, 0.11, 0.2, "Invented demo terms."],
      ["Tilly Air Co (demo)", `Nov 24–Dec 28, ${year}`, 0.11, 0.2, `Nov 27 / Nov 30, ${year}`, 0.11, 0.2, "Invented: two separate special dates."],
      ["Moss & Stone (demo)", `Nov 3, ${year}–Jan 4, ${year + 1}`, "", 0.05, "", "", 0.05, "Invented: customer discount only."],
      ["", "", "", "", "", "", "", ""],
      ["Invented footnote row.", "", "", "", "", "", "", ""],
    ] },
    { name: "Special collections", rows: [
      ["Feature date", "Special collection", "Vendor", "Customer discount", "Offer period", "Collection link", "Code", "Eligibility / availability"],
      [`Wed, Dec 9, ${year}`, "Demo air plant gifts", "Tilly Air Co (demo)", "20%", "Nov 24–Dec 28", "https://example.com/collections/demo-air-plants", "", "Demo vendor products only."],
    ] },
  ];
}

export const WEEK_END = "2026-10-30";      // a Friday; demo weeks run Saturday to Friday
export const weekRange = (i: number) => ({ start: addDays(WEEK_END, -6 - 7 * i), end: addDays(WEEK_END, -7 * i) });

export function envelope(id: string, business: string, period: { start: string; end: string }, granularity = "week", extra: Record<string, unknown> = {}) {
  return { schema_version: 1, submission_id: id, source: "weekly_report", business, period: { ...period, granularity, timezone: "America/Los_Angeles" },
    collected_at: `${addDays(period.end, 3)}T08:00:00Z`, completeness: "complete", ...extra };
}

/** Deterministic pseudo-random numbers so screenshots and tests are stable. */
export function rng(seed: number) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

export function listingCheck(runId: string, windowEnd: string, opts: { priceDigital?: number; correction?: boolean } = {}) {
  const ws = addDays(windowEnd, -29);
  return {
    run_id: runId, window_start: ws, window_end: windowEnd, scope_note: "Listings with at least one click in the last 30 days, excluding one listing", excluded_listing_ids: ["1000000099"],
    listings: [
      { listing_id: "1000000001", title: "Demo custom coloring page from your photo", url: "https://example.com/listing/1000000001", clicks: 42, orders: 3, spend: 12.4 },
      { listing_id: "1000000002", title: "Demo pet portrait coloring book", url: "https://example.com/listing/1000000002", clicks: 9, orders: 0, spend: 3.1 },
    ],
    our_options: [
      { listing_id: "1000000001", option_key: "digital-1", label: "Digital, 1 page", format: "digital", pages: 1, price: opts.priceDigital ?? 6.5 },
      { listing_id: "1000000001", option_key: "printed-12", label: "Printed book, 12 pages", format: "printed", pages: 12, price: 34 },
      { listing_id: "1000000002", option_key: "digital-12", label: "Digital, 12 pages", format: "digital", pages: 12, price: 18 },
    ],
    keywords: [
      { listing_id: "1000000001", keyword: "demo custom coloring page", kind: "reported", views: 900, clicks: 30, orders: 2, sample_size: 48, sampling_scope: "first results page, US", min_price: 1.5, median_price: 7.9, max_price: 40, pct_digital: 81 },
      { listing_id: "1000000002", keyword: "demo pet portrait coloring book", kind: "fallback_title_phrase", sample_size: 24, sampling_scope: "first results page, US", min_price: 3, median_price: 16, max_price: 55, pct_digital: 60 },
    ],
    competitor_options: [
      { listing_id: "1000000001", keyword: "demo custom coloring page", competitor_url: "https://example.com/listing/2000000001", competitor_title: "Demo rival A", option_label: "Digital page", format: "digital", pages: 1, price: 8.5 },
      { listing_id: "1000000001", keyword: "demo custom coloring page", competitor_url: "https://example.com/listing/2000000002", competitor_title: "Demo rival B", option_label: "Digital page", format: "digital", pages: 1, price: 9.0, bestseller: true, review_count: 320 },
      { listing_id: "1000000001", keyword: "demo custom coloring page", competitor_url: "https://example.com/listing/2000000003", competitor_title: "Demo rival C", option_label: "From price", format: "digital", price: 1.5, price_basis: "from_price" },
      { listing_id: "1000000001", keyword: "demo custom coloring page", competitor_url: "https://example.com/listing/2000000004", competitor_title: "Demo rival D", option_label: "Printed 12 pages", format: "printed", pages: 12, price: 32 },
      { listing_id: "1000000002", competitor_url: "https://example.com/listing/2000000005", competitor_title: "Demo rival E", option_label: "Digital 12 pages", format: "digital", pages: 12, price: 22 },
    ],
    findings: [
      { finding_key: "f-price", listing_id: "1000000001", category: "pricing", statement: "Digital single page is below comparable digital options (median $8.75).", depends_on: [] },
      { finding_key: "f-raise", listing_id: "1000000001", category: "pricing", statement: "Consider raising the digital single page to $7.99.", is_suggestion: true, depends_on: ["f-price"] },
      { finding_key: "f-proof", listing_id: "1000000001", category: "description", statement: "Offer a free proof before printing.", sensitive_topic: "proof", depends_on: [] },
      { finding_key: "f-title", listing_id: "1000000002", category: "title", statement: "Competitors lead the title with the search phrase.", depends_on: [] },
    ],
    corrections: opts.correction ? [{ supersedes_run_id: "demo-check-1", supersedes_finding_key: "f-price", reason: "Rival B price was a sale price; regular price is $11." }] : [],
  };
}
