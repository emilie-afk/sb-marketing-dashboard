// Task Tracker → Marketing Dashboard (one-way pull). Synthetic tracker responses only; no network.
// Checks credential handling, scope, snapshot consistency and retries, atomic publication, keeping the last good
// snapshot, removal markers, read-only enforcement on every dashboard path, recurrence counting and secrets.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { freshDb, call, q, closePool } from "./helpers";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { pullTaskTracker, TT_LIMITS } from "../server/adapters/taskTracker";
import { _setDispatcherForTests, enqueuePull, runJob } from "../server/syncJobs";

const URL_ = "https://tracker.example.test", KEY = "ttr_" + "k".repeat(43);
const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222", T3 = "33333333-3333-4333-8333-333333333333";
const BRAND = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alpha Plants", archived: false };
const PERSON = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Sam Staff", archived: false };
let seen: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
let handler: (url: string) => Response = () => new Response("{}", { status: 404 });

const task = (id: string, over: any = {}) => ({ record_id: `task:${id}`, kind: "task", task_id: id, occurrence_date: null, title: `Task ${id.slice(0, 4)}`, type: "adhoc", business_id: "sb",
  brand: BRAND, assignee: PERSON, recurrence: null, due_date: "2026-11-12", status: "open", completed_on: null, created_on: "2026-11-01",
  source_updated_at: "2026-11-05T01:00:00.000Z", open_url: `${URL_}/#/tasks/${id}`, ...over });
const occ = (id: string, d: string, over: any = {}) => task(id, { record_id: `occ:${id}:${d}`, kind: "occurrence", occurrence_date: d, due_date: d, recurrence: "weekly", title: "Weekly report", ...over });
// Default scope list on the last page: every task in the page's items (recurring ones spanning 2026-01-01 onward).
const scopeOf = (items: any[]) => [...new Map(items.map((i) => [i.task_id, i.kind === "occurrence"
  ? { task_id: i.task_id, recurring: true, first_due: "2026-01-01", until: null } : { task_id: i.task_id, recurring: false, first_due: null, until: null }])).values()];
