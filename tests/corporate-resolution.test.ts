// Corporate Gifts routing, Resolve from either app, check-off items and the weekly report's Corporate Gifts →
// Completed list. Synthetic data only (example.test hosts, Demo Market names, fictional people).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, q, app, closePool } from "./helpers";
import { issueSession } from "../server/auth";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { syncCorporateTasks, syncCheckoffs, _resetCorporateSyncState } from "../server/corporateTasks";

const OWNER = "planner2@example.test";
const SB_BRAND = "aaaaaaaa-1111-4111-8111-111111111111", STAFF = "bbbbbbbb-1111-4111-8111-111111111111";
const CG = "https://gifts2.example.test";
const KEY = "r".repeat(40), PKEY = "p".repeat(40);

// ------------------------------------------------------------ fake Corporate Gifts
type Item = { id: string; title: string; owner_hint: string | null; due_date: string | null; route: "marketing" | "checkoff" | "review"; delivery_status: string; content_version: number;
  delivered_version: number | null; tracker_task_id: string | null; tracker_status: string | null; resolution: null | { state: "requested" | "resolved"; completed_on: string | null; source: "manual" | "slack" | null; by: string | null };
  version: number; updated_at: string; evidence: number };
const cg = { items: new Map<string, Item>(), receipts: [] as any[], actions: [] as any[], failIds: new Set<string>(), feedPages: 0,
  loseClaim: new Set<string>(), down: 0, feedOverride: [] as any[],   // a claim applied whose answer is lost; calls answered 503; canned (older) feed responses
  reset() { this.items.clear(); this.receipts = []; this.actions = []; this.failIds.clear(); this.feedPages = 0; this.loseClaim.clear(); this.down = 0; this.feedOverride = []; } };
let tick = Date.parse("2026-11-18T00:00:00Z");
const stamp = () => new Date(tick += 60_000).toISOString();
const touch = (i: Item) => { i.version++; i.content_version++; i.updated_at = stamp(); };
const partners = [{ name: "Demo Market Echo", url: `${CG}/?tab=marketplaces&m=eeeeeeee-0000-4000-8000-000000000001` }];
function cgResolve(i: Item, by: string, on: string | null, source: "manual" | "slack" = "manual") {
  if (i.resolution?.state === "resolved") { i.evidence++; return "already_resolved"; }
  if (i.route === "marketing" && ["delivered", "sending"].includes(i.delivery_status) && i.tracker_status !== "done") {
    if (i.resolution?.state === "requested") return "already_requested";
    i.resolution = { state: "requested", completed_on: on ?? "2026-11-18", source, by }; touch(i); return "requested";
  }
  // Handled without a task: the shared "resolved" status (a delivered task keeps "delivered" and is done in Task Tracker).
  i.resolution = { state: "resolved", completed_on: on ?? "2026-11-18", source, by }; if (i.delivery_status !== "delivered") i.delivery_status = "resolved"; i.evidence++; touch(i); return "resolved";
}
const taskOut = (i: Item) => ({ id: i.id, title: i.title, brief: null, owner_hint: i.owner_hint, due_date: i.due_date, slack_status: "open", content_version: i.content_version,
  delivery_status: i.delivery_status, delivered_version: i.delivered_version, tracker_task_id: i.tracker_task_id, updated_at: i.updated_at, partners, route: i.route,
  resolution: i.resolution });
const checkOut = (i: Item) => ({ id: i.id, title: i.title, route: i.route, route_reason: i.route === "review" ? "No owner named" : "Outside Marketing", owner: i.owner_hint, owner_team: i.route === "checkoff" ? "outside" : null,
  due_date: i.due_date, state: i.resolution?.state === "resolved" ? "done" : "open", completed_on: i.resolution?.state === "resolved" ? i.resolution.completed_on : null,
  completion_source: i.resolution?.source ?? null, resolved_by: i.resolution?.by ?? null, resolved_at: null, evidence_count: i.evidence, version: i.version, updated_at: i.updated_at, partners,
  listed: i.route !== "marketing" || i.delivery_status === "resolved" });

// ------------------------------------------------------------ fake Task Tracker
type T = { key: string; task_id: string; status: string; version: number; completed_on: string | null; title: string; due_date: string; assignee: string };
const tracker = { tasks: new Map<string, T>(), completes: 0, failComplete: 0, reset() { this.tasks.clear(); this.completes = 0; this.failComplete = 0; } };
let n = 0;
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const out = (t: T) => ({ idempotency_key: t.key, plan_id: t.key.slice(4), task_id: t.task_id, title: t.title, due_date: t.due_date, status: t.status, completed_on: t.completed_on, recurring: false,
  brand: { id: SB_BRAND, name: "Succulents Box" }, assignee: { id: t.assignee, name: "Demo Staff" }, version: t.version, updated_at: new Date().toISOString(), open_url: `https://tracker2.example.test/#/tasks/${t.task_id}` });

