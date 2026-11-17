// Slack Review routes (planning owner only; every rule is in server/review.ts). Everyone else gets 404.
import type { Router } from "../router";
import { badRequest, readJson } from "../http";
import { z } from "zod";
import { assertReviewer, pendingCount, listSuggestions, getSuggestion, editSuggestion, editSchema, previewSuggestion, createFromSuggestion, dismissSuggestion, refreshSuggestion } from "../review";

const version = z.object({ version: z.number().int().min(1) }).strict();

export function registerReview(r: Router) {
  r.get("/review/summary", async ({ session }) => ({ pending: await pendingCount(session) }));
  r.get("/review/suggestions", async ({ url, session }) => {
    assertReviewer(session);
    const status = url.searchParams.get("status") ?? "pending", q = url.searchParams.get("q");
    if (!["pending", "approved", "dismissed", "all"].includes(status)) throw badRequest("Invalid status.");
    if (q && q.length > 100) throw badRequest("Search is too long.");
    return { items: await listSuggestions(session, status, q) };
  });
  r.get("/review/suggestions/:id", async ({ params, session }) => ({ suggestion: await getSuggestion(session, params.id) }));
  r.patch("/review/suggestions/:id", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = editSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest(`${v.error.issues[0]?.path.join(".") || "suggestion"}: ${v.error.issues[0]?.message ?? "invalid"}`);
    return { suggestion: await editSuggestion(session, params.id, v.data) };
  }, "viewer");
  r.post("/review/suggestions/:id/preview", async ({ params, session }) => previewSuggestion(session, params.id), "viewer");
  r.post("/review/suggestions/:id/create", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = version.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    return createFromSuggestion(session, params.id, v.data.version);
  }, "viewer");
  r.post("/review/suggestions/:id/dismiss", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = version.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    return { suggestion: await dismissSuggestion(session, params.id, v.data.version) };
  }, "viewer");
  r.post("/review/suggestions/:id/refresh", async ({ params, session }) => ({ suggestion: await refreshSuggestion(session, params.id) }), "viewer");
}
