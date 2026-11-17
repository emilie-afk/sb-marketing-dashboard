// Marketing Planning: owner-only planning, the team's rolling three-month view, publishing and sending tasks to
// Task Tracker (idempotent, partial failures, timeouts), status from the sync, and deadline changes.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, call, q, app, closePool } from "./helpers";
import { issueSession } from "../server/auth";
import { seedGiftOccasions } from "../server/giftSeed";
import { getPool } from "../server/db";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { _setPlanningTimeoutForTests, _setSentClockForTests } from "../server/adapters/planningClient";
import { _setPlanningClockForTests, addCalendarMonths } from "../server/planning";

const OWNER = "planner@example.test";
const SB_BRAND = "aaaaaaaa-1111-4111-8111-111111111111", OTHER_BRAND = "aaaaaaaa-2222-4222-8222-222222222222";
const THAO = "bbbbbbbb-1111-4111-8111-111111111111", OMAR = "bbbbbbbb-2222-4222-8222-222222222222";

// ------------------------------------------------------------ a fake Task Tracker planning API
type FakeTask = { key: string; plan_id: string; task_id: string; title: string; brief: string | null; due_date: string; status: "open" | "done" | "deleted"; version: number; updated_at: string; assignee: string; brand: string };
const tracker = {
  tasks: new Map<string, FakeTask>(), creates: 0, calls: [] as string[],
  dropAfterCreate: 0,          // create the task, then lose the answer (timeout / network)
  hang: 0,                     // never answer
  allowedBrands: null as string[] | null,   // the credential's scope (null = every brand)
  locks: new Map<string, Promise<void>>(), sentAts: [] as string[], bodies: [] as any[],
  beforeLock: null as null | ((body: any) => Promise<void>),
  fences: new Map<string, number>(), fenceSkewMs: 0,      // fenceSkewMs < 0 stands in for a tracker that fences too little
  instanceClock: () => Date.now(),                        // the clock of the instance handling the request
  reset() { this.tasks.clear(); this.creates = 0; this.calls = []; this.dropAfterCreate = 0; this.hang = 0; this.allowedBrands = null; this.locks.clear(); this.sentAts = []; this.bodies = [];
    this.beforeLock = null; this.fences.clear(); this.fenceSkewMs = 0; this.instanceClock = () => Date.now(); },
};
let n = 0;
const uuidN = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const people: Record<string, { name: string; brands: string[] }> = { [THAO]: { name: "Thao", brands: [SB_BRAND] }, [OMAR]: { name: "Omar", brands: [OTHER_BRAND] } };
const out = (t: FakeTask) => ({ idempotency_key: t.key, plan_id: t.plan_id, task_id: t.task_id, title: t.title, due_date: t.due_date, status: t.status, completed_on: t.status === "done" ? "2026-11-20" : null,
  recurring: false, brand: { id: t.brand, name: "Succulents Box" }, assignee: { id: t.assignee, name: people[t.assignee]?.name ?? "?" }, version: t.version, updated_at: t.updated_at, open_url: `https://tracker.example.test/#/tasks/${t.task_id}` });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  if (init?.headers?.["x-tracker-planning-key"] !== "p".repeat(40)) return Promise.resolve(res(401, { error: { code: "unauthorized" } }));
  tracker.calls.push(`${init.method} ${u.pathname}`);
  if (u.pathname === "/api/planning/v1/directory") return Promise.resolve(res(200, {
    brands: [{ id: SB_BRAND, name: "Succulents Box", business_id: "sb" }, { id: OTHER_BRAND, name: "Other", business_id: "p2s" }],
    people: Object.entries(people).map(([id, p]) => ({ id, name: p.name, brand_ids: p.brands })) }));
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "POST") {
    const b = JSON.parse(init.body);
    if (tracker.hang > 0) { tracker.hang--; return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))); }
    if (!b.sent_at) return Promise.resolve(res(400, { error: { code: "invalid_request", message: "sent_at missing" } }));
    tracker.sentAts.push(b.sent_at); tracker.bodies.push(b);
    // Like Task Tracker: an optional pause before the key lock, then freshness, existence and creation under the lock.
    const run = async () => {
      if (tracker.beforeLock) await tracker.beforeLock(b);
      const prev = tracker.locks.get(b.idempotency_key) ?? Promise.resolve();
      let unlock!: () => void;
      const mine = new Promise<void>((r) => { unlock = r; });
      tracker.locks.set(b.idempotency_key, prev.then(() => mine));
      await prev;
      try {
        // The per-key fence (stored in Task Tracker's database) applies whichever instance handles the request.
        const fence = tracker.fences.get(b.idempotency_key);
        if (fence !== undefined && Date.parse(b.sent_at) <= fence) return res(409, { error: { code: "stale_request", message: "Fenced: a later request confirmed no task exists." } });
        const checkedAt = tracker.instanceClock();
        if (Math.abs(checkedAt - Date.parse(b.sent_at)) > 60_000) return res(409, { error: { code: "stale_request", message: "This request is too old; nothing was created." } });
        const inScope = (brand: string) => !tracker.allowedBrands || tracker.allowedBrands.includes(brand);
        const existing = tracker.tasks.get(b.idempotency_key);
        if (existing && !inScope(existing.brand)) return res(409, { error: { code: "key_unavailable", message: "That assignment id is already used outside this credential's businesses." } });
        if (existing) return res(200, { created: false, task: out(existing) });
        const refuse = (code: string, message: string) => {
          const through = Math.max(Date.parse(b.sent_at), b.supersedes_sent_at ? Date.parse(b.supersedes_sent_at) : 0) + tracker.fenceSkewMs;
          tracker.fences.set(b.idempotency_key, Math.max(tracker.fences.get(b.idempotency_key) ?? 0, through));
          return res(422, { error: { code, message, details: { task_exists: false, fenced_through: new Date(through).toISOString() } } });
        };
        if (!inScope(b.brand_id)) return refuse("brand_not_allowed", "Brand not allowed.");
        if (!people[b.assignee_id]?.brands.includes(b.brand_id)) return refuse("assignee_lacks_brand_access", "No access to that brand.");
        const t: FakeTask = { key: b.idempotency_key, plan_id: b.plan_id, task_id: uuidN(), title: b.title, brief: b.brief, due_date: b.due_date, status: "open", version: 1, updated_at: new Date().toISOString(), assignee: b.assignee_id, brand: b.brand_id };
        tracker.tasks.set(t.key, t); tracker.creates++;
        if (tracker.dropAfterCreate > 0) { tracker.dropAfterCreate--; throw new TypeError("network connection lost"); }
        return res(201, { created: true, task: out(t) });
      } finally { unlock(); }
    };
    // The caller's own deadline (abort) ends its wait, as a real HTTP client would; the request itself carries on.
    const p = run();
    return init.signal ? Promise.race([p, new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))]) : p;
  }
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "GET") {
    const keys = (u.searchParams.get("keys") ?? "").split(",");
    return Promise.resolve(res(200, { items: keys.map((k) => tracker.tasks.get(k)).filter((t) => t && (!tracker.allowedBrands || tracker.allowedBrands.includes(t.brand))).map((t) => out(t!)) }));
  }
  const m = /^\/api\/planning\/v1\/tasks\/([^/]+)\/due-date$/.exec(u.pathname);
  if (m && init.method === "PATCH") {
    const t = tracker.tasks.get(decodeURIComponent(m[1])), b = JSON.parse(init.body);
    if (!t) return Promise.resolve(res(404, { error: { code: "not_found" } }));
    if (t.version !== b.expected_version) return Promise.resolve(res(409, { error: { code: "conflict", message: "The task was changed in Task Tracker since it was last read.", details: { task: out(t) } } }));
    t.due_date = b.due_date; t.version++; t.updated_at = new Date().toISOString();
    return Promise.resolve(res(200, { task: out(t) }));
  }
  return Promise.resolve(res(404, { error: { code: "not_found" } }));
}

