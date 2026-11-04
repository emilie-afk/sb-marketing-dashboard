// Runs the Apps Script reader itself (scripts/apps-script/sheet-reader.gs) in a sandbox with mocked Google
// services, so the key check and the allowed-file list are verified to stop a request before Drive is called.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SRC = readFileSync(join(__dirname, "..", "scripts", "apps-script", "sheet-reader.gs"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(__dirname, "..", "scripts", "apps-script", "appsscript.json"), "utf8"));
const KEY = "s".repeat(40);
const SHEET = "FAKEsheetidabcdefghijklmno01";
const FILE = "FAKExlsxidabcdefghijklmno02";

function sandbox(props: Record<string, string | null>, drive: (url: string) => { code: number; bytes?: number[]; text?: string } = () => ({ code: 200, bytes: [1, 2, 3] })) {
  const fetches: { url: string; opts: any }[] = [];
  const ctx: any = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => (k in props ? props[k] : null) }) },
    ScriptApp: { getOAuthToken: () => "FAKE-ACCESS-TOKEN" },
    UrlFetchApp: {
      fetch: (url: string, opts: any) => {
        fetches.push({ url, opts });
        const r = drive(url);
        return { getResponseCode: () => r.code, getBlob: () => ({ getBytes: () => r.bytes ?? [] }), getContentText: () => r.text ?? "" };
      },
    },
    Utilities: { base64Encode: (b: number[]) => Buffer.from(b).toString("base64") },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t: string) => ({ setMimeType: () => ({ text: t }) }) },
    Logger: { log: () => {} },
    JSON, encodeURIComponent, String,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const post = (body: unknown) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }).text);
  return { ctx, fetches, post };
}
const allowedProps = { READER_KEY: KEY, ALLOWED_FILE_IDS: `${SHEET}, ${FILE}` };

describe("Apps Script reader (script code)", () => {
  it("a wrong, missing or empty key is refused before any Drive request", () => {
    const s = sandbox(allowedProps);
    expect(s.post({ key: "x".repeat(40), fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "bad_key" });
    expect(s.post({ fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "bad_key" });
    expect(s.post({ key: KEY.slice(0, 39), fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "bad_key" });
    expect(s.fetches).toHaveLength(0);
  });
  it("a short or unset key in the script properties refuses everything, even a matching key", () => {
    const short = sandbox({ READER_KEY: "abc", ALLOWED_FILE_IDS: SHEET });
    expect(short.post({ key: "abc", fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "bad_key" });
    const unset = sandbox({ ALLOWED_FILE_IDS: SHEET });
    expect(unset.post({ key: "", fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "bad_key" });
    expect(short.fetches.length + unset.fetches.length).toBe(0);
  });
  it("a file not on the allowed list is refused before any Drive request (also with an empty list)", () => {
    const s = sandbox(allowedProps);
    expect(s.post({ key: KEY, fileId: "FAKEotheridabcdefghijklmn03", kind: "google_sheet" })).toEqual({ ok: false, error: "not_allowed" });
    const empty = sandbox({ READER_KEY: KEY });
    expect(empty.post({ key: KEY, fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "not_allowed" });
    expect(s.fetches.length + empty.fetches.length).toBe(0);
  });
  it("malformed ids, unknown kinds and invalid JSON are refused before any Drive request", () => {
    const s = sandbox(allowedProps);
    expect(s.post({ key: KEY, fileId: "../etc/passwd", kind: "xlsx" })).toEqual({ ok: false, error: "bad_request" });
    expect(s.post({ key: KEY, fileId: SHEET, kind: "pdf" })).toEqual({ ok: false, error: "bad_request" });
    expect(s.post("{not json")).toEqual({ ok: false, error: "read_failed" });
    expect(s.fetches).toHaveLength(0);
  });
  it("an allowed Google Sheet is exported as .xlsx with the script's own token, read-only", () => {
    const s = sandbox(allowedProps);
    expect(s.post({ key: KEY, fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: true, data: Buffer.from([1, 2, 3]).toString("base64") });
    expect(s.fetches).toHaveLength(1);
    expect(s.fetches[0].url).toBe(`https://www.googleapis.com/drive/v3/files/${SHEET}/export?mimeType=${encodeURIComponent("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`);
    expect(s.fetches[0].opts.headers.Authorization).toBe("Bearer FAKE-ACCESS-TOKEN");
    expect(s.fetches[0].opts.method ?? "get").toBe("get");
    expect(s.fetches[0].url).not.toContain(KEY);
  });
  it("an allowed .xlsx file is downloaded as it is", () => {
    const s = sandbox(allowedProps);
    expect(s.post({ key: KEY, fileId: FILE, kind: "xlsx" })).toMatchObject({ ok: true });
    expect(s.fetches[0].url).toBe(`https://www.googleapis.com/drive/v3/files/${FILE}?alt=media&supportsAllDrives=true`);
  });
  it("maps Drive refusals and failures", () => {
    expect(sandbox(allowedProps, () => ({ code: 404 })).post({ key: KEY, fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "no_access" });
    expect(sandbox(allowedProps, () => ({ code: 403 })).post({ key: KEY, fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "no_access" });
    expect(sandbox(allowedProps, () => ({ code: 500 })).post({ key: KEY, fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "read_failed" });
    expect(sandbox(allowedProps, () => { throw new Error("quota"); }).post({ key: KEY, fileId: SHEET, kind: "google_sheet" })).toEqual({ ok: false, error: "read_failed" });
  });
  it("GET requests do nothing", () => {
    const s = sandbox(allowedProps);
    expect(JSON.parse(s.ctx.doGet({ parameter: { key: KEY, fileId: SHEET } }).text)).toEqual({ ok: false, error: "bad_request" });
    expect(s.fetches).toHaveLength(0);
  });
  it("the manifest requests read-only Drive access and runs as the deploying account", () => {
    expect([...MANIFEST.oauthScopes].sort()).toEqual(["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/script.external_request"]);
    expect(MANIFEST.webapp).toEqual({ executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS" });
  });
});
