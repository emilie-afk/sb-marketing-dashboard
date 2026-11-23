// Corporate Gifts tasks → the planning owner's queue → Task Tracker → Marketing Tasks. Synthetic data only
// (example.test hosts, Demo Market names).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, q, app, closePool } from "./helpers";
import { issueSession } from "../server/auth";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { syncCorporateTasks, _resetCorporateSyncState } from "../server/corporateTasks";
import { linkIntakeTasks } from "../server/intakeLinks";

const OWNER = "planner@example.test";
const SB_BRAND = "aaaaaaaa-1111-4111-8111-111111111111", STAFF = "bbbbbbbb-1111-4111-8111-111111111111", LAN = "bbbbbbbb-3333-4333-8333-333333333333", OMAR = "bbbbbbbb-2222-4222-8222-222222222222";
const CG = "https://gifts.example.test";
const people: Record<string, { name: string; brands: string[] }> = { [STAFF]: { name: "Demo Staff", brands: [SB_BRAND] }, [LAN]: { name: "Lan", brands: [SB_BRAND] }, [OMAR]: { name: "Omar", brands: [] } };

// ------------------------------------------------------------ fake Corporate Gifts (tasks + receipts)
type CgT = { id: string; title: string; brief: string | null; owner_hint: string | null; due_date: string | null; slack_status: string; content_version: number;
  delivery_status: string; delivered_version: number | null; tracker_task_id: string | null; partners: { name: string; url: string }[]; slack_sources?: { channel_id: string; message_ts: string; request_id?: string }[] };
// caps: whether this Corporate Gifts accepts the shared "resolved" status (its migration 008); without it a "resolved"
// receipt is refused, as the previous Corporate Gifts build does.
const cg = { tasks: new Map<string, CgT>(), receipts: [] as any[], failReceipts: 0, caps: true, reset() { this.tasks.clear(); this.receipts = []; this.failReceipts = 0; this.caps = true; } };
function applyReceipt(r: any) {
  const t = cg.tasks.get(r.id);
  if (!t) return;
  if (r.state === "delivered") { t.delivery_status = "delivered"; t.tracker_task_id = r.tracker.task_id; t.delivered_version = Math.max(t.delivered_version ?? 0, r.content_version); return; }
  if (["delivered", "dismissed", "resolved"].includes(t.delivery_status)) return;
  if (r.state === "in_review" && t.delivery_status !== "pending") return;
  t.delivery_status = r.state;
}
// ------------------------------------------------------------ fake Task Tracker planning API
type T = { key: string; plan_id: string; origin: string; task_id: string; title: string; brief: string | null; due_date: string; status: string; version: number; updated_at: string; assignee: string; brand: string };
const tracker = { tasks: new Map<string, T>(), creates: 0, bodies: [] as any[], patches: 0, fences: new Map<string, number>(),
  // Tasks Task Tracker's Slack intake created, by "channel:ts" (and "channel:ts:action"), for the one-request-one-task checks.
  intake: new Map<string, T>(), linkCalls: 0, linkEndpoint: true,
  reset() { this.tasks.clear(); this.creates = 0; this.bodies = []; this.patches = 0; this.fences.clear(); this.intake.clear(); this.linkCalls = 0; this.linkEndpoint = true; } };
