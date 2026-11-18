// Corporate Gifts tasks → the planning owner's queue → Task Tracker → Marketing Tasks. Synthetic data only
// (example.test hosts, Demo Market names).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, q, app, closePool } from "./helpers";
import { issueSession } from "../server/auth";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { syncCorporateTasks, _resetCorporateSyncState } from "../server/corporateTasks";

const OWNER = "planner@example.test";
const SB_BRAND = "aaaaaaaa-1111-4111-8111-111111111111", STAFF = "bbbbbbbb-1111-4111-8111-111111111111", LAN = "bbbbbbbb-3333-4333-8333-333333333333", OMAR = "bbbbbbbb-2222-4222-8222-222222222222";
const CG = "https://gifts.example.test";
const people: Record<string, { name: string; brands: string[] }> = { [STAFF]: { name: "Demo Staff", brands: [SB_BRAND] }, [LAN]: { name: "Lan", brands: [SB_BRAND] }, [OMAR]: { name: "Omar", brands: [] } };

// ------------------------------------------------------------ fake Corporate Gifts (tasks + receipts)
type CgT = { id: string; title: string; brief: string | null; owner_hint: string | null; due_date: string | null; slack_status: string; content_version: number;
  delivery_status: string; delivered_version: number | null; tracker_task_id: string | null; partners: { name: string; url: string }[] };
const cg = { tasks: new Map<string, CgT>(), receipts: [] as any[], failReceipts: 0, reset() { this.tasks.clear(); this.receipts = []; this.failReceipts = 0; } };
function applyReceipt(r: any) {
  const t = cg.tasks.get(r.id);
  if (!t) return;
  if (r.state === "delivered") { t.delivery_status = "delivered"; t.tracker_task_id = r.tracker.task_id; t.delivered_version = Math.max(t.delivered_version ?? 0, r.content_version); return; }
  if (["delivered", "dismissed"].includes(t.delivery_status)) return;
  if (r.state === "in_review" && t.delivery_status !== "pending") return;
  t.delivery_status = r.state;
}
// ------------------------------------------------------------ fake Task Tracker planning API
type T = { key: string; plan_id: string; origin: string; task_id: string; title: string; brief: string | null; due_date: string; status: string; version: number; updated_at: string; assignee: string; brand: string };
const tracker = { tasks: new Map<string, T>(), creates: 0, bodies: [] as any[], patches: 0, fences: new Map<string, number>(), reset() { this.tasks.clear(); this.creates = 0; this.bodies = []; this.patches = 0; this.fences.clear(); } };
let n = 0;
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const out = (t: T) => ({ idempotency_key: t.key, plan_id: t.plan_id, task_id: t.task_id, title: t.title, due_date: t.due_date, status: t.status, completed_on: null, recurring: false,
  brand: { id: t.brand, name: "Succulents Box" }, assignee: { id: t.assignee, name: people[t.assignee]?.name ?? "?" }, version: t.version, updated_at: t.updated_at, open_url: `https://tracker.example.test/#/tasks/${t.task_id}` });
