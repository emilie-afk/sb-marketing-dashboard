// Reads a registered spreadsheet as an .xlsx workbook, read-only. Native Google Sheets are exported as .xlsx;
// .xlsx files stored in Drive are downloaded as they are. Free, no sharing settings are changed.
//
// Two interchangeable readers (server-side settings only, never sent to the browser). The first one configured wins:
// 1. Apps Script reader (preferred): a small web app the team deploys from a team account that can already view
//    the files (scripts/apps-script/sheet-reader.gs). It runs as that account, so it is not subject to the
//    7-day refresh-token limit of OAuth apps in Testing mode. It still depends on that account's authorization
//    of the script, its continued access to the files, and Apps Script quotas.
//      SHEET_READER_URL  the web app address (https://script.google.com/macros/s/<id>/exec)
//      SHEET_READER_KEY  a shared secret of at least 32 characters, also stored in the script's properties
// 2. Drive API with a refresh token:
//      GOOGLE_SYNC_REFRESH_TOKEN  refresh token of a team Google account that can already view the files,
//                                 granted the read-only scope https://www.googleapis.com/auth/drive.readonly
//      GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  the same OAuth client used for sign-in
// Without either the sync reports "not configured".
import ExcelJS from "exceljs";
import type { Sheet, Cell } from "../shared/calendarParse";
import { HttpError } from "./http";

const MAX_BYTES = 20 * 1024 * 1024;
// Upper bound on cells read from one workbook (all tabs), so a sheet formatted to a huge range fails clearly.
const MAX_CELLS = 2_000_000;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SheetReader = (fileId: string, kind: "google_sheet" | "xlsx") => Promise<Sheet[]>;

const APPS_SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,120}\/exec$/;

