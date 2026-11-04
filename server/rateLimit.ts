// Durable, database-backed request limits (fixed windows). Survives function restarts and concurrent
// instances. Keys are HMAC hashes, so neither client IP addresses nor Google subjects are stored.
import { createHmac } from "node:crypto";
import { getPool } from "./db";
import { HttpError } from "./http";

export type Limit = { bucket: string; limit: number; windowSec: number };

function hashKey(value: string) {
  const salt = process.env.SESSION_SECRET || "mkd-rate-limit";
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 24);
}

/** Client address as reported by Netlify's edge (falls back to the first X-Forwarded-For hop). */
export function clientKey(req: Request) {
  const ip = req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return `ip:${hashKey(ip)}`;
}
export const subjectKey = (sub: string) => `sub:${hashKey(sub)}`;

/** Counts one hit; throws 429 when the window's limit is exceeded. Fails closed if the database is unavailable. */
export async function hit(l: Limit) {
  const windowMs = l.windowSec * 1000;
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  let hits: number;
  try {
    const r = await getPool().query(
      `insert into rate_limits (bucket, window_start, hits) values ($1, $2, 1)
       on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1 returning hits`,
      [l.bucket, start],
    );
    hits = r.rows[0].hits;
    if (Math.random() < 0.01) await getPool().query("delete from rate_limits where window_start < now() - interval '2 days'");
  } catch {
    throw new HttpError(503, "unavailable", "The service is temporarily unavailable. Try again shortly.");
  }
  if (hits > l.limit) {
    const retry = Math.max(1, Math.ceil((start.getTime() + windowMs - Date.now()) / 1000));
    throw Object.assign(new HttpError(429, "rate_limited", `Too many requests. Try again in ${Math.ceil(retry / 60)} minute(s).`), { retryAfter: retry });
  }
}

const H = 3600;
/** Expensive operations, per signed-in account. */
export const EXPENSIVE: [RegExp, number, number][] = [
  [/^\/settings\/sheet-sources\/[^/]+\/refresh$/, 30, H],
  [/^\/attachments$/, 120, H],
];
export const LIMITS = {
  login: { limit: 30, windowSec: 600 },        // per client address
  callback: { limit: 30, windowSec: 600 },     // per client address
  ingest: { limit: 120, windowSec: H },        // per automation client
  writes: { limit: 600, windowSec: 600 },      // all mutations per Google account
};