async function fakeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  if (u.origin === CG) {
    if (init?.headers?.authorization !== `Bearer ${"r".repeat(40)}`) return res(401, { error: { code: "unauthorized" } });
    if (u.pathname === "/api/reporting/v1/corporate-tasks") {
      const tasks = [...cg.tasks.values()].filter((t) => ["pending", "in_review", "failed"].includes(t.delivery_status) || (t.delivery_status === "delivered" && t.content_version > (t.delivered_version ?? 0)) || u.searchParams.has("since"));
      return res(200, { ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:corporate-tasks", as_of: new Date().toISOString(), tasks: [...tasks, { id: "not-a-task" }] });
    }
    if (u.pathname === "/api/reporting/v1/corporate-task-receipts" && init.method === "POST") {
      if (cg.failReceipts > 0) { cg.failReceipts--; return res(503, { error: { code: "down" } }); }
      const b = JSON.parse(init.body);
      cg.receipts.push(...b.receipts);
      for (const r of b.receipts) applyReceipt(r);
      return res(200, { ok: true, applied: b.receipts.length });
    }
    return res(404, {});
  }
  if (init?.headers?.["x-tracker-planning-key"] !== "p".repeat(40)) return res(401, { error: { code: "unauthorized" } });
  if (u.pathname === "/api/planning/v1/directory") return res(200, { brands: [{ id: SB_BRAND, name: "Succulents Box", business_id: "sb" }], people: Object.entries(people).map(([id, p]) => ({ id, name: p.name, brand_ids: p.brands })) });
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "GET") {
    const keys = (u.searchParams.get("keys") ?? "").split(",");
    return res(200, { items: keys.map((k) => tracker.tasks.get(k)).filter(Boolean).map((t) => out(t!)) });
  }
  const due = /^\/api\/planning\/v1\/tasks\/([^/]+)\/due-date$/.exec(u.pathname);
  if (due && init.method === "PATCH") {
    const t = tracker.tasks.get(decodeURIComponent(due[1]));
    if (!t) return res(404, {});
    const b = JSON.parse(init.body);
    if (b.expected_version !== t.version) return res(409, { error: { code: "conflict", details: { task: out(t) } } });
    t.due_date = b.due_date; t.version++; t.updated_at = new Date().toISOString(); tracker.patches++;
    return res(200, { task: out(t) });
  }
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "POST") {
    const b = JSON.parse(init.body);
    tracker.bodies.push(b);
    const fence = tracker.fences.get(b.idempotency_key);
    if (fence !== undefined && Date.parse(b.sent_at) <= fence) return res(409, { error: { code: "stale_request" } });
    const existing = tracker.tasks.get(b.idempotency_key);
    if (existing) return res(200, { created: false, task: out(existing) });
    if (!people[b.assignee_id]?.brands.includes(b.brand_id)) {
      const through = Math.max(Date.parse(b.sent_at), b.supersedes_sent_at ? Date.parse(b.supersedes_sent_at) : 0);
      tracker.fences.set(b.idempotency_key, through);
      return res(422, { error: { code: "assignee_lacks_brand_access", message: "No access to that brand.", details: { task_exists: false, fenced_through: new Date(through).toISOString() } } });
    }
    const t: T = { key: b.idempotency_key, plan_id: b.plan_id, origin: b.origin ?? "plan", task_id: `cccccccc-0000-4000-8000-${String(++n).padStart(12, "0")}`, title: b.title, brief: b.brief, due_date: b.due_date, status: "open", version: 1, updated_at: new Date().toISOString(), assignee: b.assignee_id, brand: b.brand_id };
    tracker.tasks.set(t.key, t); tracker.creates++;
    return res(201, { created: true, task: out(t) });
  }
  return res(404, { error: { code: "not_found" } });
}