// ------------------------------------------------------------ sessions
const cookies: Record<string, string> = {};
async function as(email: string) { return (cookies[email] ??= await issueSession({ sub: `sub-${email}`, email })); }
async function req(email: string | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = {};
  if (email) h.cookie = `mkd_session=${await as(email)}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await app(new Request(`http://localhost/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
const owner = (m: string, p: string, b?: unknown) => req(OWNER, m, p, b);
const admin = (m: string, p: string, b?: unknown) => req("admin@example.test", m, p, b);

const TODAY = "2026-11-16";
const base = { business_id: "sb", channels: ["LinkedIn"], target_audience: "HR and People Operations", message_angle: "A gift employees can keep on their desk" };
const plan = (name: string, prep: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ ...base, name, prep_start: prep, campaign_start: start, campaign_end: end, ...extra });
const createPublished = async (body: any) => {
  const c = await owner("POST", "/planning/plans", body);
  expect(c.status).toBe(200);
  const p = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: c.body.plan.version });
  expect(p.status).toBe(200);
  return p.body.plan;
};

beforeAll(async () => {
  await freshDb();
  await seedGiftOccasions(getPool());
  process.env.TEAM_MEMBERS += `,${OWNER}:admin`;
  process.env.TASK_TRACKER_API_URL = "https://tracker.example.test";
  process.env.TASK_TRACKER_PLANNING_SECRET = "p".repeat(40);
  _setReportingFetchForTests(fakeFetch as any);
  _setPlanningClockForTests(() => new Date(`${TODAY}T05:00:00Z`));
});
afterAll(async () => {
  _setReportingFetchForTests(null); _setPlanningClockForTests(null); _setPlanningTimeoutForTests(null);
  delete process.env.PLANNING_OWNER_EMAIL; delete process.env.TASK_TRACKER_API_URL; delete process.env.TASK_TRACKER_PLANNING_SECRET;
  await closePool();
});
beforeEach(() => { tracker.reset(); process.env.PLANNING_OWNER_EMAIL = OWNER; });

describe("owner setting", () => {
  it("without PLANNING_OWNER_EMAIL nobody may plan or see drafts", async () => {
    delete process.env.PLANNING_OWNER_EMAIL;
    expect((await owner("POST", "/planning/plans", plan("No owner", TODAY, "2026-12-01", "2026-12-10"))).status).toBe(403);
    expect((await owner("GET", "/planning/meta")).body).toMatchObject({ owner: false, configured: false });
    expect((await owner("GET", "/planning/directory")).status).toBe(403);
  });
  it("matches the owner's verified sign-in email only; dashboard admins are view-only", async () => {
    expect((await owner("GET", "/planning/meta")).body.owner).toBe(true);
    expect((await admin("GET", "/planning/meta")).body.owner).toBe(false);
    expect((await admin("POST", "/planning/plans", plan("Admin try", TODAY, "2026-12-01", "2026-12-10"))).status).toBe(403);
    expect((await req("editor@example.test", "POST", "/planning/plans", plan("Editor try", TODAY, "2026-12-01", "2026-12-10"))).status).toBe(403);
    expect((await req(null, "GET", "/planning/plans")).status).toBe(401);
    expect((await q("select count(*)::int n from marketing_plans"))[0].n).toBe(0);
  });
});