const page = (items: any[], o: { snap?: string; offset?: number; total?: number; next?: string | null; removals?: any[]; instance?: string; scope?: any[] | null } = {}) => ({
  schema_version: 2, source_instance: o.instance ?? "tracker-test",
  snapshot: { id: o.snap ?? `snp_${"a".repeat(32)}`, generated_at: "2026-11-05T02:00:00.000Z", operational_date: "2026-11-05", timezone: "Asia/Ho_Chi_Minh",
    window: { from: "2026-09-06", to: "2027-01-04" }, total_items: o.total ?? items.length },
  scope: { business_ids: ["sb"] }, items, in_scope_tasks: o.scope !== undefined ? o.scope : (o.next ?? null) === null ? scopeOf(items) : null, removals: o.removals ?? [], page: { offset: o.offset ?? 0, limit: 500, count: items.length }, next_cursor: o.next ?? null,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const records = () => q("select record_id, status, title, removed_at is not null removed, removed_reason from tracker_task_records order by record_id");

beforeAll(async () => { await freshDb(); });
afterAll(closePool);
beforeEach(() => {
  seen = [];
  _setReportingFetchForTests((async (u: any, init: any) => { seen.push({ url: String(u), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), redirect: init?.redirect }); return handler(String(u)); }) as any);
  Object.assign(process.env, { TASK_TRACKER_API_URL: URL_, TASK_TRACKER_REPORTING_SECRET: KEY, TASK_TRACKER_INSTANCE_ID: "tracker-test" });
  delete process.env.TASK_TRACKER_BUSINESSES;
});
afterEach(() => { _setReportingFetchForTests(null); _setDispatcherForTests(null); for (const k of ["TASK_TRACKER_API_URL", "TASK_TRACKER_REPORTING_SECRET", "TASK_TRACKER_INSTANCE_ID", "TASK_TRACKER_BUSINESSES"]) delete process.env[k]; });

describe("pulling", () => {
  it("is off until configured with an https origin and a long secret", async () => {
    delete process.env.TASK_TRACKER_REPORTING_SECRET;
    expect((await pullTaskTracker()).outcome).toBe("not_configured");
    process.env.TASK_TRACKER_REPORTING_SECRET = KEY;
    process.env.TASK_TRACKER_API_URL = "http://tracker.example.test";
    expect((await pullTaskTracker()).outcome).toBe("not_configured");
  });
  it("reads every page of one snapshot with its own header credential and publishes it", async () => {
    handler = (u) => u.includes("cursor=2")
      ? reply(page([occ(T2, "2026-11-10", { status: "done", completed_on: "2026-11-10" })], { offset: 2, total: 3, scope: scopeOf([task(T1), occ(T2, "2026-11-10")]) }))
      : reply(page([task(T1), occ(T2, "2026-11-03", { status: "done", completed_on: "2026-11-03" })], { total: 3, next: "2" }));
    const r = await pullTaskTracker();
    expect(r.outcome).toBe("done");
    expect(seen[0].url).toBe(`${URL_}/api/reporting/v1/tasks?limit=500`);
    expect(seen[1].url).toBe(`${URL_}/api/reporting/v1/tasks?limit=500&snapshot=snp_${"a".repeat(32)}&cursor=2`);
    expect(seen.every((s) => s.headers["x-tracker-reporting-key"] === KEY && !s.url.includes(KEY) && s.redirect === "manual")).toBe(true);
    expect((await records()).map((x: any) => x.record_id)).toEqual([`occ:${T2}:2026-11-03`, `occ:${T2}:2026-11-10`, `task:${T1}`]);
  });
  it("retries are idempotent", async () => {
    await pullTaskTracker();
    const before = await records();
    await pullTaskTracker();
    expect(await records()).toEqual(before);
    expect((await q("select count(*)::int n from tracker_task_records"))[0].n).toBe(3);
  });
  it("restarts when the snapshot changes while paging and never publishes mixed pages", async () => {
    let calls = 0;
    handler = (u) => {
      calls++;
      if (calls === 1) return reply(page([task(T1, { title: "OLD" })], { snap: `snp_${"b".repeat(32)}`, total: 2, next: "1" }));
      if (calls === 2) return reply({ error: { code: "snapshot_changed" } }, 409);
      if (u.includes("cursor=1")) return reply(page([task(T3, { title: "NEW 3" })], { snap: `snp_${"c".repeat(32)}`, offset: 1, total: 2, scope: scopeOf([task(T1), task(T3)]) }));
      return reply(page([task(T1, { title: "NEW 1" })], { snap: `snp_${"c".repeat(32)}`, total: 2, next: "1" }));
    };
    expect((await pullTaskTracker()).outcome).toBe("done");
    const titles = (await q("select title from tracker_task_records where removed_at is null and kind = 'task' order by record_id")).map((x: any) => x.title);
    expect(titles).toEqual(["NEW 1", "NEW 3"]);
    // A page from a different snapshot without a 409 is also refused (restart), then gives up after the retry limit.
    handler = (u) => u.includes("cursor") ? reply(page([task(T3)], { snap: `snp_${"e".repeat(32)}`, offset: 1, total: 2 })) : reply(page([task(T1)], { snap: `snp_${"d".repeat(32)}`, total: 2, next: "1" }));
    await expect(pullTaskTracker()).rejects.toThrow(/kept changing/);
    expect(seen.filter((s) => !s.url.includes("cursor")).length).toBeGreaterThanOrEqual(TT_LIMITS.snapshotRetries);
  });
  it.each([
    ["a failed request", () => reply({}, 500)],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test" } })],
    ["a wrong credential", () => reply({}, 401)],
    ["malformed JSON", () => new Response("{not json", { status: 200 })],
    ["an unknown field", () => reply({ ...page([task(T1)]), extra: true })],
    ["a malformed record", () => reply(page([{ ...task(T1), record_id: "task:not-it" }]))],
    ["a done record without a completion date", () => reply(page([task(T1, { status: "done" })]))],
    ["control characters in a title", () => reply(page([task(T1, { title: "bad\u0007title" })]))],
    ["an incomplete last page", () => reply(page([task(T1)], { total: 5 }))],
    ["a business outside the accepted scope", () => reply(page([task(T1, { business_id: "p2s" })]))],
    ["a different instance than configured", () => reply(page([task(T1)], { instance: "someone-else" }))],
    ["a duplicate record", () => reply(page([task(T1), task(T1)]))],
    ["an oversized page", () => reply(page(Array.from({ length: 501 }, () => task(T1))))],
  ])("keeps the last good snapshot on %s", async (_n, h) => {
    const before = await records();
    handler = h as any;
    await expect(pullTaskTracker()).rejects.toThrow();
    expect(await records()).toEqual(before);
  });
  it("stops at the page limit without publishing, and never treats a missing page as deletions", async () => {
    const before = await records();
    handler = (u) => { const off = Number(/cursor=(\d+)/.exec(u)?.[1] ?? 0); return reply(page([task(T1, { record_id: `task:${T1}` })].slice(0, off ? 0 : 1), { total: 10_000, offset: off, next: String(off + (off ? 0 : 1)) })); };
    await expect(pullTaskTracker()).rejects.toThrow();
    expect(await records()).toEqual(before);
  });
  it("applies removal markers and absences only from a complete snapshot; dashboard tasks are untouched", async () => {
    const own = await call("editor", "POST", "/tasks", { title: "Dashboard-made task", business_id: "sb", status: "todo" });
    expect(own.status).toBe(200);
    handler = () => reply(page([occ(T2, "2026-11-10", { status: "done", completed_on: "2026-11-10" })], { removals: [{ task_id: T1, reason: "deleted" }] }));
    await pullTaskTracker();
    const rows = await records();
    expect(rows.find((r: any) => r.record_id === `task:${T1}`)).toMatchObject({ removed: true, removed_reason: "deleted" });
    expect(rows.find((r: any) => r.record_id === `task:${T3}`)).toMatchObject({ removed: true, removed_reason: "no_longer_reported" });
    expect(rows.find((r: any) => r.record_id === `occ:${T2}:2026-11-10`).removed).toBe(false);
    expect((await q("select count(*)::int n from tasks where title = 'Dashboard-made task'"))[0].n).toBe(1);
    // A removed task disappears from active views but a later snapshot can bring it back.
    const list = await call("viewer", "GET", "/tasks");
    expect(list.body.items.map((t: any) => t.title)).not.toContain(`Task ${T1.slice(0, 4)}`);
    handler = () => reply(page([task(T1, { title: "Back again" }), occ(T2, "2026-11-10", { status: "done", completed_on: "2026-11-10" })]));
    await pullTaskTracker();
    expect((await call("viewer", "GET", "/tasks")).body.items.map((t: any) => t.title)).toContain("Back again");
  });
  it("keeps historical occurrences outside the snapshot window; markers remove all of a task's records", async () => {
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, occurrence_date, business_id, title, task_type, brand_name, assignee_name, recurrence, due_date, status, completed_on, snapshot_id)
             values ('tracker-test', $1, $2, 'occurrence', '2026-06-01', 'sb', 'Old occurrence', 'routine', 'Alpha Plants', 'Sam Staff', 'weekly', '2026-06-01', 'done', '2026-06-01', $3)`,
      [`occ:${T2}:2026-06-01`, T2, `snp_${"a".repeat(32)}`]);
    handler = () => reply(page([task(T1, { title: "Back again" }), occ(T2, "2026-11-10", { status: "done", completed_on: "2026-11-10" })]));
    await pullTaskTracker();
    expect((await records()).find((r: any) => r.record_id === `occ:${T2}:2026-06-01`).removed).toBe(false);
    handler = () => reply(page([task(T1, { title: "Back again" })], { removals: [{ task_id: T2, reason: "brand_unassigned" }] }));
    await pullTaskTracker();
    const t2 = (await records()).filter((r: any) => r.record_id.includes(T2));
    expect(t2.every((r: any) => r.removed && r.removed_reason === "brand_unassigned")).toBe(true);
  });
  it("narrowing the accepted businesses removes records of other businesses", async () => {
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, assignee_name, status, snapshot_id)
             values ('tracker-test', $1, $2, 'task', 'p2s', 'P2S copy', 'adhoc', 'Beta Prints', 'Sam Staff', 'open', $3)`, [`task:${T3}`.replace("3333", "4444"), T3.replace("3333", "4444"), `snp_${"a".repeat(32)}`]);
    handler = () => reply(page([task(T1, { title: "Back again" })]));
    await pullTaskTracker();
    expect((await q("select removed_reason from tracker_task_records where title = 'P2S copy'"))[0].removed_reason).toBe("out_of_scope");
  });
  it("runs through the background job flow and records success or failure on the source", async () => {
    _setDispatcherForTests(async () => {});
    handler = () => reply(page([task(T1, { title: "Back again" })]));
    const j = await enqueuePull("task_tracker", "manual", "admin@example.test");
    expect(j.outcome).toBe("queued");
    const run = await runJob((j as any).job_id);
    expect(run.result.outcome).toBe("succeeded");
    expect((await q("select status from source_connections where id = 'pull.task_tracker'"))[0].status).toBe("ok");
    handler = () => reply({}, 500);
    const j2 = await enqueuePull("task_tracker", "manual", "admin@example.test");
    const run2 = await runJob((j2 as any).job_id);
    expect(run2.result.outcome).toBe("failed");
    const src = (await q("select status, last_error from source_connections where id = 'pull.task_tracker'"))[0];
    expect(src.status).toBe("failing");
    expect(src.last_error).not.toContain(KEY);
    expect((await q("select count(*)::int n from tracker_task_records where removed_at is null"))[0].n).toBeGreaterThan(0);
  });
});

