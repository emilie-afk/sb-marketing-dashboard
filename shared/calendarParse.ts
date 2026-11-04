// Turns spreadsheet tabs into source promotion and occasion records.
// Headers are found by name, not position, because columns move between monthly tabs.
import { parseDateText, parsePercent } from "./sheetDates";

export type Cell = string | number | boolean | Date | null | undefined;
export type Sheet = { name: string; rows: Cell[][] };

export type SourcePromotion = {
  identityKey: string;
  kind: "promotion" | "vendor_offer" | "special_collection" | "launch";
  tab: string;
  row: number;                        // 1-based, informational only
  title: string;
  start_date: string | null;
  end_date: string | null;
  date_text: string | null;
  offer?: string | null;
  code?: string | null;
  channels?: string | null;
  materials?: string | null;
  vendor?: string | null;
  vendor_cost_reduction?: number | null;
  customer_discount?: number | null;
  special_dates_text?: string | null;
  special_cost_reduction?: number | null;
  special_customer_discount?: number | null;
  terms?: string | null;
  collection_url?: string | null;
  feature_date?: string | null;
  dateIssue?: string;                 // set when the date text could not be parsed or lists several dates
  crossCheckOnly?: boolean;           // summary rows that only cross-check the designated tab, never create records
};

export type SourceOccasion = { identityKey: string; name: string; date: string; type: string | null; note: string | null; tab: string; row: number };

export type TabReport = { tab: string; kind: string; dataRows: number; blank: boolean; skipped?: string };

export type ParsedWorkbook = {
  promotions: SourcePromotion[];
  occasions: SourceOccasion[];
  tabs: TabReport[];
  issues: { tab: string; row: number; message: string }[];
};

const text = (c: Cell): string => {
  if (c === null || c === undefined) return "";
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).replace(/\s+/g, " ").trim();
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const CODE = /^[A-Z][A-Z0-9]{2,24}$/;
const DISCOUNT_LINK = /admin\.shopify\.com\/store\/[^/\s]+\/discounts\/(\d{6,})/;
const URL_RE = /https?:\/\/\S+/;

function findHeader(rows: Cell[][], must: string[], maxScan = 8): number {
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = rows[i].map((c) => norm(text(c)));
    if (must.every((m) => cells.some((c) => c === m || c.startsWith(m)))) return i;
  }
  return -1;
}
const colIndex = (header: Cell[], ...names: string[]) => {
  const cells = header.map((c) => norm(text(c)));
  for (const n of names) { const i = cells.findIndex((c) => c === n || c.startsWith(n)); if (i >= 0) return i; }
  return -1;
};
const isBlankRow = (r: Cell[]) => r.every((c) => text(c) === "");

function identityFor(p: { code?: string | null; links?: string; title: string; start: string | null; vendor?: string | null; kind: string }) {
  if (p.code && CODE.test(p.code)) return `code:${p.code}`;
  const link = p.links ? DISCOUNT_LINK.exec(p.links) : null;
  if (link) return `discount:${link[1]}`;
  if (p.kind === "vendor_offer" && p.vendor) return `vendor:${slug(p.vendor)}`;
  return `title:${slug(p.title)}:${p.start ?? "nodate"}`;
}

// ------------------------------------------------------------ annual calendar
const MONTH_TAB = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})$/i;

export function parseAnnualCalendar(sheets: Sheet[], year: number): ParsedWorkbook {
  const out: ParsedWorkbook = { promotions: [], occasions: [], tabs: [], issues: [] };
  for (const sh of sheets) {
    const name = sh.name.trim();
    if (MONTH_TAB.test(name)) { parseMonthTab(sh, year, out); continue; }
    const h = findHeader(sh.rows, ["date", "event"]);
    if (h >= 0) { parseOccasionTab(sh, h, year, out); continue; }
    out.tabs.push({ tab: name, kind: "unknown", dataRows: 0, blank: false, skipped: "No recognised header" });
  }
  return out;
}

function parseOccasionTab(sh: Sheet, h: number, year: number, out: ParsedWorkbook) {
  const hdr = sh.rows[h];
  const iDate = colIndex(hdr, "date"), iEvent = colIndex(hdr, "event"), iType = colIndex(hdr, "type"), iNote = colIndex(hdr, "note");
  let n = 0;
  for (let r = h + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    const name = text(row[iEvent]);
    if (!name) continue;
    const d = parseDateText(row[iDate], year);
    if (!d.ok) { out.issues.push({ tab: sh.name, row: r + 1, message: `Occasion date not recognised (${d.reason})` }); continue; }
    n++;
    out.occasions.push({ identityKey: `occ:${d.start}:${slug(name)}`, name, date: d.start, type: text(row[iType]) || null, note: iNote >= 0 ? text(row[iNote]) || null : null, tab: sh.name, row: r + 1 });
  }
  out.tabs.push({ tab: sh.name, kind: "occasions", dataRows: n, blank: n === 0 });
}

