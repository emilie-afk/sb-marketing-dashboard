// Marketing Planning routes. Every rule about who may see or change a plan lives in server/planning.ts.
import { z } from "zod";
import type { Router } from "../router";
import { badRequest, readJson } from "../http";
import { isIsoDate } from "../../shared/dates";
import { audit } from "../audit";
import {
  CHANNELS, PLAN_BUSINESSES, categoryOptions, isPlanningOwner, planningOwnerEmail, teamWindow, planningToday, listPlans, getPlan, createPlan, updatePlan, deletePlan,
  previewSend, publishAndSend, refreshFromTracker, updateDeadline, assertOwner,
} from "../planning";
import { trackerDirectory, planningTrackerConfigured } from "../adapters/planningClient";
import { planningTimeline } from "../planningTimeline";

const date = z.string().refine(isIsoDate, "must be a date");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const txt = (max: number) => z.string().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "control characters").nullable().optional();
const line = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "control characters");

const assignment = z.object({
  id: uuid.optional(), title: line(300), brief: txt(1500), tracker_brand_id: uuid, tracker_assignee_id: uuid, due_date: date,
}).strict();
const planSchema = z.object({
  business_id: z.enum(PLAN_BUSINESSES), name: line(200),
  gift_occasion_id: z.string().regex(/^[a-z0-9-]{2,60}$/).nullable().optional(), occurrence_year: z.number().int().min(2000).max(2100).nullable().optional(),
  sheet_occasion_id: uuid.nullable().optional(), promotion_id: uuid.nullable().optional(),
  prep_start: date, campaign_start: date, campaign_end: date,
  objective: txt(2000), channels: z.array(z.enum(CHANNELS)).max(12).optional(), categories: z.array(line(60)).max(10).optional(), target_audience: txt(500), message_angle: txt(500), deliverables: txt(2000), notes: txt(4000),
  assignments: z.array(assignment).max(40).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.prep_start > v.campaign_start) ctx.addIssue({ code: "custom", path: ["prep_start"], message: "Prep must start on or before the campaign starts." });
  if (v.campaign_start > v.campaign_end) ctx.addIssue({ code: "custom", path: ["campaign_end"], message: "The campaign must end on or after it starts." });
});
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ? `${r.error.issues[0].path.join(".") || "plan"}: ${r.error.issues[0].message}` : "Check the plan details.", r.error.issues.slice(0, 10).map((i) => ({ field: i.path.join("."), message: i.message })));
  return r.data;
}

export function registerPlanning(r: Router) {
  r.get("/planning/meta", async ({ session }) => {
    const owner = isPlanningOwner(session);
    return { owner, configured: !!planningOwnerEmail(), tracker_connected: owner ? planningTrackerConfigured() : undefined, channels: CHANNELS, today: planningToday(), window: teamWindow(),
      rule: owner ? "You see every plan, including drafts and ended plans." : "Published plans whose preparation starts within the next three months, and those in progress." };
  });

  r.get("/planning/plans", async ({ url, session }) => {
    const y = url.searchParams.get("year"), b = url.searchParams.get("business"), ch = url.searchParams.get("channel"), st = url.searchParams.get("status"), q = url.searchParams.get("q"), cat = url.searchParams.get("category");
    if (cat && cat.length > 60) throw badRequest("Invalid category.");
    if (y && !/^\d{4}$/.test(y)) throw badRequest("Invalid year.");
    if (b && !(PLAN_BUSINESSES as readonly string[]).includes(b)) throw badRequest("Invalid brand.");
    if (ch && !(CHANNELS as readonly string[]).includes(ch)) throw badRequest("Invalid channel.");
    if (st && !["draft", "published"].includes(st)) throw badRequest("Invalid status.");
    if (q && q.length > 100) throw badRequest("Search is too long.");
    return { items: await listPlans(session, { year: y ? Number(y) : null, business: b, channel: ch, category: cat, status: st, q }), owner: isPlanningOwner(session) };
  });

  r.get("/planning/categories", async ({ session }) => ({ items: await categoryOptions(session) }));
  r.get("/planning/timeline", async ({ url, session }) => {
    const b = url.searchParams.get("business"), cat = url.searchParams.get("category");
    if (b && !(PLAN_BUSINESSES as readonly string[]).includes(b)) throw badRequest("Invalid brand.");
    if (cat && cat.length > 60) throw badRequest("Invalid category.");
    return planningTimeline(session, { business: b, category: cat, seasonal: url.searchParams.get("seasonal") !== "0" });
  });

  r.get("/planning/plans/:id", async ({ params, session }) => ({ plan: await getPlan(session, params.id), owner: isPlanningOwner(session) }));

  // Writes: the router lets any signed-in member through; the owner check is in server/planning.ts.
  r.post("/planning/plans", async ({ req, session }) => {
    assertOwner(session);
    const plan = await createPlan(session, parse(planSchema, await readJson(req)));
    await audit(session.email, "plan.create", "marketing_plan", plan.id);
    return { plan };
  }, "viewer");

  r.patch("/planning/plans/:id", async ({ req, params, session }) => {
    assertOwner(session);
    const body = await readJson(req);
    const v = z.number().int().min(1).safeParse(body?.version);
    if (!v.success) throw badRequest("version is required.");
    const { version, ...rest } = body;
    const out = await updatePlan(session, params.id, v.data, parse(planSchema, rest));
    await audit(session.email, "plan.update", "marketing_plan", params.id);
    return out;
  }, "viewer");

  r.delete("/planning/plans/:id", async ({ params, session }) => {
    assertOwner(session);
    await deletePlan(session, params.id);
    await audit(session.email, "plan.delete", "marketing_plan", params.id);
    return { ok: true };
  }, "viewer");

  r.post("/planning/plans/:id/preview", async ({ params, session }) => previewSend(session, params.id), "viewer");

  r.post("/planning/plans/:id/publish", async ({ req, params, session }) => {
    assertOwner(session);
    const v = z.object({ version: z.number().int().min(1) }).strict().safeParse(await readJson(req));
    if (!v.success) throw badRequest("version is required.");
    const out = await publishAndSend(session, params.id, v.data.version);
    await audit(session.email, "plan.publish_send", "marketing_plan", params.id, { results: out.results.map((x: any) => ({ a: x.assignment_id, o: x.outcome })) });
    return out;
  }, "viewer");

  r.post("/planning/plans/:id/refresh", async ({ params, session }) => ({ plan: await refreshFromTracker(session, params.id) }), "viewer");

  r.post("/planning/plans/:id/assignments/:aid/deadline", async ({ req, params, session }) => {
    assertOwner(session);
    const v = z.object({ due_date: date }).strict().safeParse(await readJson(req));
    if (!v.success) throw badRequest("Choose a valid date.");
    const out = await updateDeadline(session, params.id, params.aid, v.data.due_date);
    await audit(session.email, "plan.deadline", "marketing_plan", params.id, { assignment: params.aid, outcome: out.outcome });
    return out;
  }, "viewer");

  r.get("/planning/directory", async ({ session }) => { assertOwner(session); return trackerDirectory(); });
}