// ------------------------------------------------------------ helpers
const cookies: Record<string, string> = {};
async function req(email: string, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { cookie: `mkd_session=${(cookies[email] ??= await issueSession({ sub: `sub-${email}`, email }))}` };
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await app(new Request(`http://localhost/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
const owner = (m: string, p: string, b?: unknown) => req(OWNER, m, p, b);
let idN = 0;
const cgTask = (over: Partial<CgT> = {}): CgT => {
  const t: CgT = { id: `dddddddd-0000-4000-8000-${String(++idN).padStart(12, "0")}`, title: "Send Demo Market Echo the holiday catalog", brief: "They asked for the catalog.", owner_hint: "Example Owner",
    due_date: "2026-12-04", slack_status: "open", content_version: 1, delivery_status: "pending", delivered_version: null, tracker_task_id: null,
    partners: [{ name: "Demo Market Echo", url: `${CG}/?tab=marketplaces&m=eeeeeeee-0000-4000-8000-000000000001` }], ...over };
  cg.tasks.set(t.id, t);
  return t;
};
const list = async (status = "all") => (await owner("GET", `/review/corporate?status=${status}`)).body.items as any[];
const item = async (id: string) => (await list()).find((i) => i.id === id);

beforeAll(async () => {
  await freshDb();
  process.env.TEAM_MEMBERS += `,${OWNER}:viewer,manager@example.test:admin`;
  process.env.TASK_TRACKER_API_URL = "https://tracker.example.test";
  process.env.TASK_TRACKER_PLANNING_SECRET = "p".repeat(40);
  process.env.CORPORATE_GIFTING_API_URL = CG;
  process.env.CORPORATE_GIFTING_REPORTING_SECRET = "r".repeat(40);
  process.env.CORPORATE_TASK_DEFAULT_ASSIGNEE = "Demo";
  _setReportingFetchForTests(fakeFetch as any);
});
afterAll(async () => {
  _setReportingFetchForTests(null);
  for (const k of ["PLANNING_OWNER_EMAIL", "TASK_TRACKER_API_URL", "TASK_TRACKER_PLANNING_SECRET", "CORPORATE_GIFTING_API_URL", "CORPORATE_GIFTING_REPORTING_SECRET", "CORPORATE_TASK_DEFAULT_ASSIGNEE"]) delete process.env[k];
  await closePool();
});
beforeEach(() => { process.env.PLANNING_OWNER_EMAIL = OWNER; _resetCorporateSyncState(); });

describe("Corporate Gifts task queue", () => {
  it("exists only for the planning owner", async () => {
    for (const [m, p] of [["GET", "/review/corporate"], ["GET", "/review/corporate/summary"], ["POST", "/review/corporate/refresh"]] as const)
      expect((await req("manager@example.test", m, p, m === "POST" ? {} : undefined)).status).toBe(404);
  });

  it("reads pending requests as drafts assigned to the default person (SB brand), never twice, and reports them in review", async () => {
    cg.reset(); tracker.reset();
    const a = cgTask(), b = cgTask({ title: "Ask Demo Market Foxtrot for listing specs", due_date: null, owner_hint: null });
    const r = await owner("POST", "/review/corporate/refresh", {});
    expect(r.body).toMatchObject({ outcome: "done", added: 2, rejected: 1 });
    expect((await owner("POST", "/review/corporate/refresh", {})).body).toMatchObject({ added: 0 });
    const ia = await item(a.id);
    expect(ia).toMatchObject({ status: "pending", fields: { title: a.title, due_date: "2026-12-04", assignee: { id: STAFF, name: "Demo Staff" }, brand: { id: SB_BRAND } } });
    expect(ia.sent_brief).toContain("Corporate Gifts · Demo Market Echo");
    expect(ia.sent_brief).toContain(`${CG}/?tab=marketplaces&m=`);
    expect((await item(b.id)).needs).toEqual(["Set the due date"]);
    expect(await q("select count(*)::int n from corporate_task_drafts")).toEqual([{ n: 2 }]);
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("in_review");
    expect((await owner("GET", "/review/corporate/summary")).body.pending).toBe(2);
  });

  it("bulk-assigns and sets due dates; sends selected drafts once, and reports delivery with the task id", async () => {
    const drafts = await list("pending");
    const ids = drafts.map((d) => d.id);
    expect((await owner("POST", "/review/corporate/bulk-assign", { ids, tracker_assignee_id: OMAR })).status).toBe(422);   // no access to the brand
    const ba = await owner("POST", "/review/corporate/bulk-assign", { ids, tracker_assignee_id: LAN, due_date: "2026-12-10" });
    expect(ba.body).toEqual({ changed: 2, skipped: 0 });
    for (const d of await list("pending")) expect(d.fields).toMatchObject({ assignee: { id: LAN, name: "Lan" }, due_date: "2026-12-10" });
    const sent = await owner("POST", "/review/corporate/send", { ids });
    expect(sent.body.results.map((x: any) => x.outcome)).toEqual(["created", "created"]);
    expect(tracker.creates).toBe(2);
    expect(tracker.bodies[0]).toMatchObject({ origin: "review", brand_id: SB_BRAND, assignee_id: LAN, due_date: "2026-12-10" });
    expect(tracker.bodies[0].brief).toContain("Corporate Gifts · ");
    expect(JSON.stringify(tracker.bodies)).not.toContain("slack.com");
    // Sending again, re-reading, refreshing: still one task each.
    await owner("POST", "/review/corporate/send", { ids });
    await owner("POST", "/review/corporate/refresh", {});
    expect(tracker.creates).toBe(2);
    for (const id of ids) {
      const t = cg.tasks.get(id)!;
      expect(t.delivery_status).toBe("delivered");
      expect(t.tracker_task_id).toMatch(/^cccccccc-/);
    }
    const delivered = cg.receipts.filter((x) => x.state === "delivered");
    expect(delivered.every((x) => x.tracker?.task_id)).toBe(true);
  });

  it("a failed delivery is reported, and a retry after fixing it creates exactly one task", async () => {
    tracker.reset();
    const t = cgTask({ title: "Follow up with Demo Market Charlie" });
    await owner("POST", "/review/corporate/refresh", {});
    let d = await item(t.id);
    await owner("PATCH", `/review/corporate/${t.id}`, { version: d.version, title: d.fields.title, brief: d.fields.brief, tracker_assignee_id: STAFF, due_date: "2026-12-11" });
    // The assignee loses access in Task Tracker before the send: refused and fenced, nothing created.
    people[STAFF].brands = [];
    expect((await owner("POST", "/review/corporate/send", { ids: [t.id] })).body.results[0].outcome).toBe("failed");
    expect(cg.tasks.get(t.id)!.delivery_status).toBe("failed");
    people[STAFF].brands = [SB_BRAND];
    d = await item(t.id);
    expect(d.delivery.status).toBe("failed");
    expect((await owner("POST", "/review/corporate/send", { ids: [t.id] })).body.results[0].outcome).toBe("created");
    await owner("POST", "/review/corporate/send", { ids: [t.id] });
    expect(tracker.creates).toBe(1);
    expect(cg.tasks.get(t.id)!.delivery_status).toBe("delivered");
  });

  it("a new due date reaches an open delivered task; a completed task stays completed", async () => {
    const open = cgTask({ title: "Due-date task A", due_date: "2026-12-10" }), done = cgTask({ title: "Due-date task B", due_date: "2026-12-10" });
    await owner("POST", "/review/corporate/refresh", {});
    expect((await owner("POST", "/review/corporate/send", { ids: [open.id, done.id] })).body.results.map((x: any) => x.outcome)).toEqual(["created", "created"]);
    const doneKey = `mkp:${done.id}`;
    tracker.tasks.get(doneKey)!.status = "done";
    for (const t of [open, done]) { t.due_date = "2026-12-20"; t.content_version = 2; }
    await syncCorporateTasks();
    expect(tracker.tasks.get(`mkp:${open.id}`)!.due_date).toBe("2026-12-20");
    expect(tracker.tasks.get(doneKey)).toMatchObject({ status: "done", due_date: "2026-12-10" });
    expect(cg.tasks.get(done.id)).toMatchObject({ delivery_status: "delivered", delivered_version: 2 });
    const last = cg.receipts.filter((x) => x.id === done.id).at(-1);
    expect(last).toMatchObject({ state: "delivered", tracker: { status: "done" } });
    // Replaying the same request again changes nothing.
    const patches = tracker.patches;
    await syncCorporateTasks();
    expect(tracker.patches).toBe(patches);
  });

  it("work marked done in Slack, or dismissed, never becomes a task; receipts are retried after a failure", async () => {
    tracker.reset();
    const a = cgTask({ title: "Send Demo Market Golf samples" }), b = cgTask({ title: "Price list for Demo Market Hotel" });
    cg.failReceipts = 1;
    await owner("POST", "/review/corporate/refresh", {});
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("pending");          // receipt failed: sent again next time
    await syncCorporateTasks();
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("in_review");
    a.slack_status = "done"; a.content_version = 2;
    await syncCorporateTasks();
    expect((await item(a.id)).status).toBe("dismissed");
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("dismissed");
    const ib = await item(b.id);
    expect((await owner("POST", `/review/corporate/${b.id}/dismiss`, { version: ib.version })).body.draft.status).toBe("dismissed");
    expect(cg.tasks.get(b.id)!.delivery_status).toBe("dismissed");
    expect((await owner("POST", "/review/corporate/send", { ids: [a.id, b.id] })).body.results.every((x: any) => x.outcome === "skipped")).toBe(true);
    expect(tracker.creates).toBe(0);
  });

  it("delivered tasks carry the Corporate Gifts tag in Marketing Tasks", async () => {
    const created = await q("select tracker_task_id from corporate_task_drafts where tracker_task_id is not null limit 1");
    const tid = created[0].tracker_task_id;
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, assignee_name, status, due_date, snapshot_id)
             values ('tracker-test', $1, $2, 'task', 'sb', 'Send Demo Market Echo the holiday catalog', 'adhoc', 'Succulents Box', 'Lan', 'open', '2026-12-20', 'snp_${"0".repeat(32)}'),
                    ('tracker-test', 'task:99999999-0000-4000-8000-000000000001', '99999999-0000-4000-8000-000000000001', 'task', 'sb', 'Other tracker task', 'adhoc', 'Succulents Box', 'Lan', 'open', '2026-12-20', 'snp_${"0".repeat(32)}')`,
      [`task:${tid}`, tid]);
    const r = await req("manager@example.test", "GET", "/tasks?view=all");
    const mine = r.body.items.find((i: any) => i.id === `tracker:tracker-test:task:${tid}`);
    expect(mine).toMatchObject({ category: "Corporate Gifts", read_only: true });
    expect(r.body.items.find((i: any) => i.title === "Other tracker task").category ?? null).toBeNull();
    const legacy = await req("manager@example.test", "GET", "/tasks?from=2026-12-01&to=2026-12-31");
    expect(legacy.body.items.find((i: any) => i.id === `tracker:tracker-test:task:${tid}`)).toMatchObject({ category: "Corporate Gifts" });
  });
});

