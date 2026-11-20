// Slack Review routes (planning owner only; every rule is in server/review.ts). Everyone else gets 404.
import type { Router } from "../router";
import { badRequest, readJson } from "../http";
import { z } from "zod";
import { assertReviewer, pendingCount, listSuggestions, getSuggestion, editSuggestion, editSchema, previewSuggestion, addToPlanSchema, addToPlan, planChoices, bulkAddSchema, bulkAddToPlan, bulkStatusSchema, bulkStatus, reopenSuggestion, returnToReview, createFromSuggestion, dismissSuggestion, refreshSuggestion, resolveSuggestion, classifySuggestion, classifySchema } from "../review";
import { pendingCorporateCount, listDrafts, editDraft, draftEditSchema, bulkAssign, bulkAssignSchema, sendDrafts, dismissDraft, refreshDrafts, getDraft, resolveDraft, resolveSchema, listCheckoffs, markCheckoffsDone, markDoneSchema, routeCheckoff, routeSchema, followUpCheckoffs, followUpSchema } from "../corporateTasks";

const version = z.object({ version: z.number().int().min(1) }).strict();

export function registerReview(r: Router) {
  r.get("/review/summary", async ({ session }) => ({ pending: await pendingCount(session) }));
  r.get("/review/suggestions", async ({ url, session }) => {
    assertReviewer(session);
    const status = url.searchParams.get("status") ?? "pending", q = url.searchParams.get("q"), occasion = url.searchParams.get("occasion") ?? "all";
    if (!["pending", "planned", "approved", "resolved", "dismissed", "all"].includes(status)) throw badRequest("Invalid status.");
    if (!["all", "unclassified", "classified"].includes(occasion)) throw badRequest("Invalid occasion filter.");
    if (q && q.length > 100) throw badRequest("Search is too long.");
    return { items: await listSuggestions(session, status, q, occasion as any) };
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
  r.post("/review/suggestions/:id/resolve", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = version.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    return { suggestion: await resolveSuggestion(session, params.id, v.data.version) };
  }, "viewer");
  r.post("/review/suggestions/:id/classify", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = classifySchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest(`${v.error.issues[0]?.path.join(".") || "occasion"}: ${v.error.issues[0]?.message ?? "invalid"}`);
    return { suggestion: await classifySuggestion(session, params.id, v.data) };
  }, "viewer");
  r.get("/review/suggestions/:id/plans", async ({ params, session }) => planChoices(session, params.id));
  r.get("/review/plan-choices", async ({ session }) => planChoices(session));
  const issue = (e: z.ZodError, what: string) => badRequest(`${e.issues[0]?.path.join(".") || what}: ${e.issues[0]?.message ?? "invalid"}`);
  r.post("/review/suggestions/:id/add-to-plan", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = addToPlanSchema.safeParse(await readJson(req));
    if (!v.success) throw issue(v.error, "plan");
    return addToPlan(session, params.id, v.data);
  }, "viewer");
  // Bulk actions on selected rows (each row keeps its own rules; refusals are reported per row).
  r.post("/review/suggestions/bulk-status", async ({ req, session }) => {
    assertReviewer(session);
    const v = bulkStatusSchema.safeParse(await readJson(req));
    if (!v.success) throw issue(v.error, "selection");
    return bulkStatus(session, v.data);
  }, "viewer");
  r.post("/review/suggestions/bulk-add-to-plan", async ({ req, session }) => {
    assertReviewer(session);
    const v = bulkAddSchema.safeParse(await readJson(req));
    if (!v.success) throw issue(v.error, "plan");
    return bulkAddToPlan(session, v.data);
  }, "viewer");
  r.post("/review/suggestions/:id/reopen", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = version.safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    return { suggestion: await reopenSuggestion(session, params.id, v.data.version) };
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
    if (!["pending", "approved", "resolved", "dismissed", "all"].includes(status)) throw badRequest("Invalid status.");
    return listDrafts(session, status);
  });
  r.get("/review/corporate/:id", async ({ params, session }) => ({ draft: await getDraft(session, params.id) }));
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
  r.post("/review/corporate/:id/resolve", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = resolveSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest(`${v.error.issues[0]?.path.join(".") || "body"}: ${v.error.issues[0]?.message ?? "invalid"}`);
    return resolveDraft(session, params.id, v.data);
  }, "viewer");
  // Check-off items and items waiting for routing (Corporate Gifts is the source; actions are applied there).
  r.get("/review/corporate-checkoffs", async ({ url, session }) => {
    const status = url.searchParams.get("status") ?? "open";
    if (!["open", "done", "all"].includes(status)) throw badRequest("Invalid status.");
    return listCheckoffs(session, status);
  });
  r.post("/review/corporate-checkoffs/mark-done", async ({ req, session }) => {
    assertReviewer(session);
    const v = markDoneSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest("Choose 1 to 100 items.");
    return markCheckoffsDone(session, v.data);
  }, "viewer");
  r.post("/review/corporate-checkoffs/follow-up", async ({ req, session }) => {
    assertReviewer(session);
    const v = followUpSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest("Choose 1 to 100 items.");
    return followUpCheckoffs(session, v.data);
  }, "viewer");
  r.post("/review/corporate-checkoffs/:id/route", async ({ req, params, session }) => {
    assertReviewer(session);
    const v = routeSchema.safeParse(await readJson(req));
    if (!v.success) throw badRequest("route and version are required.");
    return routeCheckoff(session, params.id, v.data);
  }, "viewer");
}
