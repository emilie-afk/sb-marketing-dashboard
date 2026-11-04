import { logServerError } from "./redact";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "invalid_request", msg, details);
export const notFound = (what = "Record") => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "Your role does not allow this action.") => new HttpError(403, "forbidden", msg);
export const conflict = (msg = "This record was changed by someone else. Reload, then re-apply your edit.") =>
  new HttpError(409, "conflict", msg);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private", "x-content-type-options": "nosniff", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const retry = (e as any).retryAfter;
    return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status, retry ? { "retry-after": String(retry) } : {});
  }
  const pg = e as { code?: string; message?: string };
  if (pg?.code === "23505") return json({ error: { code: "duplicate", message: "A matching record already exists." } }, 409);
  if (pg?.message?.includes("report_revision_immutable"))
    return json({ error: { code: "immutable", message: "Published report revisions cannot change. Create a correction revision instead." } }, 409);
  if (["23514", "23503", "22P02", "22007", "22008"].includes(pg?.code ?? ""))
    return json({ error: { code: "constraint", message: "The data did not pass validation. Check required fields and values." } }, 422);
  logServerError("api", e);
  return json({ error: { code: "server_error", message: "Something went wrong on the server. Nothing was saved." } }, 500);
}

export async function readJson(req: Request, maxBytes = 2_000_000): Promise<any> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new HttpError(413, "too_large", "Request body is too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "Request body is too large.");
  try { return text ? JSON.parse(text) : {}; } catch { throw badRequest("Body must be valid JSON."); }
}