describe("in-place status actions", () => {
  it("Resolve: handled with no task; leaves To review and the count at once; Corporate Gifts hears no task will be made; a later read never reopens it", async () => {
    tracker.reset();
    const a = cgTask({ title: "Confirm Demo Market India's spring sizes" });
    await owner("POST", "/review/corporate/refresh", {});
    const before = (await owner("GET", "/review/corporate/summary")).body.pending;
    const ia = await item(a.id);
    const r = await owner("POST", `/review/corporate/${a.id}/resolve`, { version: ia.version });
    expect(r.status).toBe(200);
    expect(r.body.draft).toMatchObject({ status: "resolved" });
    expect((await owner("GET", "/review/corporate/summary")).body.pending).toBe(before - 1);
    expect((await list("pending")).map((i) => i.id)).not.toContain(a.id);
    expect((await list("resolved")).map((i) => i.id)).toContain(a.id);
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("dismissed");
    expect((await owner("POST", `/review/corporate/${a.id}/resolve`, { version: r.body.draft.version })).status).toBe(409);
    a.content_version = 2; a.title = "Confirm Demo Market India's spring sizes (updated)";
    await syncCorporateTasks();
    expect((await item(a.id)).status).toBe("resolved");
    expect((await owner("POST", "/review/corporate/send", { ids: [a.id] })).body.results[0]).toMatchObject({ outcome: "skipped" });
    expect(tracker.creates).toBe(0);
    expect((await req("manager@example.test", "POST", `/review/corporate/${a.id}/resolve`, { version: 1 })).status).toBe(404);
  });

  it("Add to task: confirm the fields, send once; a double click or a retry links the same task", async () => {
    tracker.reset();
    const a = cgTask({ title: "Send Demo Market Juliet the order form" });
    await owner("POST", "/review/corporate/refresh", {});
    const ia = await item(a.id);
    const ed = await owner("PATCH", `/review/corporate/${a.id}`, { version: ia.version, title: "Send Demo Market Juliet the order form", brief: "Use the 2027 form.", tracker_assignee_id: LAN, due_date: "2026-12-09" });
    expect(ed.status).toBe(200);
    const [x, y] = await Promise.all([owner("POST", "/review/corporate/send", { ids: [a.id] }), owner("POST", "/review/corporate/send", { ids: [a.id] })]);
    expect([x.body.results[0].outcome, y.body.results[0].outcome].sort()).toEqual(expect.arrayContaining(["created"]));
    expect(tracker.creates).toBe(1);
    const again = await owner("POST", "/review/corporate/send", { ids: [a.id] });
    expect(again.body.results[0]).toMatchObject({ outcome: "created", existing: true });
    expect(tracker.creates).toBe(1);
    const d = (await owner("GET", `/review/corporate/${a.id}`)).body.draft;
    expect(d).toMatchObject({ status: "approved", delivery: { status: "created" }, task: { open_url: expect.stringContaining("/#/tasks/") } });
    expect(tracker.bodies[0]).toMatchObject({ assignee_id: LAN, due_date: "2026-12-09", title: "Send Demo Market Juliet the order form" });
  });
});