describe("dashboard views", () => {
  beforeAll(async () => {
    await q("delete from tracker_task_records");
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, occurrence_date, business_id, title, task_type, brand_name, brand_archived, assignee_name, assignee_archived, recurrence, due_date, status, completed_on, snapshot_id)
      select 'tracker-test', 'occ:' || $1 || ':' || d::date, $1::uuid, 'occurrence', d::date, 'sb', 'Weekly report', 'routine', 'Alpha Plants', true, 'Sam Staff', false, 'weekly', d::date,
             case when d::date < current_date then 'done' else 'open' end, case when d::date < current_date then d::date end, $2
        from generate_series(current_date - 14, current_date + 14, interval '7 days') d`, [T2, `snp_${"a".repeat(32)}`]);
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, assignee_name, status, due_date, snapshot_id)
             values ('tracker-test', $1, $2, 'task', 'sb', '<img src=x onerror=alert(1)>', 'adhoc', 'Alpha Plants', 'Sam Staff', 'open', current_date + 2, $3)`, [`task:${T1}`, T1, `snp_${"a".repeat(32)}`]);
  });
  it("lists tracker tasks read-only with an Open in Task Tracker link built from the configured origin", async () => {
    const r = await call("viewer", "GET", "/tasks");
    const tr = r.body.items.filter((t: any) => t.source === "tracker");
    expect(tr.length).toBeGreaterThanOrEqual(5);
    expect(tr.every((t: any) => t.read_only === true && t.id.startsWith("tracker:") && t.open_url?.startsWith(`${URL_}/#/tasks/`))).toBe(true);
    expect(tr.find((t: any) => t.title.startsWith("<img"))).toBeDefined();          // stored and returned as text
    const own = r.body.items.filter((t: any) => t.source === "dashboard");
    expect(own.every((t: any) => t.read_only === false)).toBe(true);
    const d = await call("viewer", "GET", `/tasks/${encodeURIComponent(tr[0].id)}`);
    expect(d.status).toBe(200);
    expect(d.body.read_only).toBe(true);
    expect(d.body.task.brand_archived).toBe(true);
  });
  it("counts each occurrence once and never a whole series", async () => {
    const r = await call("viewer", "GET", "/tasks");
    const weekly = r.body.items.filter((t: any) => t.title === "Weekly report");
    expect(new Set(weekly.map((t: any) => t.occurrence)).size).toBe(weekly.length);
    expect(weekly.filter((t: any) => t.status === "done").length).toBe(2);
    const o = await call("viewer", "GET", "/business/sb/summary");
    const done = o.body.work.recentlyCompleted.filter((t: any) => t.title === "Weekly report");
    expect(done.length).toBe(2);
  });
  it("shows dated tracker records on the calendar", async () => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const r = await call("viewer", "GET", `/calendar?from=${today}&to=${today.slice(0, 8)}28&types=task`);
    expect(r.body.items.some((i: any) => i.source === "tracker" && i.read_only)).toBe(true);
  });
  it("refuses every dashboard mutation of a tracker record, for every role", async () => {
    const id = (await call("viewer", "GET", "/tasks")).body.items.find((t: any) => t.source === "tracker").id;
    for (const role of ["editor", "admin"] as const) {
      expect((await call(role, "PATCH", `/tasks/${encodeURIComponent(id)}`, { status: "done", version: 1 })).status).toBe(403);
      expect((await call(role, "PATCH", `/tasks/${encodeURIComponent(id)}`, { comment: "x", version: 1 })).status).toBe(403);
      expect((await call(role, "PATCH", `/tasks/${encodeURIComponent(id)}/occurrences/2026-11-10`, { status: "done" })).status).toBe(403);
      const fd = new FormData(); fd.set("owner_type", "task"); fd.set("owner_id", id); fd.set("file", new File(["x"], "a.csv", { type: "text/csv" }));
      expect((await call(role, "POST", "/attachments", fd)).status).toBe(403);
    }
    expect((await call("viewer", "PATCH", `/tasks/${encodeURIComponent(id)}`, { status: "done", version: 1 })).status).toBe(403);
    const before = await q("select status, title from tracker_task_records order by record_id");
    expect(await q("select status, title from tracker_task_records order by record_id")).toEqual(before);
  });
  it("dashboard-created tasks stay editable", async () => {
    const t = (await call("viewer", "GET", "/tasks")).body.items.find((x: any) => x.source === "dashboard");
    expect((await call("editor", "PATCH", `/tasks/${t.id}`, { status: "done", version: t.version })).status).toBe(200);
  });
  it("tracker membership grants no dashboard access", async () => {
    // Only TEAM_MEMBERS decides dashboard access; a tracker assignee name or email gives nothing.
    expect((await call("outsider", "GET", "/tasks")).status).toBe(401);
  });
  it("never exposes the tracker secret in API output or source status", async () => {
    await call("admin", "GET", "/settings").then((r) => expect(JSON.stringify(r.body)).not.toContain(KEY));
    expect(JSON.stringify((await call("viewer", "GET", "/tasks")).body)).not.toContain(KEY);
  });
});
