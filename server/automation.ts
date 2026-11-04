// Automation clients (scheduled tasks) authenticate with their own bearer tokens, separate from team sessions.
// Only a SHA-256 hash is stored; the token is shown once when an admin creates the client.
import { createHash, randomBytes } from "node:crypto";
import { one, query } from "./db";
import { HttpError } from "./http";

export type Client = { id: string; label: string; allowed_sources: string[]; allowed_businesses: string[] };

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createClient(label: string, sources: string[], businesses: string[], by: string) {
  const token = "mkd_" + randomBytes(32).toString("base64url");
  const row = await one<{ id: string }>(
    `insert into automation_clients (label, token_hash, token_hint, allowed_sources, allowed_businesses, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [label, hashToken(token), token.slice(-4), sources, businesses, by]);
  return { id: row!.id, token };
}

export async function clientFromRequest(req: Request): Promise<Client> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(mkd_[A-Za-z0-9_-]{40,})$/.exec(h);
  if (!m) throw new HttpError(401, "unauthorized", "Missing or malformed automation token.");
  const c = await one<Client>(
    "select id, label, allowed_sources, allowed_businesses from automation_clients where token_hash = $1 and revoked_at is null",
    [hashToken(m[1])]);
  if (!c) throw new HttpError(401, "unauthorized", "Unknown or revoked automation token.");
  return c;
}

export function assertClientMay(c: Client, source: string, business: string) {
  if (!c.allowed_sources.includes(source) && !c.allowed_sources.includes("*"))
    throw new HttpError(403, "forbidden", `This token may not submit for source '${source}'.`);
  if (!c.allowed_businesses.includes(business))
    throw new HttpError(403, "forbidden", `This token may not submit for business '${business}'.`);
}

export async function listClients() {
  return query("select id, label, token_hint, allowed_sources, allowed_businesses, created_by, created_at, revoked_at from automation_clients order by created_at desc");
}
export async function revokeClient(id: string) {
  await query("update automation_clients set revoked_at = now() where id = $1 and revoked_at is null", [id]);
}
