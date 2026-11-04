// Reads a registered spreadsheet as an .xlsx workbook, read-only. Native Google Sheets are exported as .xlsx;
// .xlsx files stored in Drive are downloaded as they are. Uses the free Google Drive API.
//
// Credentials (server-side only, never sent to the browser):
//   GOOGLE_SYNC_REFRESH_TOKEN  refresh token of a team Google account that can already view the files,
//                              granted the read-only scope https://www.googleapis.com/auth/drive.readonly
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  the same OAuth client used for sign-in
// No sharing settings are changed. Without a refresh token the sync reports "not configured".
import ExcelJS from "exceljs";
import type { Sheet, Cell } from "../shared/calendarParse";
import { HttpError } from "./http";

const MAX_BYTES = 20 * 1024 * 1024;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SheetReader = (fileId: string, kind: "google_sheet" | "xlsx") => Promise<Sheet[]>;

export function readerConfigured() {
  return !!(process.env.GOOGLE_SYNC_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
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

export const driveReader: SheetReader = async (fileId, kind) => {
  if (!readerConfigured()) throw new HttpError(503, "not_configured", "Spreadsheet reading is not configured (missing Google sync credential).");
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
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: Cell[] = [];
      for (let c = 1; c <= Math.max(row.cellCount, ws.columnCount); c++) cells.push(cellValue(row.getCell(c).value));
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
