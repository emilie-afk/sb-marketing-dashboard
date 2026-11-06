// Regression tests for review findings on the Task Tracker pull: reconciliation after long sync gaps (3),
// the overall deadline (4) and per-record ownership from the tracker (1). Synthetic responses only; no network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { freshDb, call, q, closePool } from "./helpers";
import { _setReportingFetchForTests } from "../server/adapters/reportingClient";
import { pullTaskTracker, TT_LIMITS, _setPublishHooksForTests } from "../server/adapters/taskTracker";
import { _setDispatcherForTests, enqueuePull, runJob } from "../server/syncJobs";

const URL_ = "https://tracker.example.test", KEY = "ttr_" + "k".repeat(43);
const X = "11111111-1111-4111-8111-111111111111", Y = "22222222-2222-4222-8222-222222222222", Z = "33333333-3333-4333-8333-333333333333";
const BRAND = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alpha Plants", archived: false };
const ANN = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Ann Original", archived: true };
const BEN = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Ben Replacement", archived: false };
const SNAP = `snp_${"a".repeat(32)}`;
const occ = (id: string, d: string, over: any = {}) => ({ record_id: `occ:${id}:${d}`, kind: "occurrence", task_id: id, occurrence_date: d, title: "Weekly report", type: "routine",
  business_id: "sb", brand: BRAND, assignee: BEN, recurrence: "weekly", due_date: d, status: "open", completed_on: null, created_on: "2026-01-01",
  source_updated_at: "2026-11-05T01:00:00.000Z", open_url: `${URL_}/#/tasks/${id}`, ...over });
const one = (id: string, over: any = {}) => ({ ...occ(id, "2026-11-12"), record_id: `task:${id}`, kind: "task", occurrence_date: null, recurrence: null, title: "One-off", ...over });
const page = (items: any[], o: { scope?: any[] | null; next?: string | null; offset?: number; total?: number; removals?: any[] } = {}) => ({
  schema_version: 2, source_instance: "tracker-test",
  snapshot: { id: SNAP, generated_at: "2026-11-10T02:00:00.000Z", operational_date: "2026-11-10", timezone: "Asia/Ho_Chi_Minh", window: { from: "2026-09-11", to: "2027-01-09" }, total_items: o.total ?? items.length },
  scope: { business_ids: ["sb"] }, items, in_scope_tasks: o.scope === undefined ? null : o.scope, removals: o.removals ?? [],
  page: { offset: o.offset ?? 0, limit: 500, count: items.length }, next_cursor: o.next ?? null,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const insert = (record_id: string, task_id: string, kind: string, d: string | null, over: Record<string, unknown> = {}) => q(
  `insert into tracker_task_records (source_instance, record_id, task_id, kind, occurrence_date, business_id, title, task_type, brand_name, assignee_name, recurrence, due_date, status, completed_on, snapshot_id)
   values ('tracker-test', $1, $2, $3, $4, 'sb', $5, 'routine', 'Alpha Plants', 'Ann Original', $6, $4, $7, $8, $9)`,
  [record_id, task_id, kind, d, over.title ?? "Stored copy", kind === "task" ? null : "weekly", over.status ?? "done", over.status === "open" ? null : d ?? "2026-01-01", SNAP]);
const state = () => q("select record_id, removed_at is not null removed, removed_reason, assignee_name, status from tracker_task_records order by record_id");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let handler: (url: string, init: any) => Promise<Response> = async () => reply({}, 404);

beforeAll(async () => { await freshDb(); });
afterAll(closePool);
beforeEach(() => {
  _setReportingFetchForTests(((u: any, init: any) => handler(String(u), init)) as any);
  Object.assign(process.env, { TASK_TRACKER_API_URL: URL_, TASK_TRACKER_REPORTING_SECRET: KEY, TASK_TRACKER_INSTANCE_ID: "tracker-test" });
});
afterEach(() => {
  _setReportingFetchForTests(null); _setPublishHooksForTests(null); _setDispatcherForTests(null);
  TT_LIMITS.overallMs = 120_000;
  for (const k of ["TASK_TRACKER_API_URL", "TASK_TRACKER_REPORTING_SECRET", "TASK_TRACKER_INSTANCE_ID"]) delete process.env[k];
});

describe("3. reconnecting after more than 180 days", () => {
  it("removes every copy of tasks no longer in scope, including old occurrences outside the window, and keeps legitimate history", async () => {
    // Copies synced long ago. X was later deleted in the tracker (its removal marker has since expired).
    await insert(`occ:${X}:2026-01-05`, X, "occurrence", "2026-01-05");
    await insert(`occ:${X}:2026-10-05`, X, "occurrence", "2026-10-05");
    await insert(`task:${Z}`, Z, "task", null, { status: "open" });
    // Y is still reported; it has history outside the window, and one copy dated before its (edited) first due date.
    await insert(`occ:${Y}:2026-02-02`, Y, "occurrence", "2026-02-02");
    await insert(`occ:${Y}:2025-12-29`, Y, "occurrence", "2025-12-29");
    handler = async () => reply(page([occ(Y, "2026-11-16")], { scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }], removals: [] }));
    expect((await pullTaskTracker()).outcome).toBe("done");
    const rows = Object.fromEntries((await state()).map((r: any) => [r.record_id, r]));
    expect(rows[`occ:${X}:2026-01-05`]).toMatchObject({ removed: true, removed_reason: "no_longer_reported" });
    expect(rows[`occ:${X}:2026-10-05`]).toMatchObject({ removed: true });
    expect(rows[`task:${Z}`]).toMatchObject({ removed: true, removed_reason: "no_longer_reported" });
    expect(rows[`occ:${Y}:2026-02-02`].removed).toBe(false);                      // legitimate history, outside the window
    expect(rows[`occ:${Y}:2025-12-29`]).toMatchObject({ removed: true, removed_reason: "not_in_snapshot" });
    // Removed copies are gone from dashboard views.
    const items = (await call("viewer", "GET", "/tasks?from=2025-12-01&to=2027-01-31")).body.items.filter((t: any) => t.source === "tracker");
    expect(items.map((t: any) => t.occurrence ?? t.id).sort()).toEqual(["2026-02-02", "2026-11-16"]);
    const cal = (await call("viewer", "GET", "/calendar?from=2026-01-01&to=2026-01-31&types=task")).body.items;
    expect(cal.some((i: any) => i.source === "tracker")).toBe(false);
  });
  it("a removal reason is applied when the tracker still sends one", async () => {
    handler = async () => reply(page([], { scope: [], removals: [{ task_id: Y, reason: "brand_unassigned" }] }));
    await pullTaskTracker();
    const y = (await state()).filter((r: any) => r.record_id.includes(Y));
    expect(y.every((r: any) => r.removed && r.removed_reason === "brand_unassigned")).toBe(true);
  });
  it("a failed or incomplete read never reconciles", async () => {
    await q("update tracker_task_records set removed_at = null, removed_reason = null where task_id = $1", [Y]);
    const before = await state();
    handler = async (u) => (u.includes("cursor") ? reply({}, 500) : reply(page([], { next: "0", total: 1 })));
    await expect(pullTaskTracker()).rejects.toThrow();
    handler = async () => reply(page([], { scope: null }));                       // last page without its scope list
    await expect(pullTaskTracker()).rejects.toThrow(/scope list/);
    handler = async () => reply(page([occ(Y, "2026-11-16")], { scope: [] }));     // record outside its own scope list
    await expect(pullTaskTracker()).rejects.toThrow(/outside its own scope/);
    expect(await state()).toEqual(before);
  });
});

