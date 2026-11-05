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

export async function getJson(origin: string, path: string, headers: Record<string, string>, label: string, onHeaders?: (h: Headers) => void): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLIENT_LIMITS.timeoutMs);
  try {
    const r = await fetchImpl(`${origin}${path}`, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "manual", signal: ctrl.signal });
    if (r.status >= 300 && r.status < 400) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_redirect", `${label} answered with a redirect, which is not followed.`); }
    if (r.status === 401 || r.status === 403) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_auth_failed", `${label} refused the reporting credential.`); }
    if (r.status === 503) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_disabled", `${label} has reporting turned off.`); }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, "source_failed", `${label} returned ${r.status}.`); }
    onHeaders?.(r.headers);
    const text = await readLimited(r, CLIENT_LIMITS.maxBytes, ctrl.signal, label);
    try { return JSON.parse(text); } catch { throw new HttpError(502, "source_bad_response", `${label} did not return JSON.`); }
  } catch (e) {
    if (ctrl.signal.aborted) throw new HttpError(504, "source_timeout", `${label} did not answer within ${CLIENT_LIMITS.timeoutMs / 1000} seconds.`);
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