describe("rolling three-month window (Vietnam dates)", () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    process.env.PLANNING_OWNER_EMAIL = OWNER;
    const limit = addCalendarMonths(TODAY, 3);
    expect(limit).toBe("2027-02-16");
    ids.boundary = (await createPublished(plan("Prep on the boundary", limit, "2027-02-20", "2027-02-28"))).id;
    ids.beyond = (await createPublished(plan("Prep just beyond", "2027-02-17", "2027-02-20", "2027-02-28"))).id;
    ids.today = (await createPublished(plan("Prep starts today", TODAY, "2026-11-20", "2026-11-30"))).id;
    ids.running = (await createPublished(plan("In progress", "2026-10-01", "2026-11-01", TODAY))).id;
    ids.ended = (await createPublished(plan("Ended yesterday", "2026-10-01", "2026-11-01", "2026-11-15"))).id;
    ids.draft = (await owner("POST", "/planning/plans", plan("Secret draft", "2026-12-01", "2026-12-05", "2026-12-10"))).body.plan.id;
  });
  afterAll(async () => { await q("delete from marketing_plans"); });

  it("the team sees published plans whose prep starts today through three months ahead, and running ones", async () => {
    const names = (await admin("GET", "/planning/plans")).body.items.map((p: any) => p.name).sort();
    expect(names).toEqual(["In progress", "Prep on the boundary", "Prep starts today"]);
    expect((await req("viewer@example.test", "GET", "/planning/plans")).body.items).toHaveLength(3);
  });
  it("the owner sees everything, with filters", async () => {
    expect((await owner("GET", "/planning/plans")).body.items).toHaveLength(6);
    expect((await owner("GET", "/planning/plans?status=draft")).body.items.map((p: any) => p.name)).toEqual(["Secret draft"]);
    expect((await owner("GET", "/planning/plans?year=2027")).body.items.map((p: any) => p.name).sort()).toEqual(["Prep just beyond", "Prep on the boundary"]);
    expect((await owner("GET", "/planning/plans?channel=Email")).body.items).toHaveLength(0);
  });
  it("hidden plans answer 404 on direct links, search and the status filter, exactly like missing ones", async () => {
    for (const k of ["beyond", "ended", "draft"]) {
      const r = await admin("GET", `/planning/plans/${ids[k]}`);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("Secret");
    }
    expect((await admin("GET", `/planning/plans/${ids.boundary}`)).status).toBe(200);
    expect((await admin("GET", "/planning/plans?q=Secret")).body.items).toHaveLength(0);
    expect((await admin("GET", "/planning/plans?status=draft")).body.items.map((p: any) => p.status)).not.toContain("draft");
  });
  it("the team view leaves out private delivery details", async () => {
    const r = await admin("GET", `/planning/plans/${ids.boundary}`);
    expect(r.body.plan.version).toBeUndefined();
    expect(r.body.plan.pending_count).toBeUndefined();
  });
  it("the window moves with the date", async () => {
    _setPlanningClockForTests(() => new Date("2026-11-17T05:00:00Z"));
    expect((await admin("GET", `/planning/plans/${ids.beyond}`)).status).toBe(200);
    expect((await admin("GET", `/planning/plans/${ids.running}`)).status).toBe(404);   // campaign ended Nov 16
    _setPlanningClockForTests(() => new Date(`${TODAY}T05:00:00Z`));
  });
});

