// Shared client for the read-only reporting APIs of the team's other apps (Gross Profit, Corporate Gifting,
// Plant Revenue Breakdown). Server side only: each credential is a private setting and is sent in a header,
// never in the address. One deadline covers the request and the body; the body is size-limited while it
// downloads; redirects are never followed (a credential is never sent anywhere else); https only.
import { HttpError } from "../http";

export const CLIENT_LIMITS = { timeoutMs: 20_000, maxBytes: 10 * 1024 * 1024 };

let fetchImpl: typeof fetch = (u, i) => fetch(u, i);
export function _setReportingFetchForTests(f: typeof fetch | null) { fetchImpl = f ?? ((u, i) => fetch(u, i)); }

/** An https origin (no path, query or credentials), or null. Local http is accepted only outside production. */
export function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const localDev = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && process.env.CONTEXT !== "production" && !process.env.NETLIFY;
    if ((u.protocol !== "https:" && !localDev) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch { return null; }
}

export type GetJsonOptions = {
  /** Overall deadline owned by the caller (epoch ms). */
  deadline?: number;
  /** Called with the response headers of a successful (2xx) answer, before the body is read. */
  onHeaders?: (headers: Headers) => void;
};

/**
 * GET a JSON document. `deadline` (optional) is an overall deadline owned by the caller: the request's own budget
 * is the smaller of the per-request limit and the time left, and it covers waiting for headers and reading the
 * body. Nothing is returned after the budget is spent, even if the transport ignores the abort. Redirects are
 * never followed and the body is size-limited. `onHeaders` sees only accepted (2xx, non-redirect) responses.
 */
export async function getJson(origin: string, path: string, headers: Record<string, string>, label: string, opts: GetJsonOptions = {}): Promise<any> {
  const { deadline, onHeaders } = opts;
  const budget = Math.min(CLIENT_LIMITS.timeoutMs, deadline === undefined ? Infinity : deadline - Date.now());
  if (budget <= 0) throw new HttpError(504, "source_timeout", `${label} ran out of time before the request was sent.`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  const aborted = new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  aborted.catch(() => {});
  try {
    const r = await Promise.race([fetchImpl(`${origin}${path}`, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "manual", signal: ctrl.signal }), aborted]);
    if (r.status >= 300 && r.status < 400) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_redirect", `${label} answered with a redirect, which is not followed.`); }
    if (r.status === 401 || r.status === 403) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_auth_failed", `${label} refused the reporting credential.`); }
    if (r.status === 503) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_disabled", `${label} has reporting turned off.`); }
    if (r.status === 409) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_conflict", `${label} reported that its data changed while it was being read.`); }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_failed", `${label} returned ${r.status}.`); }
    onHeaders?.(r.headers);
    const text = await Promise.race([readLimited(r, CLIENT_LIMITS.maxBytes, ctrl.signal, label), aborted]);
    if (ctrl.signal.aborted) throw new Error("aborted");
    try { return JSON.parse(text); } catch { throw new HttpError(502, "source_bad_response", `${label} did not return JSON.`); }
  } catch (e) {
    if (ctrl.signal.aborted) throw new HttpError(504, "source_timeout", `${label} did not answer in time.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res: Response, limit: number, signal: AbortSignal, label: string) {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) { await res.body?.cancel().catch(() => {}); throw new HttpError(413, "source_too_large", `${label} sent more than the size limit.`); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new HttpError(504, "source_timeout", `${label} timed out.`);
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); throw new HttpError(413, "source_too_large", `${label} sent more than the size limit.`); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}