// Task Tracker's rule: a numbered source matches only the same request; an unnumbered one on a message with tasks is ambiguous.
const intakeMatch = (sources: any[] = []) => {
  const found = new Set<T>();
  let ambiguous = false;
  for (const s of sources) {
    if (s.action_id) { const t = tracker.intake.get(`${s.channel_id}:${s.message_ts}:${s.action_id}`); if (t) found.add(t); }
    else if ([...tracker.intake.keys()].some((k) => k.startsWith(`${s.channel_id}:${s.message_ts}:`))) ambiguous = true;
  }
  return ambiguous || found.size > 1 ? null : [...found];
};
const linkIntake = (t: T, b: any) => { const linked = { ...t, key: b.idempotency_key, plan_id: b.plan_id }; tracker.tasks.set(b.idempotency_key, linked); return linked; };
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
      return res(200, { ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:corporate-tasks", as_of: new Date().toISOString(), tasks: [...tasks, { id: "not-a-task" }],
        ...(cg.caps ? { capabilities: ["resolved"] } : {}) });
    }
    if (u.pathname === "/api/reporting/v1/corporate-task-actions" && init.method === "POST") {
      // The delivery claim (Corporate Gifts' rules: current, open, not changed since the dashboard read it).
      const b = JSON.parse(init.body);
      return res(200, { ok: true, results: b.actions.map((a: any) => {
        const t = cg.tasks.get(a.id);
        if (!t) return { id: a.id, outcome: "not_found" };
        if (["delivered", "sending"].includes(t.delivery_status)) return { id: a.id, outcome: "claimed" };
        if (t.slack_status !== "open" || t.delivery_status === "dismissed") return { id: a.id, outcome: "closed", message: "Closed in Corporate Gifts." };
        if (t.content_version !== a.content_version) return { id: a.id, outcome: "stale", message: "Changed in Corporate Gifts since the last refresh." };
        t.delivery_status = "sending";
        return { id: a.id, outcome: "claimed" };
      }) });
    }
    if (u.pathname === "/api/reporting/v1/corporate-task-receipts" && init.method === "POST") {
      if (cg.failReceipts > 0) { cg.failReceipts--; return res(503, { error: { code: "down" } }); }
      const b = JSON.parse(init.body);
      if (!cg.caps && b.receipts.some((r: any) => r.state === "resolved")) return res(400, { error: { code: "payload_rejected" } });
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
  const done = /^\/api\/planning\/v1\/tasks\/([^/]+)\/complete$/.exec(u.pathname);
  if (done && init.method === "POST") {
    const t = tracker.tasks.get(decodeURIComponent(done[1]));
    if (!t) return res(404, { error: { code: "not_found" } });
    if (t.status !== "done") { t.status = "done"; t.version++; t.updated_at = new Date().toISOString(); }
    return res(200, { task: out(t) });
  }
  if (u.pathname === "/api/planning/v1/slack-links" && init.method === "POST") {
    if (!tracker.linkEndpoint) return res(404, { error: { code: "not_found" } });
    tracker.linkCalls++;
    const b = JSON.parse(init.body);
    const existing = tracker.tasks.get(b.idempotency_key);
    if (existing) return res(200, { linked: true, task: out(existing) });
    const m = intakeMatch(b.slack_sources);
    if (!m || m.length !== 1) return res(200, { linked: false, reason: m ? "not_found" : "ambiguous" });
    return res(200, { linked: true, task: out(linkIntake(m[0], b)) });
  }
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "POST") {
    const b = JSON.parse(init.body);
    tracker.bodies.push(b);
    const m0 = tracker.tasks.has(b.idempotency_key) ? [] : intakeMatch(b.slack_sources);
    if (m0 === null) return res(409, { error: { code: "needs_review", message: "Not sure which request of the message this is.", details: { task_exists: false, fenced_through: new Date(Date.parse(b.sent_at)).toISOString() } } });
    if (m0.length === 1) return res(200, { created: false, linked: true, task: out(linkIntake(m0[0], b)) });
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
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("resolved");
    expect(cg.receipts.filter((x) => x.id === a.id).at(-1)).toMatchObject({ state: "resolved" });
    // Recorded as reported (not sent again on every sync).
    expect((await q("select receipt_due, receipt_state from corporate_task_drafts where id = $1", [a.id]))[0]).toEqual({ receipt_due: false, receipt_state: "resolved" });
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

describe("Resolved, shared with Corporate Gifts", () => {
  const stateOf = async (id: string) => (await owner("GET", `/review/corporate/${id}`)).body.draft;
  it("resolved in Corporate Gifts: closed here after the next read, the count drops, no task; a later send or rescan never reopens it", async () => {
    tracker.reset();
    const a = cgTask({ title: "Answer Demo Market Kilo's packaging question" });
    await syncCorporateTasks();
    const before = (await owner("GET", "/review/corporate/summary")).body.pending;
    a.delivery_status = "resolved";                                         // Resolve clicked in Corporate Gifts
    await syncCorporateTasks();
    expect(await stateOf(a.id)).toMatchObject({ status: "resolved", resolved_in: "corporate_gifts", cg_state: "resolved" });
    expect((await owner("GET", "/review/corporate/summary")).body.pending).toBe(before - 1);
    expect((await owner("POST", "/review/corporate/send", { ids: [a.id] })).body.results[0]).toMatchObject({ outcome: "skipped" });
    a.content_version = 2; await syncCorporateTasks();
    expect((await stateOf(a.id)).status).toBe("resolved");
    expect(cg.receipts.filter((x) => x.id === a.id && x.state !== "in_review")).toEqual([]);   // nothing to report back: it was resolved there
    expect(tracker.creates).toBe(0);
  });

  it("before Corporate Gifts accepts 'resolved', a resolution here is held back (never sent as another state), then reported", async () => {
    tracker.reset();
    cg.caps = false;
    try {
      const a = cgTask({ title: "Check Demo Market Lima's invoice format" });
      await syncCorporateTasks();
      const d = await stateOf(a.id);
      expect((await owner("POST", `/review/corporate/${a.id}/resolve`, { version: d.version })).body.draft.status).toBe("resolved");
      await syncCorporateTasks();
      expect(cg.tasks.get(a.id)!.delivery_status).toBe("in_review");
      expect(cg.receipts.filter((x) => x.id === a.id && x.state !== "in_review")).toEqual([]);
      cg.caps = true;
      await syncCorporateTasks();
      expect(cg.tasks.get(a.id)!.delivery_status).toBe("resolved");
    } finally { cg.caps = true; }
  });

  it("a stale update is refused, and a stale receipt never reopens a resolved request", async () => {
    tracker.reset();
    const a = cgTask({ title: "Send Demo Market Mike the size chart" });
    await syncCorporateTasks();
    const d = await stateOf(a.id);
    await owner("PATCH", `/review/corporate/${a.id}`, { version: d.version, title: "Send Demo Market Mike the size chart (v2)", brief: null, tracker_assignee_id: LAN, due_date: "2026-12-11" });
    expect((await owner("POST", `/review/corporate/${a.id}/resolve`, { version: d.version })).status).toBe(409);   // opened before the edit
    const cur = await stateOf(a.id);
    expect((await owner("POST", `/review/corporate/${a.id}/resolve`, { version: cur.version })).status).toBe(200);
    applyReceipt({ id: a.id, content_version: 1, state: "in_review" });
    applyReceipt({ id: a.id, content_version: 1, state: "failed" });
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("resolved");
    expect((await stateOf(a.id)).status).toBe("resolved");
  });

  it("racing with task creation: a send in progress blocks Resolve; an existing task wins, is linked and completed in Task Tracker; an unsettled send is refused", async () => {
    tracker.reset();
    const a = cgTask({ title: "Ship Demo Market November samples" });
    await syncCorporateTasks();
    let d = await stateOf(a.id);
    d = (await owner("PATCH", `/review/corporate/${a.id}`, { version: d.version, title: d.fields.title, brief: null, tracker_assignee_id: LAN, due_date: "2026-12-12" })).body.draft;
    // 1. A send holds the draft's lock: Resolve waits for it.
    const c = await (await import("../server/db")).getPool().connect();
    await c.query("select pg_advisory_lock(hashtextextended($1, 17))", [a.id]);
    try { expect((await owner("POST", `/review/corporate/${a.id}/resolve`, { version: d.version })).body.error.code).toBe("sending"); }
    finally { await c.query("select pg_advisory_unlock(hashtextextended($1, 17))", [a.id]); c.release(); }
    // 2. The task was created but the answer was lost: Resolve checks Task Tracker first, links the task and completes it there.
    await owner("POST", "/review/corporate/send", { ids: [a.id] });
    expect(tracker.creates).toBe(1);
    await q(`update corporate_task_drafts set delivery_status = 'unknown', tracker_task_id = null, tracker_status = null where id = $1`, [a.id]);
    d = await stateOf(a.id);
    const r = await owner("POST", `/review/corporate/${a.id}/resolve`, { version: d.version });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("complete");
    expect(await stateOf(a.id)).toMatchObject({ status: "approved", delivery: { status: "created" }, task: { status: "done", open_url: expect.stringContaining("/#/tasks/") }, resolution: { state: "resolved" } });
    expect(tracker.creates).toBe(1);
    // 3. Resolved in Corporate Gifts while the task was being created: the task wins, and Corporate Gifts is told it was delivered.
    a.delivery_status = "resolved";
    await syncCorporateTasks();
    expect(cg.tasks.get(a.id)!.delivery_status).toBe("delivered");
    expect((await stateOf(a.id)).status).toBe("approved");
    expect(tracker.creates).toBe(1);
    // 4. No answer and no task in Task Tracker yet: Resolve is refused (that send could still arrive).
    const b = cgTask({ title: "Ask Demo Market November about labels" });
    await syncCorporateTasks();
    await q(`update corporate_task_drafts set status = 'approved', delivery_status = 'unknown', tracker_assignee_id = $2, due_date = '2026-12-12' where id = $1`, [b.id, LAN]);
    const rb = await owner("POST", `/review/corporate/${b.id}/resolve`, { version: (await stateOf(b.id)).version });
    expect(rb.body.error.code).toBe("delivery_unsettled");
    // ...and a Corporate Gifts resolution waits for Task Tracker too: the draft stays as it is.
    cg.tasks.get(b.id)!.delivery_status = "resolved";
    await syncCorporateTasks();
    expect((await stateOf(b.id)).status).toBe("approved");
    expect(tracker.creates).toBe(1);
  });
});

describe("one Slack request, one task: Task Tracker's Slack intake and the planning owner's queues", () => {
  const CH = "C0TEAMMKT1";
  const intakeTask = (key: string, title = "Intake task"): T => {
    const t: T = { key: `slack-intake:${key}`, plan_id: "", origin: "slack", task_id: `ffffffff-0000-4000-8000-${String(++n).padStart(12, "0")}`, title, brief: null, due_date: "2026-12-01",
      status: "open", version: 1, updated_at: new Date().toISOString(), assignee: STAFF, brand: SB_BRAND };
    tracker.intake.set(key, t);
    return t;
  };
  const suggestion = async (ts: string, action = "a1") => (await q(
    `insert into review_suggestions (source_key, channel_id, message_ts, posted_at, excerpt, suggested_title, title)
     values ($1, $2, $3, now(), 'Fictional request', 'Fictional title', 'Fictional title') returning id`, [`slack:${CH}:${ts}:${action}`, CH, ts]))[0].id as string;

  it("stores a Corporate Gifts draft's Slack identity, with its request number, and sends it with the task", async () => {
    cg.reset(); tracker.reset();
    const t = cgTask({ slack_sources: [{ channel_id: CH, message_ts: "1795000000.000100", request_id: "a2" } as any] });
    await owner("POST", "/review/corporate/refresh", {});
    expect((await q("select slack_sources from corporate_task_drafts where id = $1", [t.id]))[0].slack_sources).toEqual([{ channel_id: CH, message_ts: "1795000000.000100", request_id: "a2" }]);
    tracker.linkEndpoint = false;
    const sent = await owner("POST", "/review/corporate/send", { ids: [t.id] });
    expect(sent.body.results[0].outcome).toBe("created");
    expect(tracker.bodies.at(-1)).toMatchObject({ slack_sources: [{ channel_id: CH, message_ts: "1795000000.000100", action_id: "a2" }], source_workflow: "corporate" });
  });
  it("links waiting items to the intake task of the same request only; nothing is sent twice", async () => {
    cg.reset(); tracker.reset();
    // One message with two requests: a1 "Write blog post", a2 "Send newsletter".
    const blog = intakeTask(`${CH}:1795000100.000100:a1`, "Write blog post");
    const letter = intakeTask(`${CH}:1795000100.000100:a2`, "Send newsletter");
    const t = cgTask({ title: "Send newsletter", slack_sources: [{ channel_id: CH, message_ts: "1795000100.000100", request_id: "a2" } as any] });
    const unnumbered = cgTask({ title: "Send newsletter (no number)", slack_sources: [{ channel_id: CH, message_ts: "1795000100.000100" }] });
    await owner("POST", "/review/corporate/refresh", {});
    const it2 = intakeTask(`${CH}:1795000200.000100:a1`, "Update the banner (from Slack)");
    const sid = await suggestion("1795000200.000100", "a1");
    const other = await suggestion("1795000300.000100", "a1");             // no intake task: stays for review
    const r = await linkIntakeTasks();
    expect(r).toMatchObject({ outcome: "done", linked: 2 });
    expect((await q("select tracker_task_id from corporate_task_drafts where id = $1", [t.id]))[0].tracker_task_id).toBe(letter.task_id);
    expect((await q("select tracker_task_id from corporate_task_drafts where id = $1", [t.id]))[0].tracker_task_id).not.toBe(blog.task_id);
    expect(await item(t.id)).toMatchObject({ status: "approved", delivery: { status: "created", linked_from_slack_intake: true } });
    // Without its request number the draft is not linked, and sending it creates nothing: it stays for review.
    expect((await item(unnumbered.id)).status).toBe("pending");
    const [s] = await q("select status, delivery_status, tracker_task_id, intake_linked_at from review_suggestions where id = $1", [sid]);
    expect(s).toMatchObject({ status: "approved", delivery_status: "created", tracker_task_id: it2.task_id });
    expect((await q("select status from review_suggestions where id = $1", [other]))[0].status).toBe("pending");
    expect(tracker.creates).toBe(0);
    await syncCorporateTasks();
    expect(cg.tasks.get(t.id)).toMatchObject({ delivery_status: "delivered", tracker_task_id: letter.task_id });
    expect((await linkIntakeTasks()).linked).toBe(0);
  });
  it("reaches every waiting item in turn, however long the queue (least recently checked first)", async () => {
    cg.reset(); tracker.reset();
    await q("update review_suggestions set status = 'dismissed' where status = 'pending'");
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(await suggestion(`17950${String(10000 + i)}.000100`, "a1"));
    await linkIntakeTasks();
    await linkIntakeTasks();
    expect((await q("select count(*)::int n from review_suggestions where id = any($1::uuid[]) and intake_checked_at is not null", [ids]))[0].n).toBe(51);
    // The oldest item now matches an intake task: it is linked within the next two runs.
    intakeTask(`${CH}:1795010000.000100:a1`, "Oldest request");
    let linked = 0;
    for (let run = 0; run < 2 && !linked; run++) linked += (await linkIntakeTasks()).linked;
    expect(linked).toBe(1);
    expect((await q("select status from review_suggestions where id = $1", [ids[0]]))[0].status).toBe("approved");
  });
  it("leaves items for review when Task Tracker has no link endpoint yet", async () => {
    cg.reset(); tracker.reset();
    tracker.linkEndpoint = false;
    intakeTask(`${CH}:1795000400.000100:a1`);
    const t = cgTask({ slack_sources: [{ channel_id: CH, message_ts: "1795000400.000100", request_id: "a1" } as any] });
    await owner("POST", "/review/corporate/refresh", {});
    expect((await linkIntakeTasks()).outcome).toBe("unavailable");
    expect((await item(t.id)).status).toBe("pending");
  });
  it("builds the Slack identity sent with review-queue and plan items from the source key only", async () => {
    const { reviewSources, corporateSources } = await import("../server/trackerDelivery");
    expect(reviewSources(`slack:${CH}:1795000500.000100:a2`)).toEqual({ slack_sources: [{ channel_id: CH, message_ts: "1795000500.000100", action_id: "a2" }], source_workflow: "review" });
    expect(reviewSources("not-a-key")).toBeNull();
    expect(corporateSources([{ channel_id: CH, message_ts: "1795000500.000100", request_id: "a3", permalink: "https://x.slack.com/archives/x" }])).toEqual({ slack_sources: [{ channel_id: CH, message_ts: "1795000500.000100", action_id: "a3" }], source_workflow: "corporate" });
    expect(corporateSources([{ channel_id: CH, message_ts: "1795000500.000100" }])).toEqual({ slack_sources: [{ channel_id: CH, message_ts: "1795000500.000100" }], source_workflow: "corporate" });
    expect(corporateSources([])).toBeNull();
  });
});