describe("4. the overall deadline", () => {
  const good = () => reply(page([occ(Y, "2026-11-23")], { scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }] }));
  /** Waits for `ms`, honoring the abort signal like a real transport. */
  const wait = (ms: number, init: any) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });

  it("delayed headers time out and leave the previous snapshot unchanged", async () => {
    const before = await state();
    TT_LIMITS.overallMs = 60;
    handler = async (_u, init) => { await wait(400, init); return good(); };
    const t0 = Date.now();
    await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(await state()).toEqual(before);
  });
  it("a stalled body times out and leaves the previous snapshot unchanged", async () => {
    const before = await state();
    TT_LIMITS.overallMs = 60;
    handler = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"schema_version":2,')); } }), { status: 200 });
    await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    expect(await state()).toEqual(before);
  });
  it("a final page arriving after the deadline is discarded, even if the transport ignores the abort", async () => {
    const before = await state();
    TT_LIMITS.overallMs = 80;
    handler = async (u) => {
      if (!u.includes("cursor")) return reply(page([occ(Y, "2026-11-23")], { next: "1", total: 2 }));
      await sleep(150);                                                           // ignores the abort signal
      return reply(page([occ(Y, "2026-11-30")], { offset: 1, total: 2, scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }] }));
    };
    await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    await sleep(120);
    expect(await state()).toEqual(before);
  });
  it("publication never starts after the deadline", async () => {
    const before = await state();
    const snapshots = (await q("select count(*)::int n from tracker_snapshots"))[0].n;
    TT_LIMITS.overallMs = 50;
    handler = async () => good();
    _setPublishHooksForTests({ beforePublish: () => sleep(80) });
    await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    expect(await state()).toEqual(before);
    expect((await q("select count(*)::int n from tracker_snapshots"))[0].n).toBe(snapshots);
  });
  it("a deadline passing during publication rolls the whole publication back", async () => {
    const before = await state();
    TT_LIMITS.overallMs = 50;
    handler = async () => good();
    _setPublishHooksForTests({ beforeCommit: () => sleep(80) });
    await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    expect(await state()).toEqual(before);
  });
  it("a slow final database insert (the snapshot record) is cancelled by the budget and nothing persists", async () => {
    const before = await state();
    const snapshots = (await q("select count(*)::int n from tracker_snapshots"))[0].n;
    // Delay the real final write of publication, not a test hook.
    await q(`create or replace function slow_snapshot_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return new; end $$`);
    await q("create trigger slow_snapshot_insert before insert on tracker_snapshots for each row execute function slow_snapshot_insert()");
    try {
      TT_LIMITS.overallMs = 150;
      handler = async () => reply(page([occ(Y, "2026-12-07")], { scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }] }));
      const t0 = Date.now();
      await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
      expect(Date.now() - t0).toBeLessThan(400);                 // cancelled by the server, not waited out
      await sleep(400);                                           // nothing can commit later either
      expect(await state()).toEqual(before);
      expect((await q("select count(*)::int n from tracker_task_records where record_id = $1", [`occ:${Y}:2026-12-07`]))[0].n).toBe(0);
      expect((await q("select count(*)::int n from tracker_snapshots"))[0].n).toBe(snapshots);
    } finally {
      await q("drop trigger if exists slow_snapshot_insert on tracker_snapshots");
      await q("drop function if exists slow_snapshot_insert()");
    }
  });
  it("a slow task-copy write and a blocked publication lock are bounded by the same budget", async () => {
    const before = await state();
    await q(`create or replace function slow_copy_write() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return new; end $$`);
    await q("create trigger slow_copy_write before insert or update on tracker_task_records for each row execute function slow_copy_write()");
    try {
      TT_LIMITS.overallMs = 150;
      handler = async () => reply(page([occ(Y, "2026-12-14")], { scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }] }));
      await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    } finally {
      await q("drop trigger if exists slow_copy_write on tracker_task_records");
      await q("drop function if exists slow_copy_write()");
    }
    expect(await state()).toEqual(before);
    // Another publisher holds the lock: publication gives up when the budget runs out instead of waiting.
    const { getPool } = await import("../server/db");
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('tracker_task_records'))");
      TT_LIMITS.overallMs = 150;
      const t0 = Date.now();
      await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
      expect(Date.now() - t0).toBeLessThan(400);
    } finally {
      await holder.query("rollback"); holder.release();
    }
    expect(await state()).toEqual(before);
  });
  it("publication within the budget still succeeds", async () => {
    TT_LIMITS.overallMs = 5_000;
    handler = async () => reply(page([occ(Y, "2026-11-23")], { scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }] }));
    expect((await pullTaskTracker()).outcome).toBe("done");
  });
  it("snapshot retries are bounded by the same deadline", async () => {
    TT_LIMITS.overallMs = 60;
    let calls = 0;
    handler = async (_u, init) => { calls++; await wait(25, init); return reply({ error: { code: "snapshot_changed" } }, 409); };
    await expect(pullTaskTracker()).rejects.toMatchObject({ code: "source_timeout" });
    expect(calls).toBeLessThanOrEqual(3);
  });
  it("a late read is recorded as a failed job, never as success", async () => {
    _setDispatcherForTests(async () => {});
    TT_LIMITS.overallMs = 40;
    handler = async (_u, init) => { await wait(200, init); return good(); };
    const j = await enqueuePull("task_tracker", "manual", "admin@example.test");
    const r = await runJob((j as any).job_id);
    expect(r.result.outcome).toBe("failed");
    expect((await q("select status from source_connections where id = 'pull.task_tracker'"))[0].status).toBe("failing");
  });
});

