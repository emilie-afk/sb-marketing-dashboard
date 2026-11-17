// Slack Review routes (planning owner only; every rule is in server/review.ts). Everyone else gets 404.
import type { Router } from "../router";
import { badRequest, readJson } from "../http";
import { z } from "zod";
import { assertReviewer, pendingCount, listSuggestions, getSuggestion, editSuggestion, editSchema, previewSuggestion, addToPlanSchema, addToPlan, planChoices, returnToReview, createFromSuggestion, dismissSuggestion, refreshSuggestion } from "../review";
import { pendingCorporateCount, listDrafts, editDraft, draftEditSchema, bulkAssign, bulkAssignSchema, sendDrafts, dismissDraft, refreshDrafts } from "../corporateTasks";

const version = z.object({ version: z.number().int().min(1) }).strict();

export function registerReview(r: Router) {
  r.get("/review/summary", async ({ session }) => ({ pending: await pendingCount(session) }));
  r.get("/review/suggestions", async ({ url, session }) => {
    assertReviewer(session);
    const status = url.searchParams.get("status") ?? "pending", q = url.searchParams.get("q");
    if (!["pending", "planned", "approved", "dismissed", "all"].includes(status)) throw badRequest("Invalid status.");
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
  r.get("/review/suggestions/:id/plans", async ({ params, session }) => planChoices(session, params.id));
  r.post("/review/suggestions/:id/add-to-plan", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = addToPlanSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version and plan_id are required.");
    return { suggestion: await addToPlan(session, params.id, v.data) };
  }, "viewer");
  r.post("/review/suggestions/:id/return", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = version.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    return { suggestion: await returnToReview(session, params.id, v.data.version) };
  }, "viewer");
  r.post("/review/suggestions/:id/refresh", async ({ params, session }) => ({ suggestion: await refreshSuggestion(session, params.id) }), "viewer");

  // ---- Corporate Gifts tasks (planning owner only; rules in server/corporateTasks.ts)
  r.get("/review/corporate/summary", async ({ session }) => ({ pending: await pendingCorporateCount(session) }));
  r.get("/review/corporate", async ({ url, session }) => {
    assertReviewer(session);
    const status = url.searchParams.get("status") ?? "pending";
    if (!["pending", "approved", "dismissed", "all"].includes(status)) throw badRequest("Invalid status.");
    return listDrafts(session, status);
  });
  r.patch("/review/corporate/:id", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = draftEditSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest(`${v.error.issues[0]?.path.join(".") || "draft"}: ${v.error.issues[0]?.message ?? "invalid"}`);
    return { draft: await editDraft(session, params.id, v.data) };
  }, "viewer");
  r.post("/review/corporate/bulk-assign", async ({ req, session }) => {
    assertReviewer(session);
    const v = bulkAssignSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest(v.error.issues[0]?.message ?? "invalid");
    return bulkAssign(session, v.data);
  }, "viewer");
  r.post("/review/corporate/send", async ({ req, session }) => {
    assertReviewer(session);
    const v = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict().safeParse(await readJson(req));
    if (!v.success) throw badRequest("Choose 1 to 50 drafts.");
    return sendDrafts(session, v.data.ids);
  }, "viewer");
  r.post("/review/corporate/:id/dismiss", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = version.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    return { draft: await dismissDraft(session, params.id, v.data.version) };
  }, "viewer");
  r.post("/review/corporate/refresh", async ({ session }) => refreshDrafts(session), "viewer");
}
