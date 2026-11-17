// Slack Review: the planning owner's private queue of task suggestions from Slack. Synthetic messages only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { freshDb, q, app, closePool } from "./helpers";
import { issueSession } from "../server/auth";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { _setPlanningTimeoutForTests } from "../server/adapters/planningClient";

const OWNER = "planner@example.test";
const CHANNEL = "C0TESTCHAN1";
const SCAN_KEY = "s".repeat(40);
const SB_BRAND = "aaaaaaaa-1111-4111-8111-111111111111", THAO = "bbbbbbbb-1111-4111-8111-111111111111", OMAR = "bbbbbbbb-2222-4222-8222-222222222222";

// ------------------------------------------------------------ a fake Task Tracker planning API (per-key lock, fence)
type T = { key: string; plan_id: string; origin: string; task_id: string; title: string; brief: string | null; due_date: string; status: string; version: number; updated_at: string; assignee: string; brand: string };
const tracker = { tasks: new Map<string, T>(), creates: 0, bodies: [] as any[], dropAfterCreate: 0, fences: new Map<string, number>(), locks: new Map<string, Promise<void>>(), reset() { this.tasks.clear(); this.creates = 0; this.bodies = []; this.dropAfterCreate = 0; this.fences.clear(); this.locks.clear(); } };
const people: Record<string, { name: string; brands: string[] }> = { [THAO]: { name: "Thao", brands: [SB_BRAND] }, [OMAR]: { name: "Omar", brands: [] } };
let n = 0;
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const out = (t: T) => ({ idempotency_key: t.key, plan_id: t.plan_id, task_id: t.task_id, title: t.title, due_date: t.due_date, status: t.status, completed_on: null, recurring: false,
  brand: { id: t.brand, name: "Succulents Box" }, assignee: { id: t.assignee, name: people[t.assignee]?.name ?? "?" }, version: t.version, updated_at: t.updated_at, open_url: `https://tracker.example.test/#/tasks/${t.task_id}` });
async function fakeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  if (init?.headers?.["x-tracker-planning-key"] !== "p".repeat(40)) return res(401, { error: { code: "unauthorized" } });
  if (u.pathname === "/api/planning/v1/directory") return res(200, { brands: [{ id: SB_BRAND, name: "Succulents Box", business_id: "sb" }], people: Object.entries(people).map(([id, p]) => ({ id, name: p.name, brand_ids: p.brands })) });
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "GET") {
    const keys = (u.searchParams.get("keys") ?? "").split(",");
    return res(200, { items: keys.map((k) => tracker.tasks.get(k)).filter(Boolean).map((t) => out(t!)) });
  }
  if (u.pathname === "/api/planning/v1/tasks" && init.method === "POST") {
    const b = JSON.parse(init.body);
    tracker.bodies.push(b);
    const prev = tracker.locks.get(b.idempotency_key) ?? Promise.resolve();
    let unlock!: () => void;
    tracker.locks.set(b.idempotency_key, prev.then(() => new Promise<void>((r) => { unlock = r; })));
    await prev;
    try {
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
      if (tracker.dropAfterCreate > 0) { tracker.dropAfterCreate--; throw new TypeError("network connection lost"); }
      return res(201, { created: true, task: out(t) });
    } finally { unlock(); }
  }
  return res(404, { error: { code: "not_found" } });
}