describe("1. ownership comes from the tracker per record", () => {
  it("past occurrences keep their original owner after a reassignment; the dashboard does not re-attribute them", async () => {
    handler = async () => reply(page([
      occ(Y, "2026-11-09", { status: "done", completed_on: "2026-11-09", assignee: ANN }),
      occ(Y, "2026-11-16", { assignee: BEN }),
    ], { scope: [{ task_id: Y, recurring: true, first_due: "2026-01-05", until: null }] }));
    expect((await pullTaskTracker()).outcome).toBe("done");
    const items = (await call("viewer", "GET", "/tasks?from=2026-11-01&to=2026-11-30")).body.items.filter((t: any) => t.source === "tracker");
    expect(items.map((t: any) => [t.occurrence, t.owner, t.owner_archived, t.status])).toEqual(expect.arrayContaining([
      ["2026-11-09", "Ann Original", true, "done"], ["2026-11-16", "Ben Replacement", false, "todo"]]));
    // Filtering by owner credits Ann's completed week to Ann only.
    const ben = (await call("viewer", "GET", `/tasks?owner=${encodeURIComponent("Ben Replacement")}&from=2026-11-01&to=2026-11-30`)).body.items.filter((t: any) => t.source === "tracker");
    expect(ben.every((t: any) => t.status === "todo")).toBe(true);
  });
});