describe("Employee Appreciation Day: plan, publish and send", () => {
  let planId = "", version = 0;
  const assignment = { title: "Draft three LinkedIn ad concepts for Employee Appreciation Day", brief: "Three concepts with headline and image idea each.", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-01-29" };

  it("saving a draft from the occasion creates zero Tracker tasks", async () => {
    const r = await owner("POST", "/planning/plans", plan("Employee Appreciation Day 2027", "2027-01-15", "2027-02-22", "2027-03-05",
      { gift_occasion_id: "employee-appreciation-day", occurrence_year: 2027, objective: "Corporate desk-gift orders", notes: "Private note", assignments: [assignment] }));
    expect(r.status).toBe(200);
    planId = r.body.plan.id; version = r.body.plan.version;
    expect(r.body.plan.occasion).toMatchObject({ kind: "gift", id: "employee-appreciation-day", year: 2027, name: "Employee Appreciation Day" });
    expect(r.body.plan.assignments[0]).toMatchObject({ assignee: { id: THAO, name: "Thao" }, brand: { name: "Succulents Box" }, delivery: { status: "not_sent" } });
    expect(tracker.creates).toBe(0);
    // The draft is the owner's only: no badge or count for the team on the calendar.
    const agenda = (await admin("GET", "/occasions/agenda?from=2027-03-01&to=2027-03-31&type=gift")).body.items.find((i: any) => i.occasionId === "employee-appreciation-day");
    expect(agenda.plans).toEqual([]);
    const mine = (await owner("GET", "/occasions/agenda?from=2027-03-01&to=2027-03-31&type=gift")).body.items.find((i: any) => i.occasionId === "employee-appreciation-day");
    expect(mine.plans).toMatchObject([{ id: planId, status: "draft", task_count: 0, business: "sb" }]);
  });

  it("previews exactly what will be sent: title, brief, brand, assignee and due date (no objective or notes)", async () => {
    const r = await owner("POST", `/planning/plans/${planId}/preview`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ assignment_id: expect.any(String), title: assignment.title, brand: "Succulents Box", assignee: "Thao", due_date: "2027-01-29", problem: null,
      brief: "Three concepts with headline and image idea each.\n\nCampaign: Employee Appreciation Day 2027 (Succulents Box)\nCampaign dates: Feb 22 to Mar 5, 2027\nChannels: LinkedIn\nTarget audience: HR and People Operations\nMessage angle: A gift employees can keep on their desk" }]);
    expect(r.body.items[0].brief).not.toMatch(/Private note|Corporate desk-gift/);
    expect((await admin("POST", `/planning/plans/${planId}/preview`)).status).toBe(403);
    expect(tracker.creates).toBe(0);
  });

  it("Publish & send creates the task once; repeated clicks return the same task", async () => {
    const r = await owner("POST", `/planning/plans/${planId}/publish`, { version });
    expect(r.status).toBe(200);
    expect(r.body.results).toMatchObject([{ outcome: "created", existing: false }]);
    expect(r.body.plan.status).toBe("published");
    const a = r.body.plan.assignments[0];
    expect(a.delivery.status).toBe("created");
    expect(a.task).toMatchObject({ status: "open", due_date: "2027-01-29", assignee: "Thao", from: "tracker", open_url: `https://tracker.example.test/#/tasks/${a.task.task_id}` });
    const sent = [...tracker.tasks.values()][0];
    expect(sent).toMatchObject({ key: `mkp:${a.id}`, plan_id: planId, assignee: THAO, brand: SB_BRAND, due_date: "2027-01-29" });
    const again = await owner("POST", `/planning/plans/${planId}/publish`, { version: r.body.plan.version });
    expect(again.body.results).toEqual([]);
    expect(tracker.creates).toBe(1);
    version = again.body.plan.version;
  });

  it("the team sees the published plan (prep starts within three months) and its task count on the calendar", async () => {
    const item = (await admin("GET", "/occasions/agenda?from=2027-01-01&to=2027-12-31")).body.items.find((i: any) => i.occasionId === "employee-appreciation-day");
    expect(item.plans).toMatchObject([{ id: planId, status: "published", task_count: 1 }]);
    const d = await admin("GET", "/gift-occasions/employee-appreciation-day?year=2027");
    expect(d.body.plans).toHaveLength(1);
    expect(d.body.canPlan).toBe(false);
    const p = await admin("GET", `/planning/plans/${planId}`);
    expect(p.body.plan.assignments[0].task.status).toBe("open");
    expect(p.body.owner).toBe(false);
  });

  it("completion in Task Tracker reaches the plan through the reporting sync", async () => {
    const a = (await owner("GET", `/planning/plans/${planId}`)).body.plan.assignments[0];
    const later = new Date(Date.now() + 60_000).toISOString();
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, assignee_name, due_date, status, completed_on, created_on, source_updated_at, snapshot_id)
             values ('tracker-test', $1, $2, 'task', 'sb', 'Draft three LinkedIn ad concepts for Employee Appreciation Day', 'adhoc', 'Succulents Box', 'Thao', '2027-01-29', 'done', '2026-11-20', '2026-11-16', $3, 'snp_${"0".repeat(32)}')`,
      [`task:${a.task.task_id}`, a.task.task_id, later]);
    const p = await admin("GET", `/planning/plans/${planId}`);
    expect(p.body.plan.assignments[0].task).toMatchObject({ status: "done", from: "sync" });
  });

  it("created tasks belong to Task Tracker: they can't be edited or removed here, and the plan can't be deleted", async () => {
    const cur = (await owner("GET", `/planning/plans/${planId}`)).body.plan;
    const body = (asg: any[]) => ({ version: cur.version, ...plan(cur.name, cur.prep_start, cur.campaign_start, cur.campaign_end, { gift_occasion_id: "employee-appreciation-day", occurrence_year: 2027 }), assignments: asg });
    const a = cur.assignments[0];
    const same = { id: a.id, title: a.title, brief: a.brief, tracker_brand_id: a.brand.id, tracker_assignee_id: a.assignee.id, due_date: a.due_date };
    expect((await owner("PATCH", `/planning/plans/${planId}`, body([{ ...same, title: "Changed here" }]))).status).toBe(409);
    expect((await owner("PATCH", `/planning/plans/${planId}`, body([]))).status).toBe(409);
    expect((await owner("DELETE", `/planning/plans/${planId}`)).status).toBe(409);
    expect((await admin("PATCH", `/planning/plans/${planId}`, body([same]))).status).toBe(403);
  });
});

describe("partial failures, invalid assignees and retries", () => {
  it("an invalid assignee fails alone; the others are created and linked; retry sends only the rest, without duplicates", async () => {
    const c = await owner("POST", "/planning/plans", plan("Mother's Day 2027", "2027-02-01", "2027-04-20", "2027-05-09", { assignments: [
      { title: "Email concept", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-03-01" },
      { title: "Landing page copy", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-03-08" },
    ] }));
    expect(c.status).toBe(200);
    // Omar can't be assigned in the Succulents Box brand: the plan refuses him before anything is sent.
    const bad = await owner("PATCH", `/planning/plans/${c.body.plan.id}`, { version: c.body.plan.version, ...plan("Mother's Day 2027", "2027-02-01", "2027-04-20", "2027-05-09"),
      assignments: [...c.body.plan.assignments.map((a: any) => ({ id: a.id, title: a.title, tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: a.due_date })),
        { title: "Pinterest pins", tracker_brand_id: SB_BRAND, tracker_assignee_id: OMAR, due_date: "2027-03-10" }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_assignee");

    // Access changes after saving: Thao loses the brand for the second task's attempt.
    people[THAO].brands = [SB_BRAND];
    tracker.dropAfterCreate = 0;
    const pub1 = await (async () => {
      // First assignment works; then the tracker refuses (simulate: Thao loses access mid-send).
      const orig = people[THAO].brands;
      let sent = 0;
      _setReportingFetchForTests((async (u: string, init: any) => {
        if (init.method === "POST" && u.endsWith("/api/planning/v1/tasks") && ++sent === 2) people[THAO].brands = [];
        return fakeFetch(u, init);
      }) as any);
      const r = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: c.body.plan.version });
      _setReportingFetchForTests(fakeFetch as any);
      people[THAO].brands = orig;
      return r;
    })();
    expect(pub1.body.results.map((x: any) => x.outcome)).toEqual(["created", "failed"]);
    const [ok, failed] = pub1.body.plan.assignments;
    expect(ok.delivery.status).toBe("created");
    expect(failed.delivery).toMatchObject({ status: "failed", error: "No access to that brand." });
    expect(pub1.body.plan.status).toBe("published");
    expect(tracker.creates).toBe(1);

    const retry = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: pub1.body.plan.version });
    expect(retry.body.results).toMatchObject([{ assignment_id: failed.id, outcome: "created" }]);
    expect(tracker.creates).toBe(2);
    expect(new Set([...tracker.tasks.values()].map((t) => t.key)).size).toBe(2);
  });

  it("a timeout after Task Tracker created the task: retry finds it and creates no duplicate", async () => {
    const c = await owner("POST", "/planning/plans", plan("Teacher Appreciation 2027", "2027-02-01", "2027-04-26", "2027-05-07", { assignments: [
      { title: "Teacher gift guide", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-03-15" }] }));
    tracker.dropAfterCreate = 1;
    const first = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: c.body.plan.version });
    expect(first.body.results).toMatchObject([{ outcome: "unknown" }]);
    expect(first.body.plan.assignments[0].delivery.status).toBe("unknown");
    expect(first.body.plan.assignments[0].delivery.error).toMatch(/a second task is never created/);
    expect(tracker.creates).toBe(1);
    const retry = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: first.body.plan.version });
    expect(retry.body.results).toMatchObject([{ outcome: "created", existing: true }]);
    expect(tracker.creates).toBe(1);
    expect(retry.body.plan.assignments[0].task.task_id).toBe([...tracker.tasks.values()][0].task_id);
  });

  it("a request that never answers times out and is retried safely", async () => {
    _setPlanningTimeoutForTests(200);
    const c = await owner("POST", "/planning/plans", plan("Hang test", "2027-02-01", "2027-03-01", "2027-03-05", { assignments: [
      { title: "Hang task", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-02-10" }] }));
    tracker.hang = 1;
    const first = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: c.body.plan.version });
    expect(first.body.results).toMatchObject([{ outcome: "unknown" }]);
    _setPlanningTimeoutForTests(null);
    const retry = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: first.body.plan.version });
    expect(retry.body.results).toMatchObject([{ outcome: "created", existing: false }]);
    expect(tracker.creates).toBe(1);
  });
});

describe("campaign date changes and deadlines", () => {
  it("lists affected deadlines, keeps them unless the owner updates one, and surfaces changes made in Task Tracker", async () => {
    const created = await createPublished(plan("Valentine's Day 2027", "2027-01-05", "2027-02-01", "2027-02-14", { assignments: [
      { title: "Valentine email", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-01-20" }] }));
    const a = created.assignments[0];
    const moved = await owner("PATCH", `/planning/plans/${created.id}`, { version: created.version, ...plan("Valentine's Day 2027", "2027-01-05", "2027-02-04", "2027-02-14"),
      assignments: [{ id: a.id, title: a.title, brief: a.brief, tracker_brand_id: a.brand.id, tracker_assignee_id: a.assignee.id, due_date: a.due_date }] });
    expect(moved.status).toBe(200);
    expect(moved.body.deadline_impact).toEqual([{ assignment_id: a.id, title: "Valentine email", current_due_date: "2027-01-20", suggested_due_date: "2027-01-23", outside_new_dates: false }]);
    const t = [...tracker.tasks.values()].find((x) => x.key === `mkp:${a.id}`)!;
    expect(t.due_date).toBe("2027-01-20");                      // kept: nothing changed in Task Tracker by itself

    const upd = await owner("POST", `/planning/plans/${created.id}/assignments/${a.id}/deadline`, { due_date: "2027-01-23" });
    expect(upd.body.outcome).toBe("updated");
    expect(t.due_date).toBe("2027-01-23");
    expect(upd.body.plan.assignments[0].task.due_date).toBe("2027-01-23");

    // Someone edits the task in Task Tracker; the plan's last read is now stale.
    t.version++; t.title = "Valentine email (edited in Tracker)"; t.due_date = "2027-01-25";
    const conflict = await owner("POST", `/planning/plans/${created.id}/assignments/${a.id}/deadline`, { due_date: "2027-01-27" });
    expect(conflict.body.outcome).toBe("conflict");
    expect(conflict.body.current).toMatchObject({ title: "Valentine email (edited in Tracker)", due_date: "2027-01-25" });
    expect(t.due_date).toBe("2027-01-25");
    // After reading the current task again, the owner can decide with the new information.
    const refreshed = await owner("POST", `/planning/plans/${created.id}/refresh`);
    expect(refreshed.body.plan.assignments[0].task).toMatchObject({ title: "Valentine email (edited in Tracker)", due_date: "2027-01-25" });
    expect((await owner("POST", `/planning/plans/${created.id}/assignments/${a.id}/deadline`, { due_date: "2027-01-27" })).body.outcome).toBe("updated");
    expect((await admin("POST", `/planning/plans/${created.id}/assignments/${a.id}/deadline`, { due_date: "2027-01-28" })).status).toBe(403);
    expect((await admin("POST", `/planning/plans/${created.id}/refresh`)).status).toBe(403);
  });
});

describe("calendar and concurrency", () => {
  it("the full-year agenda shows a shared occasion once, listing its brands, plus the year's months in order", async () => {
    const r = await admin("GET", "/occasions/agenda?from=2027-01-01&to=2027-12-31&type=gift");
    expect(r.status).toBe(200);
    const ead = r.body.items.filter((i: any) => i.occasionId === "employee-appreciation-day");
    expect(ead).toHaveLength(1);
    expect(ead[0]).toMatchObject({ start: "2027-03-05", brands: ["p2s", "sb"] });
    const months = [...new Set(r.body.items.map((i: any) => i.start.slice(0, 7)))];
    expect(months.every((m: any) => m.startsWith("2027-") || m < "2027-01")).toBe(true);
    expect(months).toEqual([...months].sort());
    expect(months).toContain("2027-12");
  });

  it("a plan for a spreadsheet occasion shows on that occasion, for the owner only while it is a draft", async () => {
    const [o] = await q(`insert into occasions (business_id, identity_key, name, occasion_date, occasion_type) values ('sb', 'k-hr-week', 'HR Professionals Day', '2027-01-20', 'holiday') returning id`);
    const c = await owner("POST", "/planning/plans", plan("HR Day 2027", "2026-12-01", "2027-01-10", "2027-01-20", { sheet_occasion_id: o.id }));
    expect(c.status).toBe(200);
    const mine = (await owner("GET", "/occasions/agenda?from=2027-01-01&to=2027-01-31&type=sheet")).body.items[0];
    expect(mine.plans.map((p: any) => p.name)).toEqual(["HR Day 2027"]);
    expect((await admin("GET", "/occasions/agenda?from=2027-01-01&to=2027-01-31&type=sheet")).body.items[0].plans).toEqual([]);
  });

  it("two simultaneous sends of one plan never create a task twice", async () => {
    const c = await owner("POST", "/planning/plans", plan("Concurrency", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [
      { title: "One", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-01-10" },
      { title: "Two", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-01-11" }] }));
    const pub = await owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: c.body.plan.version });
    expect(pub.body.results).toHaveLength(2);
    tracker.reset();
    await q("update plan_assignments set delivery_status = 'failed', delivery_error = 'x', tracker_task_id = null where plan_id = $1", [c.body.plan.id]);   // pretend both still need sending
    const v = (await owner("GET", `/planning/plans/${c.body.plan.id}`)).body.plan.version;
    const rs = await Promise.all([1, 2, 3].map(() => owner("POST", `/planning/plans/${c.body.plan.id}/publish`, { version: v })));
    expect(rs.every((r) => r.status === 200 || (r.status === 409 && r.body.error.code === "sending"))).toBe(true);
    expect(tracker.creates).toBe(2);
  });
});

describe("a task is never left in Task Tracker without its plan row", () => {
  const asg = (title: string, due = "2027-01-15") => ({ title, tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: due });
  const body = (p: any, assignments: any[]) => ({ version: p.version, ...plan(p.name, p.prep_start, p.campaign_start, p.campaign_end), assignments });
  const keepAll = (p: any) => p.assignments.map((a: any) => ({ id: a.id, title: a.title, brief: a.brief, tracker_brand_id: a.brand.id, tracker_assignee_id: a.assignee.id, due_date: a.due_date }));

  it("removing an assignment (or deleting the plan) while Task Tracker is creating it is refused; the task stays linked", async () => {
    const c = (await owner("POST", "/planning/plans", plan("Race: remove during send", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [asg("Racing task")] }))).body.plan;
    let duringRemove: any = null, duringDelete: any = null;
    _setReportingFetchForTests((async (u: string, init: any) => {
      if (init.method === "POST" && u.endsWith("/api/planning/v1/tasks")) {
        // While the tracker is creating the task, Emilie removes the assignment and tries to delete the plan.
        const cur = (await owner("GET", `/planning/plans/${c.id}`)).body.plan;
        expect(cur.assignments[0].delivery.status).toBe("sending");          // recorded before the call
        duringRemove = await owner("PATCH", `/planning/plans/${c.id}`, body(cur, []));
        duringDelete = await owner("DELETE", `/planning/plans/${c.id}`);
      }
      return fakeFetch(u, init);
    }) as any);
    const pub = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    _setReportingFetchForTests(fakeFetch as any);
    expect(duringRemove.status).toBe(409);
    expect(duringRemove.body.error.code).toBe("delivery_unresolved");
    expect(duringDelete.status).toBe(409);
    expect(pub.body.results).toMatchObject([{ outcome: "created" }]);
    const p = (await owner("GET", `/planning/plans/${c.id}`)).body.plan;
    expect(p.assignments).toHaveLength(1);
    expect(p.assignments[0].task.task_id).toBe([...tracker.tasks.values()][0].task_id);
    expect(tracker.creates).toBe(1);
  });

  it("an assignment removed before its send starts is simply not sent", async () => {
    const c = (await owner("POST", "/planning/plans", plan("Race: remove first", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [asg("First"), asg("Second")] }))).body.plan;
    _setReportingFetchForTests((async (u: string, init: any) => {
      if (init.method === "POST" && u.endsWith("/api/planning/v1/tasks") && JSON.parse(init.body).title === "First") {
        // During the first send, the second (not yet claimed) assignment is removed: allowed, and it is never sent.
        const cur = (await owner("GET", `/planning/plans/${c.id}`)).body.plan;
        const r = await owner("PATCH", `/planning/plans/${c.id}`, body(cur, keepAll(cur).filter((a: any) => a.title === "First")));
        expect(r.status).toBe(200);
      }
      return fakeFetch(u, init);
    }) as any);
    const pub = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    _setReportingFetchForTests(fakeFetch as any);
    expect(pub.body.results).toHaveLength(1);
    expect([...tracker.tasks.values()].map((t) => t.title)).toEqual(["First"]);
  });

  it("after a timeout where Task Tracker created the task, edits and removal are blocked until it is reconciled by its id", async () => {
    const c = (await owner("POST", "/planning/plans", plan("Timeout then edit", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [asg("Lost answer")] }))).body.plan;
    tracker.dropAfterCreate = 1;
    const first = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    expect(first.body.plan.assignments[0].delivery.status).toBe("unknown");
    expect(tracker.creates).toBe(1);
    const cur = (await owner("GET", `/planning/plans/${c.id}`)).body.plan;
    const remove = await owner("PATCH", `/planning/plans/${c.id}`, body(cur, []));
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe("delivery_unresolved");
    const rename = await owner("PATCH", `/planning/plans/${c.id}`, body(cur, keepAll(cur).map((a: any) => ({ ...a, title: "Renamed" }))));
    expect(rename.status).toBe(409);
    expect((await owner("DELETE", `/planning/plans/${c.id}`)).status).toBe(409);
    // Check Task Tracker reconciles by the assignment id: the existing task is linked, nothing new is created.
    const posts = tracker.calls.filter((x) => x.startsWith("POST")).length;
    const r = await owner("POST", `/planning/plans/${c.id}/refresh`);
    expect(r.body.plan.assignments[0]).toMatchObject({ delivery: { status: "created" }, task: { task_id: [...tracker.tasks.values()][0].task_id } });
    expect(tracker.calls.filter((x) => x.startsWith("POST")).length).toBe(posts);
    expect(tracker.creates).toBe(1);
  });

  it("a send interrupted mid-way (left as sending) is settled by its id on the next send, without a duplicate", async () => {
    const c = (await owner("POST", "/planning/plans", plan("Interrupted", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [asg("Crash task")] }))).body.plan;
    const key = `mkp:${c.assignments[0].id}`;
    // The tracker got the request and created the task, but the dashboard stopped before recording the answer.
    await fakeFetch("https://tracker.example.test/api/planning/v1/tasks", { method: "POST", headers: { "x-tracker-planning-key": "p".repeat(40) },
      body: JSON.stringify({ idempotency_key: key, plan_id: c.id, brand_id: SB_BRAND, assignee_id: THAO, title: "Crash task", due_date: "2027-01-15", sent_at: new Date().toISOString() }) });
    await q("update plan_assignments set delivery_status = 'sending' where id = $1", [c.assignments[0].id]);
    await q("update marketing_plans set status = 'published', published_at = now() where id = $1", [c.id]);
    expect((await owner("PATCH", `/planning/plans/${c.id}`, body((await owner("GET", `/planning/plans/${c.id}`)).body.plan, []))).status).toBe(409);
    const v = (await owner("GET", `/planning/plans/${c.id}`)).body.plan.version;
    const r = await owner("POST", `/planning/plans/${c.id}/publish`, { version: v });
    expect(r.body.results).toMatchObject([{ outcome: "created", existing: true }]);
    expect(tracker.creates).toBe(1);
  });
});

describe("retrying an unanswered send only settles on an explicit answer", () => {
  const asg = (title: string) => ({ title, tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-01-15" });
  const body = (p: any, assignments: any[]) => ({ version: p.version, ...plan(p.name, p.prep_start, p.campaign_start, p.campaign_end), assignments });

  it("created, answer lost, credential narrowed before Retry: stays locked; with the scope restored, Retry links it without a duplicate", async () => {
    const c = (await owner("POST", "/planning/plans", plan("Narrowed before retry", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [asg("Scope task")] }))).body.plan;
    tracker.dropAfterCreate = 1;
    const first = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    expect(first.body.plan.assignments[0].delivery.status).toBe("unknown");
    expect(tracker.creates).toBe(1);

    tracker.allowedBrands = [OTHER_BRAND];                   // the credential no longer covers the task's business
    const retry = await owner("POST", `/planning/plans/${c.id}/publish`, { version: first.body.plan.version });
    expect(retry.body.results).toMatchObject([{ outcome: "unknown", code: "key_unavailable" }]);
    const p = retry.body.plan;
    expect(p.assignments[0].delivery.status).toBe("unknown");
    expect((await owner("PATCH", `/planning/plans/${c.id}`, body(p, []))).status).toBe(409);
    expect((await owner("DELETE", `/planning/plans/${c.id}`)).status).toBe(409);
    expect((await owner("POST", `/planning/plans/${c.id}/refresh`)).body.plan.assignments[0].delivery.status).toBe("unknown");

    tracker.allowedBrands = null;                            // scope restored
    const again = await owner("POST", `/planning/plans/${c.id}/publish`, { version: p.version });
    expect(again.body.results).toMatchObject([{ outcome: "created", existing: true }]);
    expect(again.body.plan.assignments[0].task.task_id).toBe([...tracker.tasks.values()][0].task_id);
    expect(tracker.creates).toBe(1);
  });

  it("an explicit 'no task exists' with a fence covering every earlier attempt settles it", async () => {
    const c = (await owner("POST", "/planning/plans", plan("Never arrived", "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [asg("Lost request")] }))).body.plan;
    // The first request never reached Task Tracker (network error before it was received).
    _setReportingFetchForTests((async (u: string, init: any) => (init.method === "POST" && u.endsWith("/api/planning/v1/tasks") ? Promise.reject(new TypeError("network down")) : fakeFetch(u, init))) as any);
    const first = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    _setReportingFetchForTests(fakeFetch as any);
    expect(first.body.plan.assignments[0].delivery.status).toBe("unknown");
    const [{ highest_sent_at: firstSent }] = await q("select highest_sent_at from plan_assignments where plan_id = $1", [c.id]);
    people[THAO].brands = [];                                // Thao has since lost access: Task Tracker refuses and confirms no task exists
    try {
      const retry = await owner("POST", `/planning/plans/${c.id}/publish`, { version: first.body.plan.version });
      const sent = tracker.bodies.at(-1);
      expect(sent.supersedes_sent_at).toBe(new Date(firstSent).toISOString());              // the earlier attempt is named
      expect(Date.parse(sent.sent_at)).toBeGreaterThan(Date.parse(sent.supersedes_sent_at));
      expect(retry.body.plan.assignments[0].delivery).toMatchObject({ status: "failed", error: "No access to that brand." });
      expect((await owner("PATCH", `/planning/plans/${c.id}`, body(retry.body.plan, []))).status).toBe(200);
    } finally { people[THAO].brands = [SB_BRAND]; }
    expect(tracker.creates).toBe(0);
  });
});

describe("a delayed original can't create a task after absence was confirmed, across instances and clocks", () => {
  const mk = async (name: string) => (await owner("POST", "/planning/plans", plan(name, "2027-01-01", "2027-02-01", "2027-02-05", { assignments: [
    { title: `${name} task`, tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2027-01-15" }] }))).body.plan;

  it("original pauses before the lock; a retry on another instance confirms absence and fences the key; the assignment is removed; the original resumes on an instance whose clock is behind and creates nothing", async () => {
    const c = await mk("Paused original");
    // 1. The original request is sent by a dashboard instance whose clock runs 5 s ahead, and pauses before Task Tracker's
    //    lock; the dashboard stops waiting for it.
    let release!: () => void, reached!: () => void;
    const paused = new Promise<void>((r) => { release = r; }), atLock = new Promise<void>((r) => { reached = r; });
    tracker.beforeLock = async () => { tracker.beforeLock = null; reached(); await paused; };
    _setSentClockForTests(() => Date.now() + 5_000);
    _setPlanningTimeoutForTests(150);
    const first = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    _setSentClockForTests(null); _setPlanningTimeoutForTests(null);
    await atLock;
    expect(first.body.plan.assignments[0].delivery.status).toBe("unknown");
    const originalSent = tracker.sentAts[0];
    const [row] = await q("select highest_sent_at from plan_assignments where plan_id = $1", [c.id]);
    expect(new Date(row.highest_sent_at).toISOString()).toBe(originalSent);            // the exact sent_at sent is the one stored

    // 2. Thao loses access. A retry from an instance with a correct clock is still sent after the original
    //    (sent_at > stored highest) and names it; Task Tracker confirms no task and fences through both.
    people[THAO].brands = [];
    try {
      const v = (await owner("GET", `/planning/plans/${c.id}`)).body.plan.version;
      const retry = await owner("POST", `/planning/plans/${c.id}/publish`, { version: v });
      const sent = tracker.bodies.at(-1);
      expect(Date.parse(sent.sent_at)).toBeGreaterThan(Date.parse(originalSent));
      expect(sent.supersedes_sent_at).toBe(originalSent);
      expect(tracker.fences.get(`mkp:${c.assignments[0].id}`)).toBeGreaterThanOrEqual(Date.parse(originalSent));
      expect(retry.body.plan.assignments[0].delivery.status).toBe("failed");
      const removed = await owner("PATCH", `/planning/plans/${c.id}`, { version: retry.body.plan.version, ...plan("Paused original", "2027-01-01", "2027-02-01", "2027-02-05"), assignments: [] });
      expect(removed.status).toBe(200);
    } finally { people[THAO].brands = [SB_BRAND]; }

    // 3. Access is back, so the original would be valid. It resumes on an instance whose clock says it is fresh (age 0):
    //    the database fence refuses it, and nothing is created.
    tracker.instanceClock = () => Date.parse(originalSent);
    release();
    await new Promise((r) => setTimeout(r, 50));
    await tracker.locks.get(`mkp:${c.assignments[0].id}`);
    expect(tracker.creates).toBe(0);
    expect(tracker.tasks.size).toBe(0);
  });

  it("a later attempt is always sent after the fence and every earlier attempt, even from a server whose clock is behind", async () => {
    const c = await mk("Monotonic");
    // An unanswered first attempt, then a retry refused with "no task" (Thao had lost access): the key is fenced.
    _setReportingFetchForTests((async (u: string, init: any) => (init.method === "POST" && u.endsWith("/api/planning/v1/tasks") ? Promise.reject(new TypeError("network down")) : fakeFetch(u, init))) as any);
    const first = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    _setReportingFetchForTests(fakeFetch as any);
    people[THAO].brands = [];
    try { await owner("POST", `/planning/plans/${c.id}/publish`, { version: first.body.plan.version }); } finally { people[THAO].brands = [SB_BRAND]; }
    const fence = tracker.fences.get(`mkp:${c.assignments[0].id}`)!;
    _setSentClockForTests(() => Date.now() - 120_000);                         // this dashboard instance's clock is 2 min behind
    const v = (await owner("GET", `/planning/plans/${c.id}`)).body.plan.version;
    const again = await owner("POST", `/planning/plans/${c.id}/publish`, { version: v });
    _setSentClockForTests(null);
    expect(Date.parse(tracker.bodies.at(-1).sent_at)).toBeGreaterThan(fence);
    expect(again.body.results).toMatchObject([{ outcome: "created" }]);
  });

  it("a 'no task' whose fence does not cover the earlier attempt keeps the assignment locked", async () => {
    const c = await mk("Short fence");
    tracker.beforeLock = async () => { tracker.beforeLock = null; await new Promise(() => {}); };   // the original never reaches the lock
    _setPlanningTimeoutForTests(150);
    const first = await owner("POST", `/planning/plans/${c.id}/publish`, { version: c.version });
    _setPlanningTimeoutForTests(null);
    tracker.fenceSkewMs = -60_000;                                                 // a tracker that fences too little
    people[THAO].brands = [];
    try {
      const retry = await owner("POST", `/planning/plans/${c.id}/publish`, { version: first.body.plan.version });
      expect(retry.body.plan.assignments[0].delivery.status).toBe("unknown");
      expect((await owner("PATCH", `/planning/plans/${c.id}`, { version: retry.body.plan.version, ...plan("Short fence", "2027-01-01", "2027-02-01", "2027-02-05"), assignments: [] })).status).toBe(409);
    } finally { people[THAO].brands = [SB_BRAND]; }
  });
});