function parseMonthTab(sh: Sheet, year: number, out: ParsedWorkbook) {
  const h = findHeader(sh.rows, ["date"]);
  if (h < 0) { out.tabs.push({ tab: sh.name, kind: "month", dataRows: 0, blank: true, skipped: "No header row" }); return; }
  const hdr = sh.rows[h];
  const tabYear = Number(MONTH_TAB.exec(sh.name.trim())![2]) || year;
  const iDate = colIndex(hdr, "date"), iCode = colIndex(hdr, "code");
  const iDisc = colIndex(hdr, "% discount", "discount"), iName = colIndex(hdr, "name");
  const iBanner = colIndex(hdr, "banner text"), iLink = colIndex(hdr, "discount link");
  let n = 0;
  for (let r = h + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (isBlankRow(row)) continue;
    const dateText = text(row[iDate]);
    if (!dateText) continue;
    // Unlabelled columns are classified by content: a percent is the discount, a Shopify link is the discount link,
    // other text is the promotion name.
    let discount = iDisc >= 0 ? text(row[iDisc]) : "", name = iName >= 0 ? text(row[iName]) : "", link = iLink >= 0 ? text(row[iLink]) : "";
    row.forEach((c, i) => {
      if ([iDate, iCode, iDisc, iName, iBanner, iLink].includes(i)) return;
      const v = text(c);
      if (!v) return;
      if (DISCOUNT_LINK.test(v)) link ||= v;
      else if (parsePercent(v, true) !== null) discount ||= v;
      else name ||= v;
    });
    const code = iCode >= 0 ? text(row[iCode]) : "";
    if (!name && !code) continue;
    const d = parseDateText(dateText, tabYear);
    const pct = parsePercent(discount, true);
    const title = name || code;
    const start = d.ok ? d.start : null;
    n++;
    out.promotions.push({
      identityKey: identityFor({ code, links: link, title, start, kind: "promotion" }),
      kind: "promotion", tab: sh.name, row: r + 1, title,
      start_date: start, end_date: d.ok ? d.end : null, date_text: dateText,
      offer: pct !== null ? `${pct}% off` : discount || null,
      customer_discount: pct, code: CODE.test(code) ? code : null,
      terms: iBanner >= 0 ? text(row[iBanner]) || null : null,
      dateIssue: d.ok ? (d.multiple ? "several dates listed" : undefined) : `date not recognised: ${d.reason}`,
    });
  }
  out.tabs.push({ tab: sh.name, kind: "month", dataRows: n, blank: n === 0 });
}

// ------------------------------------------------------------ seasonal program
export function parseSeasonalProgram(sheets: Sheet[], year: number): ParsedWorkbook {
  const out: ParsedWorkbook = { promotions: [], occasions: [], tabs: [], issues: [] };
  for (const sh of sheets) {
    const n = norm(sh.name);
    if (n.startsWith("promotion calendar")) parsePromotionCalendar(sh, year, out);
    else if (n.startsWith("vendor discounts")) parseVendorDiscounts(sh, year, out);
    else if (n.startsWith("special collections")) parseSpecialCollections(sh, year, out);
    else out.tabs.push({ tab: sh.name, kind: "unknown", dataRows: 0, blank: false, skipped: "Not a recognised program tab" });
  }
  return out;
}

function parsePromotionCalendar(sh: Sheet, year: number, out: ParsedWorkbook) {
  const h = findHeader(sh.rows, ["occasion", "duration"]);
  if (h < 0) { out.tabs.push({ tab: sh.name, kind: "promotion_calendar", dataRows: 0, blank: true, skipped: "No header row" }); return; }
  const hdr = sh.rows[h];
  const iNo = colIndex(hdr, "no"), iOcc = colIndex(hdr, "occasion"), iDur = colIndex(hdr, "duration"), iPromo = colIndex(hdr, "promotion");
  const iCode = colIndex(hdr, "code"), iCh = colIndex(hdr, "promotion channels"), iMat = colIndex(hdr, "promotion materials");
  let n = 0, block: "main" | "vendor" = "main";
  for (let r = h + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (isBlankRow(row)) continue;
    const occ = text(row[iOcc]), dur = text(row[iDur]);
    if (norm(occ) === "vendor offers") { block = "vendor"; continue; }   // the second header inside the tab
    if (!dur) continue;                                                    // notes rows have no duration
    const d = parseDateText(dur, year);
    const codeCell = text(row[iCode]);
    const code = CODE.test(codeCell) ? codeCell : null;
    if (block === "vendor") {
      out.promotions.push({
        identityKey: `vendor:${slug(occ)}`, kind: "vendor_offer", tab: sh.name, row: r + 1, title: `${occ} vendor offer`, vendor: occ,
        start_date: d.ok ? d.start : null, end_date: d.ok ? d.end : null, date_text: dur, offer: text(row[iPromo]) || null,
        dateIssue: d.ok ? undefined : `date not recognised: ${d.reason}`, crossCheckOnly: true,
      });
      n++; continue;
    }
    const hasNumber = text(row[iNo]) !== "";
    const start = d.ok ? d.start : null;
    out.promotions.push({
      identityKey: identityFor({ code, title: occ, start, kind: "promotion" }),
      kind: hasNumber ? "promotion" : "launch", tab: sh.name, row: r + 1, title: occ,
      start_date: start, end_date: d.ok ? d.end : null, date_text: dur,
      offer: text(row[iPromo]) || null, code, terms: code ? null : codeCell || null,
      channels: iCh >= 0 ? text(row[iCh]) || null : null, materials: iMat >= 0 ? text(row[iMat]) || null : null,
      dateIssue: d.ok ? (d.multiple ? "several dates listed" : undefined) : `date not recognised: ${d.reason}`,
    });
    n++;
  }
  out.tabs.push({ tab: sh.name, kind: "promotion_calendar", dataRows: n, blank: n === 0 });
}