async function fakeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  if (u.origin === CG) {
    if (init?.headers?.authorization !== `Bearer ${KEY}`) return res(401, {});
    if (u.pathname === "/api/reporting/v1/corporate-tasks") {
      const tasks = [...cg.items.values()].filter((i) => (i.route === "marketing" && !i.resolution && ["pending", "in_review", "failed"].includes(i.delivery_status)) || i.resolution?.state === "requested" || u.searchParams.has("since"));
      return res(200, { ok: true, schema_version: 1, as_of: new Date().toISOString(), tasks: tasks.map(taskOut), capabilities: ["resolved", "routing"] });
    }
    if (u.pathname === "/api/reporting/v1/corporate-checkoffs") {
      // Change feed: every item after the cursor, ordered by (updated_at, id), 200 per page.
      const after = u.searchParams.get("after"), afterId = u.searchParams.get("after_id") ?? "";
      const at = after ? new Date(after).toISOString() : "";
      const all = [...cg.items.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
        .filter((i) => !after || i.updated_at > at || (i.updated_at === at && i.id > afterId));
      const page = all.slice(0, 200);
      cg.feedPages++;
      if (cg.feedOverride.length) return res(200, cg.feedOverride.shift());
      return res(200, { ok: true, schema_version: 2, has_more: all.length > 200, next: page.length ? { after: page.at(-1)!.updated_at, after_id: page.at(-1)!.id } : null, items: page.map(checkOut) });
    }
    if (u.pathname === "/api/reporting/v1/corporate-task-receipts") {
      const b = JSON.parse(init.body);
      cg.receipts.push(...b.receipts);
      for (const r of b.receipts) {
        const i = cg.items.get(r.id); if (!i) continue;
        if (r.state === "delivered") {
          i.delivery_status = "delivered"; i.tracker_task_id = r.tracker.task_id; i.tracker_status = r.tracker.status; i.delivered_version = r.content_version;
          if (r.tracker.status === "done" && i.resolution?.state !== "resolved") { i.resolution = { state: "resolved", completed_on: i.resolution?.completed_on ?? r.tracker.completed_on, source: i.resolution?.source ?? "manual", by: i.resolution?.by ?? "Task Tracker" }; touch(i); }
        } else if (r.state === "resolved") cgResolve(i, r.resolved_by, r.completed_on);
        else if (i.delivery_status === "sending" && r.state !== "failed") continue;   // a claimed row settles only on delivered or failed
        else if (!["delivered", "dismissed", "resolved"].includes(i.delivery_status)) i.delivery_status = r.state;
      }
      return res(200, { ok: true });
    }
    if (u.pathname === "/api/reporting/v1/corporate-task-actions") {
      if (cg.down > 0) { cg.down--; return res(503, {}); }
      const b = JSON.parse(init.body);
      cg.actions.push(...b.actions);
      let lost = false;
      const results = b.actions.map((a: any) => {
        const i = cg.items.get(a.id);
        if (!i || cg.failIds.has(a.id)) return { id: a.id, outcome: "failed", message: "Simulated failure" };
        if (a.action === "route") { i.route = a.route; touch(i); return { id: a.id, outcome: "routed" }; }
        if (a.action === "claim") {
          if (["delivered", "sending"].includes(i.delivery_status)) return { id: a.id, outcome: "claimed" };
          if (i.resolution) return { id: a.id, outcome: "resolved", message: "Resolved in Corporate Gifts; it is not sent." };
          if (i.route !== "marketing") return { id: a.id, outcome: "rerouted", message: "Now a check-off item in Corporate Gifts; it is not sent." };
          if (i.content_version !== a.content_version) return { id: a.id, outcome: "stale", message: "Changed in Corporate Gifts since the last refresh." };
          i.delivery_status = "sending"; i.updated_at = stamp();
          if (cg.loseClaim.delete(a.id)) { lost = true; cg.down = 2; }   // committed, but the answer (and the next two calls) is lost
          return { id: a.id, outcome: "claimed" };
        }
        if (a.action === "release") {
          if (i.delivery_status === "delivered") return { id: a.id, outcome: "delivered" };
          if (i.delivery_status !== "sending") return { id: a.id, outcome: "not_claimed" };
          if (i.resolution?.state === "requested") { i.resolution = { ...i.resolution, state: "resolved" }; i.delivery_status = "resolved"; touch(i); return { id: a.id, outcome: "resolved" }; }
          i.delivery_status = "in_review";
          i.updated_at = stamp(); return { id: a.id, outcome: "released" };
        }
        const o = cgResolve(i, a.by, a.completed_on);
        return { id: a.id, outcome: o, state: i.resolution?.state ?? null, completed_on: i.resolution?.completed_on ?? null };
      });
      return lost ? res(503, {}) : res(200, { ok: true, results });
    }
    return res(404, {});
  }
  if (init?.headers?.["x-tracker-planning-key"] !== PKEY) return res(401, {});
  if (u.pathname === "/api/planning/v1/directory") return res(200, { brands: [{ id: SB_BRAND, name: "Succulents Box", business_id: "sb" }], people: [{ id: STAFF, name: "Demo Staff", brand_ids: [SB_BRAND] }] });
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "GET")
    return res(200, { items: (u.searchParams.get("keys") ?? "").split(",").map((k) => tracker.tasks.get(k)).filter(Boolean).map((t) => out(t!)) });
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "POST") {
    const b = JSON.parse(init.body);
    const ex = tracker.tasks.get(b.idempotency_key);
    if (ex) return res(200, { created: false, task: out(ex) });
    const t: T = { key: b.idempotency_key, task_id: `cccccccc-0000-4000-8000-${String(++n).padStart(12, "0")}`, status: "open", version: 1, completed_on: null, title: b.title, due_date: b.due_date, assignee: b.assignee_id };
    tracker.tasks.set(t.key, t);
    return res(201, { created: true, task: out(t) });
  }
  const done = /^\/api\/planning\/v1\/tasks\/([^/]+)\/complete$/.exec(u.pathname);
  if (done && init.method === "POST") {
    if (tracker.failComplete > 0) { tracker.failComplete--; return res(503, { error: { code: "unavailable", message: "Down" } }); }
    const t = tracker.tasks.get(decodeURIComponent(done[1]));
    if (!t) return res(404, {});
    if (t.status !== "done") { t.status = "done"; t.completed_on = "2026-11-18"; t.version++; tracker.completes++; }
    return res(200, { task: out(t) });
  }
  return res(404, {});
}