// ------------------------------------------------------------ helpers
const cookies: Record<string, string> = {};
async function req(email: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (email) h.cookie = `mkd_session=${(cookies[email] ??= await issueSession({ sub: `sub-${email}`, email }))}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await app(new Request(`http://localhost/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
const owner = (m: string, p: string, b?: unknown) => req(OWNER, m, p, b);
const scan = (m: string, p: string, b?: unknown, key = SCAN_KEY) => req(null, m, p, b, { "x-review-ingest-key": key });
let ts = 1_790_000_000;
const nextTs = () => `${ts++}.000100`;
const msg = (over: Record<string, unknown> = {}) => {
  const t = nextTs();
  return { message_ts: t, action_id: "a1", posted_at: new Date(Number(t.split(".")[0]) * 1000).toISOString(), message_url: `https://example-team.slack.com/archives/${CHANNEL}/p${t.replace(".", "")}`,
    excerpt: "Synthetic: please refresh the holiday gift guide banner before Friday", title: "Refresh the holiday gift guide banner", brief: "Update the banner for the holiday gift guide.", ...over };
};
let batchN = 0;
const OVERLAP = "1700000000.000100";   // starts well before any checkpoint (overlap is allowed)
const batch = (suggestions: any[], over: Record<string, unknown> = {}) => ({ batch_id: `batch-${++batchN}-test`, channel_id: CHANNEL, range: { from_ts: OVERLAP, to_ts: `${ts}.000100` }, checkpoint_ts: `${ts}.000100`, skipped_count: 0, suggestions, ...over });
const first = async () => (await owner("GET", "/review/suggestions?status=all")).body.items;
const fill = async (id: string, over: Record<string, unknown> = {}) => {
  const cur = (await owner("GET", `/review/suggestions/${id}`)).body.suggestion;
  return owner("PATCH", `/review/suggestions/${id}`, { version: cur.version, title: cur.fields.title, brief: cur.fields.brief, business_id: "sb", tracker_brand_id: SB_BRAND, tracker_assignee_id: THAO, due_date: "2026-12-04", ...over });
};

beforeAll(async () => {
  await freshDb();
  process.env.TEAM_MEMBERS += `,${OWNER}:viewer,manager@example.test:admin`;
  process.env.TASK_TRACKER_API_URL = "https://tracker.example.test";
  process.env.TASK_TRACKER_PLANNING_SECRET = "p".repeat(40);
  process.env.SLACK_REVIEW_INGEST_SECRET = SCAN_KEY;
  process.env.SLACK_REVIEW_CHANNEL_ID = CHANNEL;
  _setReportingFetchForTests(fakeFetch as any);
});
afterAll(async () => {
  _setReportingFetchForTests(null);
  for (const k of ["PLANNING_OWNER_EMAIL", "TASK_TRACKER_API_URL", "TASK_TRACKER_PLANNING_SECRET", "SLACK_REVIEW_INGEST_SECRET", "SLACK_REVIEW_CHANNEL_ID"]) delete process.env[k];
  await closePool();
});
beforeEach(() => { tracker.reset(); process.env.PLANNING_OWNER_EMAIL = OWNER; });

describe("scanner intake", () => {
  it("accepts an actionable top-level message and a reply on an older thread; FYIs and completed work are only counted", async () => {
    const top = msg();
    const reply = msg({ thread_ts: "1780000000.000100", thread_url: `https://example-team.slack.com/archives/${CHANNEL}/p1780000000000100`, excerpt: "Synthetic reply: can we also send the wholesale price sheet to the new stockist?", title: "Send the wholesale price sheet to the new stockist", brief: null, deadline_text: "early next week" });
    const r = await scan("POST", "/review-intake/batches", batch([top, reply], { skipped_count: 2 }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ outcome: "accepted", created_count: 2, followup_count: 0, unchanged_count: 0, skipped_count: 2 });
    expect(JSON.stringify(r.body)).not.toContain("Synthetic");             // counts only, no message text
    const items = await first();
    expect(items).toHaveLength(2);
    const rep = items.find((i: any) => i.source.is_reply);
    expect(rep).toMatchObject({ status: "pending", fields: { due_date: null }, source: { deadline_text: "early next week" } });
    expect(rep.needs).toContain('Set the deadline (Slack said: "early next week")');
    expect((await owner("GET", "/review/summary")).body.pending).toBe(2);
    expect((await scan("GET", "/review-intake/checkpoint")).body.checkpoint_ts).toBe(r.body.checkpoint_ts);
  });

  it("rescans, replays and restarts after a partial run never duplicate, and the checkpoint moves only on acceptance", async () => {
    const before = (await first()).length;
    const m = msg();
    const b1 = batch([m]);
    expect((await scan("POST", "/review-intake/batches", b1)).body.created_count).toBe(1);
    const replay = await scan("POST", "/review-intake/batches", b1);                // same batch again (lost answer)
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe("already_accepted");
    const rescan = await scan("POST", "/review-intake/batches", batch([m]));        // a later scan sees it again
    expect(rescan.body).toMatchObject({ created_count: 0, unchanged_count: 1 });
    const cp = (await scan("GET", "/review-intake/checkpoint")).body.checkpoint_ts;
    // A partial run: the next batch is refused (invalid), so the checkpoint stays put; the retry is accepted.
    const bad = batch([{ ...msg(), excerpt: "" }]);
    expect((await scan("POST", "/review-intake/batches", bad)).status).toBe(422);
    expect((await scan("GET", "/review-intake/checkpoint")).body.checkpoint_ts).toBe(cp);
    const retry = batch([msg()]);
    expect((await scan("POST", "/review-intake/batches", retry)).status).toBe(201);
    expect((await scan("GET", "/review-intake/checkpoint")).body.checkpoint_ts).not.toBe(cp);
    // An older checkpoint never moves it backwards.
    const old = await scan("POST", "/review-intake/batches", batch([], { range: { from_ts: OVERLAP, to_ts: "1700000000.000100" }, checkpoint_ts: "1700000000.000100" }));
    expect(Number(old.body.checkpoint_ts)).toBeGreaterThan(1_700_000_000);
    expect((await first()).length).toBe(before + 2);
  });

  it("refuses a batch that would leave a gap after the saved checkpoint, and stores nothing from it", async () => {
    const cp = (await scan("GET", "/review-intake/checkpoint")).body.checkpoint_ts;
    expect(cp).toBeTruthy();
    const before = (await first()).length;
    const after = (d: number) => `${BigInt(cp.split(".")[0]) + BigInt(d)}.000100`;
    // Starts after the checkpoint: the messages in between were never read.
    const gap = batch([msg()], { range: { from_ts: after(5), to_ts: after(10) }, checkpoint_ts: after(10) });
    const r = await scan("POST", "/review-intake/batches", gap);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("checkpoint_gap");
    // No start at all once a checkpoint exists is a gap too.
    const nostart = batch([msg()], { range: { from_ts: null, to_ts: after(10) }, checkpoint_ts: after(10) });
    expect((await scan("POST", "/review-intake/batches", nostart)).status).toBe(409);
    // One microsecond after the checkpoint is still a gap (exact comparison, not floating point).
    const micro = `${cp.split(".")[0]}.${String(Number(cp.split(".")[1]) + 1).padStart(6, "0")}`;
    expect((await scan("POST", "/review-intake/batches", batch([], { range: { from_ts: micro, to_ts: after(10) }, checkpoint_ts: after(10) }))).status).toBe(409);
    expect((await scan("GET", "/review-intake/checkpoint")).body.checkpoint_ts).toBe(cp);
    expect((await first()).length).toBe(before);
    // Starting exactly at the checkpoint is accepted, and so is a retry of the refused batch's id once it is fixed.
    const ok = await scan("POST", "/review-intake/batches", { ...gap, range: { from_ts: cp, to_ts: after(10) } });
    expect(ok.status).toBe(201);
    expect(ok.body.checkpoint_ts).toBe(after(10));
    expect((await first()).length).toBe(before + 1);
  });

  it("a follow-up attaches to its suggestion and never overwrites Emilie's edits or reopens reviewed suggestions", async () => {
    const m = msg({ action_id: "a1" });
    await scan("POST", "/review-intake/batches", batch([m]));
    const s = (await first()).find((i: any) => i.source.message_url === m.message_url);
    await fill(s.id, { title: "Emilie's wording" });
    const key = `slack:${CHANNEL}:${m.message_ts}:a1`;
    const fu = msg({ action_id: "a1", excerpt: "Synthetic follow-up: banner should use the red palette", title: "Scanner retitle attempt", followup_of: key });
    const r = await scan("POST", "/review-intake/batches", batch([fu]));
    expect(r.body).toMatchObject({ created_count: 0, followup_count: 1 });
    const d = (await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion;
    expect(d.fields.title).toBe("Emilie's wording");
    expect(d.source.followups.map((f: any) => f.excerpt)).toEqual(["Synthetic follow-up: banner should use the red palette"]);
    // Dismissed: a later scan of the same message, or another follow-up, does not bring it back.
    await owner("POST", `/review/suggestions/${s.id}/dismiss`, { version: d.version });
    await scan("POST", "/review-intake/batches", batch([m, msg({ action_id: "a1", followup_of: key, excerpt: "Synthetic: any update?" })]));
    expect((await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion.status).toBe("dismissed");
    expect((await first()).filter((i: any) => i.source.message_url === m.message_url)).toHaveLength(1);
  });

  it("the scanner credential can submit only: no queue reads, reviews or task creation; sessions can't submit", async () => {
    const s = (await first())[0];
    for (const [m, p, b] of [["GET", "/review/summary"], ["GET", "/review/suggestions"], ["GET", `/review/suggestions/${s.id}`], ["POST", `/review/suggestions/${s.id}/create`, { version: 1 }],
      ["POST", `/review/suggestions/${s.id}/dismiss`, { version: 1 }], ["PATCH", `/review/suggestions/${s.id}`, { version: 1, title: "x" }], ["GET", "/planning/directory"]] as const)
      expect((await scan(m, p, b as any)).status).toBe(401);
    expect((await scan("POST", "/review-intake/batches", batch([msg()]), "x".repeat(40))).status).toBe(401);
    expect((await req(OWNER, "POST", "/review-intake/batches", batch([msg()]))).status).toBe(401);       // a session is not a scanner key
    expect((await scan("POST", "/review-intake/batches", batch([msg()], { channel_id: "C0OTHERCHAN" }))).status).toBe(403);
    delete process.env.SLACK_REVIEW_INGEST_SECRET;
    expect((await scan("POST", "/review-intake/batches", batch([msg()]))).status).toBe(503);
    process.env.SLACK_REVIEW_INGEST_SECRET = SCAN_KEY;
  });
});

describe("only the planning owner can see the queue", () => {
  it("admins, management, editors and viewers get 404 everywhere, with no count; without the setting nobody has access", async () => {
    const s = (await first())[0];
    const paths: [string, string, unknown?][] = [["GET", "/review/summary"], ["GET", "/review/suggestions?status=all"], ["GET", "/review/suggestions?q=Synthetic"], ["GET", `/review/suggestions/${s.id}`],
      ["PATCH", `/review/suggestions/${s.id}`, { version: 1, title: "x" }], ["POST", `/review/suggestions/${s.id}/preview`], ["POST", `/review/suggestions/${s.id}/create`, { version: 1 }],
      ["POST", `/review/suggestions/${s.id}/dismiss`, { version: 1 }], ["POST", `/review/suggestions/${s.id}/refresh`]];
    for (const who of ["manager@example.test", "admin@example.test", "editor@example.test", "viewer@example.test"])
      for (const [m, p, b] of paths) {
        const r = await req(who, m, p, b);
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/Synthetic|pending|holiday/i);
      }
    expect((await req(null, "GET", "/review/summary")).status).toBe(401);
    expect((await req("manager@example.test", "GET", "/me")).body.planningOwner).toBe(false);
    delete process.env.PLANNING_OWNER_EMAIL;
    expect((await owner("GET", "/review/summary")).status).toBe(404);
  });
});

describe("review and create", () => {
  it("edits use Task Tracker's directory; the preview shows exactly what is sent, with nothing from Slack", async () => {
    await scan("POST", "/review-intake/batches", batch([msg({ title: "Order sample pots", excerpt: "Synthetic: order sample pots from the new supplier" })]));
    const s = (await first()).find((i: any) => i.fields.title === "Order sample pots");
    const bad = await fill(s.id, { tracker_assignee_id: OMAR });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_assignee");
    const ok = await fill(s.id, { brief: "Order three sample pots and share photos.", due_date: "2026-12-04" });
    expect(ok.status).toBe(200);
    expect(ok.body.suggestion.needs).toEqual([]);
    const p = await owner("POST", `/review/suggestions/${s.id}/preview`);
    expect(p.body.send).toEqual({ title: "Order sample pots", brief: "Order three sample pots and share photos.", business: "Succulents Box", brand: "Succulents Box", assignee: "Thao", due_date: "2026-12-04" });
    expect(JSON.stringify(p.body)).not.toContain("Synthetic");
    expect(tracker.creates).toBe(0);
  });

  it("Create task makes one task (origin review, only approved fields); approval and delivery are shown separately", async () => {
    const s = (await first()).find((i: any) => i.fields.title === "Order sample pots");
    const cur = (await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion;
    const rs = await Promise.all([1, 2, 3].map(() => owner("POST", `/review/suggestions/${s.id}/create`, { version: cur.version })));
    expect(rs.every((r) => r.status === 200 || (r.status === 409 && ["sending", "conflict"].includes(r.body.error.code)))).toBe(true);
    expect(tracker.creates).toBe(1);
    const sent = tracker.bodies[0];
    expect(sent).toMatchObject({ idempotency_key: `mkp:${s.id}`, plan_id: s.id, origin: "review", title: "Order sample pots", brief: "Order three sample pots and share photos.", due_date: "2026-12-04", assignee_id: THAO });
    expect(JSON.stringify(sent)).not.toMatch(/Synthetic|slack/i);
    const d = (await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion;
    expect(d).toMatchObject({ status: "approved", delivery: { status: "created" }, task: { status: "open", open_url: expect.stringContaining("/#/tasks/") }, locked: true });
    expect((await fill(s.id)).status).toBe(409);                                    // the task now belongs to Task Tracker
    expect((await owner("POST", `/review/suggestions/${s.id}/dismiss`, { version: d.version })).status).toBe(409);
    // It reaches Marketing Tasks through the normal sync, with only the approved fields.
    const t = [...tracker.tasks.values()][0];
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, assignee_name, status, due_date, created_on, source_updated_at, snapshot_id)
             values ('tracker-test', $1, $2, 'task', 'sb', $3, 'adhoc', 'Succulents Box', 'Thao', 'open', '2026-12-04', '2026-11-17', now(), 'snp_${"0".repeat(32)}')`, [`task:${t.task_id}`, t.task_id, t.title]);
    const tasks = await req("manager@example.test", "GET", "/tasks?view=all&business=sb");
    expect(JSON.stringify(tasks.body)).toContain("Order sample pots");
    expect(JSON.stringify(tasks.body)).not.toMatch(/Synthetic|slack\.com/);
  });

  it("a lost response after Task Tracker created the task: retry links the existing task, no duplicate", async () => {
    await scan("POST", "/review-intake/batches", batch([msg({ title: "Book the photo studio" })]));
    const s = (await first()).find((i: any) => i.fields.title === "Book the photo studio");
    await fill(s.id);
    const v = (await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion.version;
    tracker.dropAfterCreate = 1;
    const firstTry = await owner("POST", `/review/suggestions/${s.id}/create`, { version: v });
    expect(firstTry.body.suggestion.delivery.status).toBe("unknown");
    expect(firstTry.body.suggestion.status).toBe("approved");
    expect((await fill(s.id)).status).toBe(409);                                    // locked until settled
    expect((await owner("POST", `/review/suggestions/${s.id}/dismiss`, { version: firstTry.body.suggestion.version })).status).toBe(409);
    const retry = await owner("POST", `/review/suggestions/${s.id}/create`, { version: firstTry.body.suggestion.version });
    expect(retry.body).toMatchObject({ outcome: "created", existing: true });
    expect(tracker.creates).toBe(1);
  });

  it("an incomplete suggestion can't be created; a refused one can be fixed or dismissed", async () => {
    await scan("POST", "/review-intake/batches", batch([msg({ title: "Reply to the wholesale lead" })]));
    const s = (await first()).find((i: any) => i.fields.title === "Reply to the wholesale lead");
    const inc = await owner("POST", `/review/suggestions/${s.id}/create`, { version: s.version });
    expect(inc.status).toBe(422);
    expect(inc.body.error.code).toBe("incomplete");
    await fill(s.id);
    people[THAO].brands = [];                                                       // Thao loses access before the send
    try {
      const v = (await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion.version;
      const r = await owner("POST", `/review/suggestions/${s.id}/create`, { version: v });
      expect(r.body.suggestion.delivery.status).toBe("failed");
    } finally { people[THAO].brands = [SB_BRAND]; }
    const cur = (await owner("GET", `/review/suggestions/${s.id}`)).body.suggestion;
    expect((await owner("POST", `/review/suggestions/${s.id}/dismiss`, { version: cur.version })).body.suggestion.status).toBe("dismissed");
    expect(tracker.creates).toBe(0);
  });
});
