// Private API under /api/*. Every route requires an approved team member, except sign-in and the automation
// submission endpoint (which uses its own per-client token, never a session).
import { Router } from "./router";
import { HttpError, errorResponse, json, readJson } from "./http";
import { readSession, loginRedirect, handleCallback, logoutResponse, atLeast } from "./auth";
import { hit, subjectKey, clientKey, LIMITS, EXPENSIVE } from "./rateLimit";
import { registerDashboard } from "./routes/dashboard";
import { registerWork } from "./routes/work";
import { registerReviews } from "./routes/reviews";
import { registerReports, storeAttachment } from "./routes/reports";
import { registerSettings } from "./routes/settings";
import { clientFromRequest, assertClientMay } from "./automation";
import { checkSubmission } from "../shared/submission";
import { applySubmission } from "./imports";
import { one } from "./db";
import { pullCheck } from "./pullCheck";

export function createApp() {
  const r = new Router();
  registerDashboard(r);
  registerWork(r);
  registerReviews(r);
  registerReports(r);
  registerSettings(r);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    try {
      if (path === "/auth/login" && req.method === "GET") return await loginRedirect(req);
      if (path === "/auth/callback" && req.method === "GET") return await handleCallback(req);
      if (path === "/auth/logout" && req.method === "POST") return logoutResponse(req);
      if (path === "/submissions" && req.method === "POST") return await submission(req);
      if (path === "/pull-check" && req.method === "POST") return await pullCheck(req);
      let m = /^\/submissions\/([A-Za-z0-9_.:-]{3,120})\/attachments$/.exec(path);
      if (m && req.method === "POST") return await submissionAttachment(req, m[1]);

      const session = await readSession(req);
      // DEMO_DATA_BANNER is set only by the local dev server, so synthetic data is never presented as live.
      const demo = process.env.DEMO_DATA_BANNER === "1";
      if (path === "/me") return json(session ? { signedIn: true, email: session.email, role: session.role, demo } : { signedIn: false, demo });
      if (!session) throw new HttpError(401, "unauthorized", "Sign in with an approved team account.");

      // Same-origin check for state-changing requests (cookies are SameSite=Lax; this blocks cross-site form posts).
      if (req.method !== "GET") {
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin && origin !== (process.env.APP_BASE_URL ?? "").replace(/\/$/, "")) throw new HttpError(403, "bad_origin", "Cross-site request refused.");
        await hit({ bucket: `writes:${subjectKey(session.sub)}`, ...LIMITS.writes });
        for (const [re, limit, win] of EXPENSIVE) if (re.test(path)) await hit({ bucket: `x:${re.source}:${subjectKey(session.sub)}`, limit, windowSec: win });
      }
      const found = r.match(req.method, path);
      if (found === null) throw new HttpError(404, "not_found", "No such endpoint.");
      if (found === "method") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      if (!atLeast(session, found.route.role)) throw new HttpError(403, "forbidden", `This needs the ${found.route.role} role.`);
      const out = await found.route.h({ req, url, params: found.params, session });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Scheduled-task submissions. Returns a receipt; a failed submission never removes earlier data. */
async function submission(req: Request) {
  const client = await clientFromRequest(req);
  await hit({ bucket: `ingest:${client.id}`, ...LIMITS.ingest });
  const body = await readJson(req, 5_000_000);
  const checked = checkSubmission(body);
  if (!checked.ok) return json({ outcome: "rejected", message: "The submission is not valid.", errors: checked.errors }, 422);
  assertClientMay(client, checked.value.envelope.source, checked.value.envelope.business);
  const receipt = await applySubmission(checked.value, `client:${client.label}`, "submission.api", `client:${client.id}`);
  const status = receipt.outcome === "accepted" ? 201 : receipt.outcome === "unchanged" ? 200 : receipt.outcome === "rejected" ? 409 : 500;
  return json(receipt, status);
}

async function submissionAttachment(req: Request, submissionId: string) {
  const client = await clientFromRequest(req);
  await hit({ bucket: `ingest:${client.id}`, ...LIMITS.ingest });
  // A token can attach files only to its own accepted submissions, for a business and source it is allowed.
  const u = new URL(req.url);
  const business = u.searchParams.get("business") ?? "", source = u.searchParams.get("source") ?? "";
  if (!business || !source) throw new HttpError(400, "invalid_request", "Add ?business=<business>&source=<source> for the submission.");
  assertClientMay(client, source, business);
  const run = await one<{ id: string }>(
    `select id from import_runs where source_id = 'submission.api' and submitter = $1 and business_id = $2 and submission_source = $3
        and submission_id = $4 and status = 'active'`, [`client:${client.id}`, business, source, submissionId]);
  if (!run) throw new HttpError(404, "not_found", "No accepted submission with that id from this token.");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "invalid_request", "Send one file as multipart form data.");
  const id = await storeAttachment("import_run", run.id, file, `client:${client.label}`);
  return json({ id, outcome: "accepted" }, 201);
}
export { clientKey };