function parseVendorDiscounts(sh: Sheet, year: number, out: ParsedWorkbook) {
  const h = findHeader(sh.rows, ["vendor", "regular offer period"]);
  if (h < 0) { out.tabs.push({ tab: sh.name, kind: "vendor_discounts", dataRows: 0, blank: true, skipped: "No header row" }); return; }
  const hdr = sh.rows[h];
  const i = {
    vendor: colIndex(hdr, "vendor"), period: colIndex(hdr, "regular offer period"), cost: colIndex(hdr, "vendor cost reduction"),
    cust: colIndex(hdr, "customer discount"), sDates: colIndex(hdr, "bf cm dates"), sCost: colIndex(hdr, "bf cm cost reduction"),
    sCust: colIndex(hdr, "bf cm customer discount"), terms: colIndex(hdr, "terms"),
  };
  let n = 0;
  for (let r = h + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    const vendor = text(row[i.vendor]);
    const period = text(row[i.period]);
    if (!vendor || !period && text(row[i.cust]) === "") continue;   // footnote rows
    const d = parseDateText(period, year);
    out.promotions.push({
      identityKey: `vendor:${slug(vendor)}`, kind: "vendor_offer", tab: sh.name, row: r + 1, title: `${vendor} vendor offer`, vendor,
      start_date: d.ok ? d.start : null, end_date: d.ok ? d.end : null, date_text: period || null,
      vendor_cost_reduction: parsePercent(row[i.cost]), customer_discount: parsePercent(row[i.cust]),
      special_dates_text: text(row[i.sDates]) || null, special_cost_reduction: parsePercent(row[i.sCost]),
      special_customer_discount: parsePercent(row[i.sCust]), terms: text(row[i.terms]) || null,
      dateIssue: d.ok ? undefined : period ? `date not recognised: ${d.reason}` : "no offer period",
    });
    n++;
  }
  out.tabs.push({ tab: sh.name, kind: "vendor_discounts", dataRows: n, blank: n === 0 });
}

function parseSpecialCollections(sh: Sheet, year: number, out: ParsedWorkbook) {
  const h = findHeader(sh.rows, ["feature date", "special collection"]);
  if (h < 0) { out.tabs.push({ tab: sh.name, kind: "special_collections", dataRows: 0, blank: true, skipped: "No header row" }); return; }
  const hdr = sh.rows[h];
  const i = {
    feat: colIndex(hdr, "feature date"), coll: colIndex(hdr, "special collection"), vendor: colIndex(hdr, "vendor"),
    cust: colIndex(hdr, "customer discount"), period: colIndex(hdr, "offer period"), link: colIndex(hdr, "collection link"),
    code: colIndex(hdr, "code"), elig: colIndex(hdr, "eligibility"),
  };
  let n = 0;
  for (let r = h + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    const coll = text(row[i.coll]);
    if (!coll) continue;
    const d = parseDateText(row[i.period], year), f = parseDateText(row[i.feat], year);
    const link = text(row[i.link]);
    const path = /\/collections\/([a-z0-9-]+)/i.exec(link)?.[1];
    out.promotions.push({
      identityKey: path ? `collection:${path.toLowerCase()}` : `title:${slug(coll)}:${d.ok ? d.start : "nodate"}`,
      kind: "special_collection", tab: sh.name, row: r + 1, title: coll, vendor: text(row[i.vendor]) || null,
      start_date: d.ok ? d.start : null, end_date: d.ok ? d.end : null, date_text: text(row[i.period]) || null,
      customer_discount: parsePercent(row[i.cust]), collection_url: URL_RE.test(link) ? link : null,
      feature_date: f.ok ? f.start : null, terms: text(row[i.elig]) || null,
      dateIssue: d.ok ? undefined : `date not recognised: ${d.reason}`,
    });
    n++;
  }
  out.tabs.push({ tab: sh.name, kind: "special_collections", dataRows: n, blank: n === 0 });
}

/** Fields each source is allowed to set. Dashboard-owned fields (execution status, owner, notes) are never listed. */
export const SOURCE_FIELDS = [
  "title", "start_date", "end_date", "date_text", "offer", "code", "channels", "materials", "vendor",
  "vendor_cost_reduction", "customer_discount", "special_dates_text", "special_cost_reduction",
  "special_customer_discount", "terms", "collection_url", "feature_date",
] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