// ------------------------------------------------------------ helpers
const cookies: Record<string, string> = {};
const EDITOR = "report-editor@example.test";
async function req(method: string, path: string, body?: unknown, email = OWNER) {
  const h: Record<string, string> = { cookie: `mkd_session=${(cookies[email] ??= await issueSession({ sub: `sub-${email}`, email }))}` };
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await app(new Request(`http://localhost/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
let idN = 0;
const add = (over: Partial<Item> = {}): Item => {
  const i: Item = { id: `dddddddd-1111-4000-8000-${String(++idN).padStart(12, "0")}`, title: `Fictional action ${idN}`, owner_hint: "Example Marketer", due_date: "2026-12-04", route: "marketing",
    delivery_status: "pending", content_version: 1, delivered_version: null, tracker_task_id: null, tracker_status: null, resolution: null, version: 1, updated_at: stamp(), evidence: 0, ...over };
  cg.items.set(i.id, i);
  return i;
};
const drafts = async () => (await req("GET", "/review/corporate?status=all")).body.items as any[];
const checks = async (status = "all") => (await req("GET", `/review/corporate-checkoffs?status=${status}`)).body.items as any[];

beforeAll(async () => {
  await freshDb();
  process.env.TEAM_MEMBERS += `,${OWNER}:viewer,${EDITOR}:editor`;
  process.env.TASK_TRACKER_API_URL = "https://tracker2.example.test";
  process.env.TASK_TRACKER_PLANNING_SECRET = PKEY;
  process.env.CORPORATE_GIFTING_API_URL = CG;
  process.env.CORPORATE_GIFTING_REPORTING_SECRET = KEY;
  process.env.CORPORATE_TASK_DEFAULT_ASSIGNEE = "Demo";
  _setReportingFetchForTests(fakeFetch as any);
});
afterAll(async () => {
  _setReportingFetchForTests(null);
  for (const k of ["PLANNING_OWNER_EMAIL", "TASK_TRACKER_API_URL", "TASK_TRACKER_PLANNING_SECRET", "CORPORATE_GIFTING_API_URL", "CORPORATE_GIFTING_REPORTING_SECRET", "CORPORATE_TASK_DEFAULT_ASSIGNEE"]) delete process.env[k];
  await closePool();
});
beforeEach(async () => { process.env.PLANNING_OWNER_EMAIL = OWNER; _resetCorporateSyncState(); cg.reset(); tracker.reset(); await q("delete from corporate_task_drafts"); await q("delete from corporate_checkoffs"); await q("delete from corporate_feed_cursors"); });

describe("routing", () => {
  it("an outside-Marketing action is one check-off item in this view and creates no Task Tracker task", async () => {
    const ops = add({ route: "checkoff", owner_hint: "Example Ops Lead" });
    const mk = add();
    await syncCorporateTasks();
    expect((await drafts()).map((d) => d.id)).toEqual([mk.id]);
    expect((await checks()).map((c) => c.id)).toEqual([ops.id]);
    await syncCorporateTasks();
    expect(await q("select count(*)::int n from corporate_checkoffs where listed")).toEqual([{ n: 1 }]);
    expect(tracker.tasks.size).toBe(0);
    expect(cg.receipts.some((r) => r.id === ops.id)).toBe(false);
  });

  it("a draft routed away in Corporate Gifts leaves the queue and can come back; a routing decision is applied there", async () => {
    const a = add();
    await syncCorporateTasks();
    a.route = "checkoff"; touch(a);
    await syncCorporateTasks();
    expect((await drafts()).find((d) => d.id === a.id)).toBeUndefined();
    expect((await req("POST", "/review/corporate/send", { ids: [a.id] })).body.results[0].outcome).toBe("skipped");
    const r = add({ route: "review", owner_hint: null });
    await syncCorporateTasks();
    const item = (await checks()).find((c) => c.id === r.id);
    expect(item.route).toBe("review");
    expect((await req("POST", `/review/corporate-checkoffs/${r.id}/route`, { route: "marketing", version: item.version })).status).toBe(200);
    expect(cg.actions.at(-1)).toMatchObject({ id: r.id, action: "route", route: "marketing", by: OWNER });
    expect((await drafts()).find((d) => d.id === r.id)?.status).toBe("pending");
  });
});

describe("Resolve", () => {
  it("resolving a draft closes it here and in Corporate Gifts, and it can no longer be sent", async () => {
    const a = add();
    await syncCorporateTasks();
    const r = await req("POST", `/review/corporate/${a.id}/resolve`, { completed_on: "2026-11-17" });
    expect(r.body).toMatchObject({ outcome: "resolved", draft: { status: "resolved", resolution: { state: "resolved", completed_on: "2026-11-17" } } });
    expect(cg.items.get(a.id)!.resolution).toMatchObject({ state: "resolved", completed_on: "2026-11-17", by: OWNER });
    expect((await req("POST", "/review/corporate/send", { ids: [a.id] })).body.results[0]).toMatchObject({ outcome: "skipped" });
    expect(tracker.tasks.size).toBe(0);
    expect((await req("POST", `/review/corporate/${a.id}/resolve`, {})).body.outcome).toBe("already");
    expect((await req("POST", `/review/corporate/${a.id}/resolve`, { completed_on: "2099-01-01" })).status).toBe(400);
  });

  it("a draft resolved in Corporate Gifts is closed here on the next sync", async () => {
    const a = add();
    await syncCorporateTasks();
    cgResolve(a, "Example Reviewer", "2026-11-16");
    await syncCorporateTasks();
    expect((await drafts()).find((d) => d.id === a.id)).toMatchObject({ status: "resolved", resolution: { state: "resolved", by: "Example Reviewer" } });
    expect((await req("POST", "/review/corporate/send", { ids: [a.id] })).body.results[0].outcome).toBe("skipped");
  });

  it("a sent task is completed through Task Tracker, from either app, exactly once; a failure is shown and can be retried", async () => {
    const a = add(), b = add();
    await syncCorporateTasks();
    await req("POST", "/review/corporate/bulk-assign", { ids: [a.id, b.id], due_date: "2026-12-05" });
    expect((await req("POST", "/review/corporate/send", { ids: [a.id, b.id] })).body.results.map((x: any) => x.outcome)).toEqual(["created", "created"]);
    // From the dashboard.
    const r = await req("POST", `/review/corporate/${a.id}/resolve`, {});
    expect(r.body.outcome).toBe("complete");
    expect(r.body.draft.resolution).toMatchObject({ state: "resolved" });
    expect(tracker.tasks.get(`mkp:${a.id}`)!.status).toBe("done");
    expect(cg.items.get(a.id)!.resolution).toMatchObject({ state: "resolved" });
    expect((await req("POST", `/review/corporate/${a.id}/resolve`, {})).body.outcome).toBe("already");
    // From Corporate Gifts, with Task Tracker down the first time.
    cgResolve(b, "Example Reviewer", "2026-11-15");
    tracker.failComplete = 1;
    await syncCorporateTasks();
    const pending = (await drafts()).find((d) => d.id === b.id);
    expect(pending.resolution).toMatchObject({ state: "requested" });
    expect(pending.resolution.error).toMatch(/retried/);
    await syncCorporateTasks();
    expect((await drafts()).find((d) => d.id === b.id).resolution).toMatchObject({ state: "resolved", completed_on: "2026-11-15" });
    expect(cg.items.get(b.id)!.resolution).toMatchObject({ state: "resolved", completed_on: "2026-11-15" });
    await syncCorporateTasks();
    expect(tracker.completes).toBe(2);
  });
});

describe("check-off items", () => {
  it("bulk Mark done reports failures, which stay retryable without a second completion", async () => {
    const x = add({ route: "checkoff" }), y = add({ route: "checkoff" });
    await syncCorporateTasks();
    cg.failIds.add(y.id);
    const r1 = await req("POST", "/review/corporate-checkoffs/mark-done", { ids: [x.id, y.id] });
    expect(r1.body.results.map((r: any) => r.outcome)).toEqual(["resolved", "failed"]);
    cg.failIds.clear();
    const r2 = await req("POST", "/review/corporate-checkoffs/mark-done", { ids: [x.id, y.id] });
    expect(r2.body.results.map((r: any) => r.outcome)).toEqual(["already_resolved", "resolved"]);
    expect((await checks("done")).map((c) => c.id).sort()).toEqual([x.id, y.id].sort());
    const review = add({ route: "review" });
    await syncCorporateTasks();
    expect((await req("POST", "/review/corporate-checkoffs/mark-done", { ids: [review.id] })).body.results[0]).toMatchObject({ outcome: "failed", message: "Choose a route first." });
  });

  it("the weekly report lists each completed check-off item once, in its completion week only", async () => {
    const x = add({ route: "checkoff", title: "Fictional partner upload" });
    const y = add({ route: "checkoff", title: "Fictional next-week item" });
    const mk = add({ title: "Fictional Marketing task" });
    await syncCorporateTasks();
    await req("POST", "/review/corporate-checkoffs/mark-done", { ids: [x.id], completed_on: "2026-11-10" });
    cgResolve(x, "Slack workflow (Slack)", "2026-11-11", "slack");          // later Slack confirmation: evidence only
    cgResolve(y, "Example Reviewer", "2026-11-16");
    await req("POST", `/review/corporate/${mk.id}/resolve`, { completed_on: "2026-11-12" });
    await syncCorporateTasks();
    const create = await req("POST", "/reports", { kind: "weekly", business_id: "sb", period_start: "2026-11-08", period_end: "2026-11-14" }, EDITOR);
    expect(create.status).toBe(200);
    const rep = (await req("GET", `/reports/${create.body.id}`, undefined, EDITOR)).body.revision.content.corporate_gifts.completed;
    expect(rep.map((r: any) => [r.title, r.completed_on])).toEqual([["Fictional partner upload", "2026-11-10"], ["Fictional Marketing task", "2026-11-12"]]);
    expect(rep.find((r: any) => r.title === "Fictional Marketing task").kind).toBe("Resolved before sending");
    // A rerun (correction revision) keeps one entry per item.
    await req("POST", `/reports/${create.body.id}/publish`, undefined, EDITOR);
    await req("POST", `/reports/${create.body.id}/revisions`, { note: "Rerun for the test" }, EDITOR);
    const again = (await req("GET", `/reports/${create.body.id}?revision=2`, undefined, EDITOR)).body.revision.content.corporate_gifts.completed;
    expect(again.filter((r: any) => r.title === "Fictional partner upload")).toHaveLength(1);
    const p2s = await req("POST", "/reports", { kind: "weekly", business_id: "p2s", period_start: "2026-11-08", period_end: "2026-11-14" }, EDITOR);
    expect((await req("GET", `/reports/${p2s.body.id}`, undefined, EDITOR)).body.revision.content.corporate_gifts).toBeNull();
  });
});

describe("stale drafts and route changes", () => {
  it("a task resolved or rerouted in Corporate Gifts after the last refresh is not sent from an open tab", async () => {
    const res = add(), moved = add(), changed = add(), ok = add();
    await syncCorporateTasks();
    await req("POST", "/review/corporate/bulk-assign", { ids: [res.id, moved.id, changed.id, ok.id], due_date: "2026-12-05" });
    // Changes in Corporate Gifts that this dashboard hasn't read yet (no sync in between).
    cgResolve(res, "Example Reviewer", "2026-11-17");
    moved.route = "checkoff"; touch(moved);
    changed.title = "Fictional action (new wording)"; touch(changed);
    const before = cg.receipts.length;
    const r = await req("POST", "/review/corporate/send", { ids: [res.id, moved.id, changed.id, ok.id] });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(["skipped", "skipped", "skipped", "created"]);
    expect(r.body.results[0].message).toMatch(/Resolved in Corporate Gifts/);
    expect([...tracker.tasks.keys()]).toEqual([`mkp:${ok.id}`]);
    const after = Object.fromEntries((await drafts()).map((d) => [d.id, d]));
    expect(after[res.id].status).toBe("resolved");
    expect(after[moved.id]).toBeUndefined();
    // Re-read from Corporate Gifts (the draft keeps the reviewer's edits; the source shows the new wording).
    expect(after[changed.id]).toMatchObject({ status: "pending", source: { title: "Fictional action (new wording)" } });
    expect(cg.receipts.slice(before).some((x) => [res.id, moved.id].includes(x.id))).toBe(false);   // nothing reported for refused sends
    expect((await req("POST", "/review/corporate/send", { ids: [changed.id] })).body.results[0].outcome).toBe("created");
  });

  it("an item routed from the checklist to Marketing leaves the checklist, becomes one draft and stays out of the report", async () => {
    const x = add({ route: "checkoff", title: "Fictional rerouted item" });
    await syncCorporateTasks();
    expect((await checks()).map((c) => c.id)).toEqual([x.id]);
    x.route = "marketing"; touch(x);
    await syncCorporateTasks();
    await syncCorporateTasks();
    expect(await checks()).toEqual([]);
    expect((await drafts()).filter((d) => d.id === x.id)).toHaveLength(1);
    await req("POST", "/review/corporate/bulk-assign", { ids: [x.id], due_date: "2026-12-05" });
    expect((await req("POST", "/review/corporate/send", { ids: [x.id] })).body.results[0].outcome).toBe("created");
    await syncCorporateTasks();
    expect(await checks("all")).toEqual([]);
    const create = await req("POST", "/reports", { kind: "weekly", business_id: "sb", period_start: "2026-11-14", period_end: "2026-11-20" }, EDITOR);
    expect((await req("GET", `/reports/${create.body.id}`, undefined, EDITOR)).body.revision.content.corporate_gifts.completed).toEqual([]);
  });

  it("follows the feed across pages and from its stored cursor", async () => {
    for (let i = 0; i < 450; i++) add({ route: "checkoff", title: `Fictional bulk item ${i}` });
    await syncCorporateTasks();
    expect(await q("select count(*)::int n from corporate_checkoffs")).toEqual([{ n: 450 }]);
    expect(cg.feedPages).toBe(3);
    const first = [...cg.items.values()][0];
    first.route = "marketing"; touch(first);
    const late = add({ route: "checkoff", title: "Fictional late item" });
    cg.feedPages = 0;
    await syncCorporateTasks();
    expect(cg.feedPages).toBe(1);
    expect(await q("select count(*)::int n from corporate_checkoffs where listed")).toEqual([{ n: 450 }]);
    expect(await q("select id from corporate_checkoffs where listed and id = $1", [late.id])).toHaveLength(1);
    expect(await q("select id from corporate_checkoffs where listed and id = $1", [first.id])).toHaveLength(0);
  });

  it("an older feed response arriving after a newer one neither removes nor brings back a checklist row", async () => {
    const x = add({ route: "checkoff", title: "Fictional overlap item" });
    await syncCorporateTasks();
    const page = (items: any[]) => ({ ok: true, schema_version: 2, has_more: false, next: null, items });
    // Refresh A reads the item while it is routed to Marketing (unlisted); it is then routed back to the checklist and
    // refresh B reads that (listed) first. A's answer arrives last.
    x.route = "marketing"; touch(x);
    const olderUnlisted = checkOut(x);
    x.route = "checkoff"; touch(x);
    await syncCheckoffs(true);
    cg.feedOverride.push(page([olderUnlisted]));
    await syncCheckoffs(true);
    expect((await checks()).map((c) => c.id)).toEqual([x.id]);
    // And the other way round: a newer unlisted state is not undone by an older listed response.
    const olderListed = checkOut(x);
    x.route = "marketing"; touch(x);
    await syncCheckoffs(true);
    expect(await checks()).toEqual([]);
    cg.feedOverride.push(page([olderListed]));
    await syncCheckoffs(true);
    expect(await checks()).toEqual([]);
    expect((await req("POST", "/review/corporate-checkoffs/mark-done", { ids: [x.id] })).body.results[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("a claim whose answer is lost", () => {
  it("is released in Corporate Gifts, so a later Resolve closes it there and here without a Task Tracker task", async () => {
    const a = add();
    await syncCorporateTasks();
    await req("POST", "/review/corporate/bulk-assign", { ids: [a.id], due_date: "2026-12-05" });
    cg.loseClaim.add(a.id);
    const r = await req("POST", "/review/corporate/send", { ids: [a.id] });
    expect(r.body.results[0]).toMatchObject({ outcome: "failed", message: expect.stringMatching(/didn't answer/) });
    expect(tracker.tasks.size).toBe(0);
    expect(a.delivery_status).toBe("sending");   // the claim was applied there; the release couldn't reach it yet
    expect((await drafts()).find((d) => d.id === a.id)).toMatchObject({ status: "pending", delivery: { status: "not_sent" } });
    // Resolve in Corporate Gifts: it waits for the send there.
    expect(cgResolve(a, "Example Reviewer", "2026-11-17")).toBe("requested");
    await syncCorporateTasks();
    expect(a).toMatchObject({ delivery_status: "resolved", resolution: { state: "resolved", completed_on: "2026-11-17" } });
    expect((await drafts()).find((d) => d.id === a.id)).toMatchObject({ status: "resolved" });
    expect(await q("select claim_release_due from corporate_task_drafts where id = $1", [a.id])).toEqual([{ claim_release_due: false }]);
    expect((await req("POST", "/review/corporate/send", { ids: [a.id] })).body.results[0]).toMatchObject({ outcome: "skipped" });
    expect(tracker.tasks.size).toBe(0);
    expect(cg.actions.filter((x) => x.id === a.id && x.action === "claim")).toHaveLength(1);
  });

  it("a retry releases the earlier claim first and then sends exactly one task", async () => {
    const b = add();
    await syncCorporateTasks();
    await req("POST", "/review/corporate/bulk-assign", { ids: [b.id], due_date: "2026-12-05" });
    cg.loseClaim.add(b.id);
    expect((await req("POST", "/review/corporate/send", { ids: [b.id] })).body.results[0].outcome).toBe("failed");
    const r = await req("POST", "/review/corporate/send", { ids: [b.id] });
    expect(r.body.results[0]).toMatchObject({ outcome: "created" });
    expect([...tracker.tasks.keys()]).toEqual([`mkp:${b.id}`]);
    expect(cg.actions.filter((x) => x.id === b.id).map((x) => x.action)).toEqual(["claim", "release", "claim"]);
    expect(b.delivery_status).toBe("delivered");
  });

  it("a confirmed refusal is not released", async () => {
    const c = add();
    await syncCorporateTasks();
    await req("POST", "/review/corporate/bulk-assign", { ids: [c.id], due_date: "2026-12-05" });
    c.title = "Fictional new wording"; touch(c);
    expect((await req("POST", "/review/corporate/send", { ids: [c.id] })).body.results[0].outcome).toBe("skipped");
    expect(cg.actions.filter((x) => x.id === c.id).map((x) => x.action)).toEqual(["claim"]);
    expect(await q("select claim_release_due from corporate_task_drafts where id = $1", [c.id])).toEqual([{ claim_release_due: false }]);
  });
});

describe("upgrade from the schema before 016 (015's shared resolved status, with data)", () => {
  it("keeps resolved drafts resolved, reports each completion once, and handles lost claims and overlapping refreshes on upgraded data", async () => {
    // 1. The database as it is before 016, with drafts in the states 015 allows.
    const pool = (await import("../server/db")).getPool();
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await pool.query("drop schema public cascade; create schema public;");
    await pool.query("create table schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const dir = join(import.meta.dirname, "..", "db", "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && x < "016").sort()) {
      await pool.query(readFileSync(join(dir, f), "utf8"));
      await pool.query("insert into schema_migrations (name) values ($1)", [f]);
    }
    const resolvedHere = add({ title: "Fictional resolved in the dashboard", delivery_status: "resolved", resolution: { state: "resolved", completed_on: "2026-11-15", source: "manual", by: "Marketing Dashboard" } });
    const resolvedCg = add({ title: "Fictional resolved in Corporate Gifts", delivery_status: "resolved", resolution: { state: "resolved", completed_on: "2026-11-16", source: "manual", by: "Example Reviewer" } });
    const open = add({ title: "Fictional open draft" });
    const sent = add({ title: "Fictional sent task", delivery_status: "delivered", tracker_task_id: "cccccccc-0000-4000-8000-000000000999", tracker_status: "open", delivered_version: 1 });
    const check = add({ route: "checkoff", title: "Fictional check-off done", resolution: { state: "resolved", completed_on: "2026-11-17", source: "slack", by: "Example Ops Lead" } });
    check.delivery_status = "resolved";
    const ins = (i: Item, extra: string) => pool.query(
      `insert into corporate_task_drafts (id, cg_title, cg_delivery_status, cg_content_version, title, tracker_brand_id, tracker_brand_name, tracker_assignee_id, tracker_assignee_name, due_date, partners)
       values ($1, $2, $3, 1, $2, $4, 'Succulents Box', $5, 'Demo Staff', '2026-12-04', $6)`, [i.id, i.title, i.delivery_status, SB_BRAND, STAFF, JSON.stringify(partners)]).then(() => extra && pool.query(extra, [i.id]));
    await ins(resolvedHere, "update corporate_task_drafts set status = 'resolved', resolved_in = 'dashboard', reviewed_at = '2026-11-15T02:00:00Z', receipt_due = false, receipt_state = 'resolved' where id = $1");
    await ins(resolvedCg, "update corporate_task_drafts set status = 'resolved', resolved_in = 'corporate_gifts', reviewed_at = '2026-11-16T01:00:00Z', receipt_due = false, receipt_state = 'resolved' where id = $1");
    await ins(open, "");
    tracker.tasks.set(`mkp:${sent.id}`, { key: `mkp:${sent.id}`, task_id: sent.tracker_task_id!, status: "open", version: 1, completed_on: null, title: sent.title, due_date: "2026-12-04", assignee: STAFF });
    await ins(sent, `update corporate_task_drafts set status = 'approved', delivery_status = 'created', tracker_task_id = '${sent.tracker_task_id}', tracker_status = 'open', tracker_version = 1,
                       synced_content_version = 1, receipt_due = false, receipt_state = 'delivered' where id = $1`);
    // 2. Apply 016 to it.
    const { migrate } = await import("../scripts/migrate");
    await migrate(() => {});
    _resetCorporateSyncState();
    const rows = Object.fromEntries((await q("select id, status, resolved_in, to_char(completed_on, 'YYYY-MM-DD') d, route from corporate_task_drafts")).map((r) => [r.id, r]));
    expect(rows[resolvedHere.id]).toMatchObject({ status: "resolved", resolved_in: "dashboard", d: "2026-11-15", route: "marketing" });
    expect(rows[resolvedCg.id]).toMatchObject({ status: "resolved", resolved_in: "corporate_gifts", d: "2026-11-16" });
    expect(rows[open.id]).toMatchObject({ status: "pending", resolved_in: null, d: null });
    let list = Object.fromEntries((await drafts()).map((d) => [d.id, d]));
    expect(list[resolvedHere.id].resolution).toMatchObject({ state: "resolved", completed_on: "2026-11-15" });
    expect((await req("GET", "/review/corporate?status=pending")).body.items.map((d: any) => d.id)).toEqual([open.id]);

    // 3. Reads after the upgrade never reopen them, and send nothing back for a resolution made in Corporate Gifts.
    const before = cg.receipts.length;
    await syncCorporateTasks();
    await syncCorporateTasks();
    list = Object.fromEntries((await drafts()).map((d) => [d.id, d]));
    expect([list[resolvedHere.id].status, list[resolvedCg.id].status]).toEqual(["resolved", "resolved"]);
    expect(cg.receipts.slice(before).filter((r) => [resolvedHere.id, resolvedCg.id].includes(r.id))).toEqual([]);
    expect((await req("POST", "/review/corporate/send", { ids: [resolvedHere.id, resolvedCg.id] })).body.results.map((r: any) => r.outcome)).toEqual(["skipped", "skipped"]);

    // 4. The weekly report lists each completion once (from Corporate Gifts, on the same request ids), also after
    //    repeated reads and an older overlapping feed response.
    const completed = async () => (await (await import("../server/routes/reports")).corporateCompletedInPeriod("sb", "2026-11-14", "2026-11-20"))!.completed.map((x: any) => x.title).sort();
    const want = ["Fictional check-off done", "Fictional resolved in Corporate Gifts", "Fictional resolved in the dashboard"];
    expect(await completed()).toEqual(want);
    const olderOpen = checkOut({ ...check, resolution: null, delivery_status: "pending", updated_at: new Date(Date.parse(check.updated_at) - 60_000).toISOString() });
    cg.feedOverride.push({ ok: true, schema_version: 2, has_more: false, next: null, items: [olderOpen] });
    await syncCheckoffs(true);
    await syncCorporateTasks();
    expect(await completed()).toEqual(want);

    // 5. A lost claim answer on an upgraded draft, then Resolve in Corporate Gifts: released, resolved in both, no task.
    cg.loseClaim.add(open.id);
    expect((await req("POST", "/review/corporate/send", { ids: [open.id] })).body.results[0]).toMatchObject({ outcome: "failed" });
    expect(open.delivery_status).toBe("sending");
    expect(cgResolve(open, "Example Reviewer", "2026-11-18")).toBe("requested");
    await syncCorporateTasks();
    expect(open).toMatchObject({ delivery_status: "resolved", resolution: { state: "resolved" } });
    expect((await drafts()).find((d) => d.id === open.id)).toMatchObject({ status: "resolved", resolved_in: "corporate_gifts" });
    expect(tracker.tasks.has(`mkp:${open.id}`)).toBe(false);

    // 6. Resolve on the task sent before the upgrade completes it in Task Tracker, once.
    const s1 = (await drafts()).find((d) => d.id === sent.id);
    const r = await req("POST", `/review/corporate/${sent.id}/resolve`, { version: s1.version });
    expect(r.body).toMatchObject({ outcome: "complete", draft: { resolution: { state: "resolved" }, task: { status: "done" } } });
    expect(tracker.completes).toBe(1);
    expect(cg.receipts.filter((x) => x.id === sent.id).at(-1)).toMatchObject({ state: "delivered", tracker: { status: "done" } });
  });
});