export function appsScriptConfigured() {
  return APPS_SCRIPT_URL.test(process.env.SHEET_READER_URL ?? "") && (process.env.SHEET_READER_KEY ?? "").length >= 32;
}
export function driveConfigured() {
  return !!(process.env.GOOGLE_SYNC_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
export function readerConfigured() {
  return appsScriptConfigured() || driveConfigured();
}

let fetchImpl: typeof fetch = (u, i) => fetch(u, i);
export function _setFetchForTests(f: typeof fetch | null) { fetchImpl = f ?? ((u, i) => fetch(u, i)); }

async function accessToken(): Promise<string> {
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_SYNC_REFRESH_TOKEN!, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new HttpError(502, "google_auth_failed", "Google read access was refused. The sync credential may need to be renewed.");
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new HttpError(502, "google_auth_failed", "Google did not return an access token.");
  return j.access_token;
}

// Default reader used by the sync: Apps Script when configured, otherwise the Drive API.
export const sheetReader: SheetReader = (fileId, kind) => (appsScriptConfigured() ? appsScriptReader(fileId, kind) : driveReader(fileId, kind));

const SCRIPT_ERRORS: Record<string, [string, string]> = {
  bad_key: ["reader_refused", "The spreadsheet reader refused the request. Check that SHEET_READER_KEY matches the script's key."],
  not_allowed: ["file_not_allowed", "This spreadsheet is not on the reader script's list of allowed files."],
  no_access: ["file_unavailable", "The spreadsheet could not be opened by the reader script's account (missing or no access)."],
  bad_request: ["read_failed", "The spreadsheet reader rejected the request."],
};

// Limits for the Apps Script reader. One deadline covers the request, every redirect and the body download.
export const READER_LIMITS = {
  timeoutMs: 60_000,
  maxRedirects: 2,
  // Base64 of a 20 MB file plus the small JSON wrapper.
  maxResponseBytes: Math.ceil((MAX_BYTES * 4) / 3) + 4096,
};
// Apps Script answers the POST with a redirect to its result page on this host only.
const RESULT_HOST = "script.googleusercontent.com";
const MISDEPLOYED = "The spreadsheet reader did not answer as expected. Check that the script is deployed as a web app that runs as its owner and that anyone can call.";

export const appsScriptReader: SheetReader = async (fileId, kind) => {
  if (!appsScriptConfigured()) throw new HttpError(503, "not_configured", "Spreadsheet reading is not configured (missing reader address or key).");
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(fileId)) throw new HttpError(400, "invalid_file_id", "Invalid file id.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READER_LIMITS.timeoutMs);
  try {
    const text = await fetchScriptResult(fileId, kind, ctrl.signal);
    let j: { ok?: boolean; error?: string; data?: string };
    try { j = JSON.parse(text); } catch { throw new HttpError(502, "reader_misconfigured", MISDEPLOYED); }
    if (!j || !j.ok) {
      const [code, msg] = SCRIPT_ERRORS[j?.error ?? ""] ?? ["read_failed", "The spreadsheet reader could not read the file."];
      throw new HttpError(502, code, msg);
    }
    if (typeof j.data !== "string" || !j.data) throw new HttpError(502, "read_failed", "The spreadsheet reader returned no file.");
    const buf = Buffer.from(j.data, "base64");
    if (buf.length > MAX_BYTES) throw new HttpError(413, "too_large", "The spreadsheet is larger than 20 MB.");
    return await workbookToSheets(buf);
  } catch (e) {
    if (ctrl.signal.aborted) throw new HttpError(504, "read_timeout", `The spreadsheet reader did not finish within ${Math.round(READER_LIMITS.timeoutMs / 1000)} seconds.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

// Sends the key once, in the body of the first request only. Redirects are followed by hand: only 301/302/303
// (which become a GET without body or headers), only to https://script.googleusercontent.com, at most
// READER_LIMITS.maxRedirects hops. 307/308 (which would repeat the POST and its key) and any other host are refused.
async function fetchScriptResult(fileId: string, kind: string, signal: AbortSignal): Promise<string> {
  let res = await fetchImpl(process.env.SHEET_READER_URL!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: process.env.SHEET_READER_KEY, fileId, kind }),
    redirect: "manual",
    signal,
  });
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    await res.body?.cancel().catch(() => {});
    if (![301, 302, 303].includes(res.status)) throw new HttpError(502, "reader_redirect_refused", "The spreadsheet reader answered with a redirect that would resend the request. It was not followed.");
    if (hops >= READER_LIMITS.maxRedirects) throw new HttpError(502, "reader_redirect_refused", "The spreadsheet reader redirected too many times.");
    let next: URL;
    try { next = new URL(res.headers.get("location") ?? "", process.env.SHEET_READER_URL!); } catch { throw new HttpError(502, "reader_redirect_refused", "The spreadsheet reader sent an invalid redirect."); }
    if (next.protocol !== "https:" || next.hostname !== RESULT_HOST || next.username || next.password || (next.port && next.port !== "443")) {
      throw new HttpError(502, "reader_misconfigured", MISDEPLOYED);
    }
    res = await fetchImpl(next.toString(), { method: "GET", redirect: "manual", signal });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(502, "read_failed", `The spreadsheet reader returned ${res.status}.`);
  }
  return readLimited(res, READER_LIMITS.maxResponseBytes, signal);
}

// Reads a response body as text, stopping as soon as it passes the limit or the deadline.
async function readLimited(res: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(413, "too_large", "The spreadsheet is larger than 20 MB.");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new HttpError(504, "read_timeout", "The spreadsheet reader timed out.");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new HttpError(504, "read_timeout", "The spreadsheet reader timed out.");
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "too_large", "The spreadsheet is larger than 20 MB.");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const driveReader: SheetReader = async (fileId, kind) => {
  if (!driveConfigured()) throw new HttpError(503, "not_configured", "Spreadsheet reading is not configured (missing Google sync credential).");
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(fileId)) throw new HttpError(400, "invalid_file_id", "Invalid file id.");
  const token = await accessToken();
  const url = kind === "google_sheet"
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX)}`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 404 || r.status === 403) throw new HttpError(502, "file_unavailable", "The spreadsheet could not be opened with the sync account (missing or no access).");
  if (!r.ok) throw new HttpError(502, "read_failed", `Google returned ${r.status} for the spreadsheet.`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new HttpError(413, "too_large", "The spreadsheet is larger than 20 MB.");
  return workbookToSheets(buf);
};

export async function workbookToSheets(buf: Buffer | ArrayBuffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: Sheet[] = [];
  let total = 0;
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    // ExcelJS recomputes columnCount by scanning every row on each access, so read it once per tab. (Reading it
    // per cell made real calendars with ~1,000 formatted rows per tab take longer than the background limit.)
    const width = ws.columnCount;
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: Cell[] = [];
      const last = Math.max(row.cellCount, width);
      total += last;
      if (total > MAX_CELLS) throw new HttpError(413, "too_large", `The spreadsheet has more than ${MAX_CELLS.toLocaleString("en-US")} cells.`);
      for (let c = 1; c <= last; c++) cells.push(cellValue(row.getCell(c).value));
      rows[n - 1] = cells;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    out.push({ name: ws.name, rows });
  });
  return out;
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as any;
    if ("result" in o) return cellValue(o.result);                       // formula
    if ("richText" in o) return o.richText.map((t: any) => t.text).join("");
    if ("hyperlink" in o) return o.text && typeof o.text === "object" ? cellValue(o.text) : o.hyperlink && !o.text ? o.hyperlink : `${o.text ?? ""}`.trim() === "" ? o.hyperlink : o.text;
    if ("error" in o) return null;
    return null;
  }
  return v as Cell;
}
