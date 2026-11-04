// Google sign-in (OAuth 2.0 authorization-code flow) with a server-side allowlist and roles.
// Approved members and their roles come ONLY from the private TEAM_MEMBERS env var:
//   TEAM_MEMBERS="person@example.com:admin,other@example.com:editor,third@example.com:viewer"
// The role is re-read on every request, so changing or removing a member takes effect immediately.
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { HttpError } from "./http";
import { hit, clientKey, LIMITS } from "./rateLimit";

export type Role = "viewer" | "editor" | "admin";
export type Session = { sub: string; email: string; role: Role };
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
export const atLeast = (s: Session, r: Role) => RANK[s.role] >= RANK[r];

const SESSION_COOKIE = "mkd_session";
const STATE_COOKIE = "mkd_oauth";
const SESSION_HOURS = 12;
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function secretKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "misconfigured", "SESSION_SECRET is not configured (min 32 chars).");
  return new TextEncoder().encode(s);
}

export function teamMembers(): Map<string, Role> {
  const out = new Map<string, Role>();
  for (const entry of (process.env.TEAM_MEMBERS ?? "").split(",")) {
    const [email, role] = entry.trim().toLowerCase().split(":");
    if (email && (role === "viewer" || role === "editor" || role === "admin")) out.set(email, role);
  }
  return out;
}
export const approvedEmails = () => new Set(teamMembers().keys());
export const roleOf = (email: string): Role | null => teamMembers().get(email.trim().toLowerCase()) ?? null;
export function isApproved(email: string) {
  return roleOf(email) !== null;
}

/**
 * Sign-in can only work with a strong session secret, a non-empty private allowlist and, if set, a valid
 * SESSION_NOT_BEFORE. A broken cutoff denies everything rather than silently disabling revocation.
 */
export function authConfigured() {
  return (process.env.SESSION_SECRET ?? "").length >= 32 && approvedEmails().size > 0 && notBefore() !== "invalid";
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;
/** Parses an ISO time with zone, rejecting impossible calendar values (e.g. Feb 30, hour 24) instead of rolling over. */
export function parseStrictIsoTime(v: string): number | null {
  const m = ISO_TIME.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // day 0 of next month = last day of this one
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || se > 59) return null;
  if (m[7] !== "Z" && (Number(m[9]) > 23 || Number(m[10]) > 59)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Optional emergency switch: sessions issued before this instant (ISO time with zone) are rejected. */
export function notBefore(): number | null | "invalid" {
  const v = process.env.SESSION_NOT_BEFORE?.trim();
  if (!v) return null;
  const t = parseStrictIsoTime(v);
  return t === null ? "invalid" : Math.floor(t / 1000);
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Cookies are always Secure, except plain-http local previews (localhost / 127.0.0.1). */
function cookie(name: string, value: string, maxAge: number, req: Request) {
  const u = new URL(req.url);
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  const secure = local ? "" : "; Secure";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function issueSession(s: { sub: string; email: string }) {
  return new SignJWT({ email: s.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .setAudience("mkd-app")
    .sign(secretKey());
}

/** Returns the session if the cookie is valid AND the login is still on the allowlist. */
export async function readSession(req: Request): Promise<Session | null> {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { audience: "mkd-app", algorithms: ["HS256"], requiredClaims: ["exp", "iat", "sub"] });
    const email = String(payload.email ?? "");
    // The allowlist is re-checked on EVERY request: removing a login from it ends that login's access at once.
    const role = roleOf(email);
    if (!payload.sub || !role) return null;
    const nb = notBefore();
    if (nb === "invalid") return null;
    if (nb !== null && (payload.iat ?? 0) < nb) return null;
    return { sub: payload.sub, email, role };
  } catch {
    return null;
  }
}

function baseUrl(req: Request) {
  return (process.env.APP_BASE_URL || new URL(req.url).origin).replace(/\/$/, "");
}

export function redirectUri(req: Request) {
  return `${baseUrl(req)}/api/auth/callback`;
}

export async function loginRedirect(req: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET || !authConfigured()) throw new HttpError(503, "misconfigured", "Sign-in is not configured.");
  await hit({ bucket: `login:${clientKey(req)}`, ...LIMITS.login });
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const signed = await new SignJWT({ state, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .setAudience("mkd-oauth")
    .sign(secretKey());
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri(req));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("prompt", "select_account");
  return new Response(null, { status: 302, headers: { location: u.toString(), "set-cookie": cookie(STATE_COOKIE, signed, 600, req) } });
}

export async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const home = baseUrl(req);
  const fail = (reason: string) =>
    new Response(null, {
      status: 302,
      headers: { location: `${home}/?auth_error=${reason}`, "set-cookie": cookie(STATE_COOKIE, "", 0, req) },
    });
  try {
    await hit({ bucket: `callback:${clientKey(req)}`, ...LIMITS.callback });
    const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret || !authConfigured()) return fail("failed");
    const raw = cookies(req)[STATE_COOKIE];
    if (!raw) return fail("expired");
    const { payload: st } = await jwtVerify(raw, secretKey(), { audience: "mkd-oauth", algorithms: ["HS256"] });
    if (!url.searchParams.get("state") || url.searchParams.get("state") !== st.state) return fail("state");
    const code = url.searchParams.get("code");
    if (!code) return fail("cancelled");

    const tokenRes = await tokenFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return fail("token");
    const tok = (await tokenRes.json()) as { id_token?: string };
    if (!tok.id_token) return fail("token");
    // Google's signature (JWKS), issuer, audience (our client), expiry and nonce are all verified.
    const { payload } = await verifyGoogleIdToken(tok.id_token, clientId);
    if (!st.nonce || payload.nonce !== st.nonce) return fail("state");
    const email = String(payload.email ?? "");
    if (payload.email_verified !== true || !payload.sub || !isApproved(email)) return fail("not_authorized");

    const session = await issueSession({ sub: payload.sub, email });
    const headers = new Headers({ location: `${home}/` });
    headers.append("set-cookie", cookie(SESSION_COOKIE, session, SESSION_HOURS * 3600, req));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", 0, req));
    return new Response(null, { status: 302, headers });
  } catch {
    return fail("failed");
  }
}

/** Overridable in tests only (no network). */
let googleVerifier: (idToken: string, clientId: string) => Promise<{ payload: Record<string, any> }> = (idToken, clientId) =>
  jwtVerify(idToken, GOOGLE_JWKS, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId, requiredClaims: ["exp", "iat", "sub"] }) as any;
function verifyGoogleIdToken(idToken: string, clientId: string) { return googleVerifier(idToken, clientId); }
export function _setGoogleVerifierForTests(f: typeof googleVerifier | null) {
  googleVerifier = f ?? ((idToken, clientId) => jwtVerify(idToken, GOOGLE_JWKS, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId, requiredClaims: ["exp", "iat", "sub"] }) as any);
}
let tokenFetch: typeof fetch = (u, i) => fetch(u, i);
export function _setTokenFetchForTests(f: typeof fetch | null) { tokenFetch = f ?? ((u, i) => fetch(u, i)); }

export function logoutResponse(req: Request) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie(SESSION_COOKIE, "", 0, req) },
  });
}

export const sessionCookieName = SESSION_COOKIE;
