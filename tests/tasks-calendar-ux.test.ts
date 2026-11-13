import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, q, closePool } from "./helpers";
import { listTasks, type TaskFilters, mondayOf } from "../server/taskQuery";
import { occasionAgenda } from "../server/routes/gifts";
import { addDays } from "../shared/dates";
import { taskLinkParams } from "../src/pages/Tasks";

// A fixed "today" (a Thursday) keeps the views deterministic.
const TODAY = "2027-03-11";
const MON = mondayOf(TODAY);   // 2027-03-08
const base: TaskFilters = { view: "needs_attention", business: null, assignees: [], q: null, status: [], activity: [], source: [], kind: null, from: null, to: null };
const f = (o: Partial<TaskFilters>) => ({ ...base, ...o });
const titles = async (o: Partial<TaskFilters>) => (await listTasks(f(o), TODAY)).items.map((t) => `${t.title}${t.occurrence ? `@${t.occurrence}` : ""}`);
let seriesId = "";

beforeAll(async () => {
  await freshDb();
  const mk = async (b: any) => (await call("editor", "POST", "/tasks", b)).body.id;
  await mk({ title: "Overdue one-off", business_id: "sb", owner: "Thao Nguyen", due_date: addDays(TODAY, -3) });
  await mk({ title: "Very old overdue one-off", business_id: "sb", owner: "Thao Nguyen", due_date: addDays(TODAY, -400) });
  await mk({ title: "Due today", business_id: "p2s", owner: "Van Nguyen", due_date: TODAY });
  await mk({ title: "Earlier this week, done", business_id: "sb", owner: "Thao Nguyen", status: "done", due_date: MON });
  await mk({ title: "Later this week", business_id: "sb", due_date: addDays(MON, 6) });
  await mk({ title: "Next month", business_id: "sb", owner: "Thao Nguyen", due_date: addDays(TODAY, 40) });
  await mk({ title: "No date", business_id: "sb", owner: "Thao Nguyen" });
  await mk({ title: "Cancelled one", business_id: "sb", owner: "Thao Nguyen", status: "cancelled", due_date: addDays(TODAY, -1) });
  // Weekly routine on Mondays owned by Thao; one occurrence is reassigned to Van and another is done.
  seriesId = await mk({ title: "Weekly social schedule", business_id: "sb", owner: "Thao Nguyen", due_date: "2027-02-01", recurrence: "weekly:1" });
  await call("editor", "PATCH", `/tasks/${seriesId}/occurrences/2027-03-01`, { status: "in_progress", owner: "Van Nguyen" });
  await call("editor", "PATCH", `/tasks/${seriesId}/occurrences/2027-03-08`, { status: "done" });
  // Completion times as they would have been recorded on those days (the API stamps the real clock).
  await q("update task_occurrences set completed_at = '2027-03-08T10:00:00+07:00' where task_id = $1 and due_date = '2027-03-08'", [seriesId]);
  await q("update tasks set completed_at = '2027-03-10T09:00:00+07:00' where title = 'Earlier this week, done'");
  // Read-only Task Tracker records for the same people.
  const snap = `snp_${"1".repeat(32)}`;
  await q(`insert into tracker_snapshots (source_instance, snapshot_id, generated_at, window_from, window_to, record_count, removal_count, marked_removed)
           values ('tt-test', $1, now(), '2027-01-01', '2027-06-30', 3, 0, 0)`, [snap]);
  const rec = (id: string, kind: string, occ: string | null, title: string, owner: string, due: string | null, status: string, done: string | null = null) =>
    q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, occurrence_date, business_id, title, task_type, brand_name, assignee_name, recurrence, due_date, status, completed_on, snapshot_id)
       values ('tt-test', $1, $2, $3, $4, 'sb', $5, $6, 'Succulents Box', $7, $8, $9, $10, $11, $12)`,
      [kind === "task" ? `task:${id}` : `occ:${id}:${occ}`, id, kind, occ, title, kind === "task" ? "adhoc" : "routine", owner, kind === "task" ? null : "weekly", due, status, done, snap]);
  await rec("22222222-2222-4222-8222-222222222222", "task", null, "Tracker overdue for Thao", "Thao Nguyen", addDays(TODAY, -2), "open");
  await rec("33333333-3333-4333-8333-333333333333", "occurrence", "2027-03-02", "Tracker routine", "Van Nguyen", "2027-03-02", "open");
  await rec("33333333-3333-4333-8333-333333333333", "occurrence", "2027-02-23", "Tracker routine", "Van Nguyen", "2027-02-23", "open");
  await rec("33333333-3333-4333-8333-333333333333", "occurrence", "2027-03-09", "Tracker routine", "Former Teammate", "2027-03-09", "done", "2027-03-10");
});
afterAll(closePool);

describe("Marketing Tasks views", () => {
  it("Needs attention: open tasks overdue or due today from both sources, however old the one-off", async () => {
    const t = await titles({});
    expect(t).toEqual(expect.arrayContaining(["Overdue one-off", "Very old overdue one-off", "Due today", "Tracker overdue for Thao", "Tracker routine@2027-02-23", "Tracker routine@2027-03-02",
      "Weekly social schedule@2027-02-01", "Weekly social schedule@2027-03-01"]));
    expect(t).not.toContain("Weekly social schedule@2027-03-08");   // done occurrence
    expect(t).not.toContain("Cancelled one");
    expect(t).not.toContain("Later this week");
  });
  it("applies assignee and status after each recurring occurrence takes its own values", async () => {
    const van = await titles({ assignees: ["Van Nguyen"] });
    expect(van).toContain("Weekly social schedule@2027-03-01");      // reassigned occurrence follows Van, not the series owner
    expect(van).not.toContain("Weekly social schedule@2027-02-01");
    const thao = await titles({ assignees: ["Thao Nguyen"] });
    expect(thao).not.toContain("Weekly social schedule@2027-03-01");
    expect(thao).toContain("Weekly social schedule@2027-02-01");
    expect(await titles({ status: ["in_progress"] })).toEqual(["Weekly social schedule@2027-03-01"]);
    const done = await titles({ view: "completed", assignees: ["Thao Nguyen"] });
    expect(done).toContain("Weekly social schedule@2027-03-08");
  });
  it("both sources follow the same filters, and Unassigned is selectable", async () => {
    expect(await titles({ assignees: ["Thao Nguyen"], source: ["tracker"] })).toEqual(["Tracker overdue for Thao"]);
    expect(await titles({ view: "this_week", assignees: ["__unassigned__"] })).toEqual(["Later this week"]);
    expect(await titles({ q: "tracker routine" })).toEqual(["Tracker routine@2027-02-23", "Tracker routine@2027-03-02"]);
    expect(await titles({ kind: "oneoff", business: "p2s" })).toEqual(["Due today"]);
  });
  it("This week covers Monday–Sunday, including earlier days, and counts match the views", async () => {
    const r = await listTasks(f({ view: "this_week" }), TODAY);
    expect(r.window.week).toEqual({ from: "2027-03-08", to: "2027-03-14" });
    expect(r.items.map((t) => t.title)).toEqual(expect.arrayContaining(["Due today", "Later this week"]));
    expect(r.items.map((t) => t.title)).not.toContain("Earlier this week, done");   // done is not open
    expect(r.counts.this_week).toBe(r.items.length);
    expect(r.counts.needs_attention).toBe((await listTasks(f({}), TODAY)).items.length);
  });
  it("Upcoming starts after this week and can look further ahead", async () => {
    expect(await titles({ view: "upcoming" })).toEqual(expect.arrayContaining(["Weekly social schedule@2027-03-15"]));
    expect(await titles({ view: "upcoming" })).not.toContain("Next month");
    const further = await listTasks(f({ view: "upcoming", to: addDays(TODAY, 60) }), TODAY);
    expect(further.items.map((t) => t.title)).toContain("Next month");
  });
  it("Completed lists most recent first and marks a due-date fallback", async () => {
    const r = await listTasks(f({ view: "completed" }), TODAY);
    expect(r.items[0]).toMatchObject({ title: "Earlier this week, done", completed_on: "2027-03-10", completed_basis: "completion" });
    const tracker = r.items.find((t) => t.title === "Tracker routine");
    expect(tracker).toMatchObject({ completed_on: "2027-03-10", completed_basis: "completion", owner: "Former Teammate" });
    expect(r.items.every((t, i) => i === 0 || (r.items[i - 1].completed_on ?? "") >= (t.completed_on ?? ""))).toBe(true);
  });
  it("All tasks includes undated tasks; cancelled only through the status filter", async () => {
    expect(await titles({ view: "all" })).toContain("No date");
    expect(await titles({ view: "all" })).not.toContain("Cancelled one");
    expect(await titles({ view: "all", status: ["cancelled"] })).toEqual(["Cancelled one"]);
  });
  it("keeps historical assignees discoverable and explains the Task Tracker history window", async () => {
    const r = await listTasks(f({ view: "completed" }), TODAY);
    expect(r.assignees.map((a) => a.name)).toContain("Former Teammate");
    const all = await listTasks(f({ view: "all", from: "2026-12-01" }), TODAY);
    expect(all.trackerHistoryNote).toMatch(/available from 2027-01-01/);
  });
  it("serves the same results through the API, and stays read-only for viewers and for Task Tracker tasks", async () => {
    const r = await call("viewer", "GET", "/tasks?view=all&assignee=Thao%20Nguyen&source=tracker");
    expect(r.status).toBe(200);
    expect(r.body.items.every((t: any) => t.source === "tracker" && t.read_only)).toBe(true);
    expect((await call("viewer", "GET", "/tasks?view=nope")).status).toBe(400);
    expect((await call("viewer", "PATCH", `/tasks/${seriesId}/occurrences/2027-03-15`, { status: "done" })).status).toBe(403);
    const trackerId = encodeURIComponent("tracker:tt-test:task:22222222-2222-4222-8222-222222222222");
    expect((await call("editor", "PATCH", `/tasks/${trackerId}`, { status: "done", version: 1 })).status).toBe(403);
  });

  it("gives each recurring occurrence its own link, and its drawer shows that occurrence's assignee, status and date", async () => {
    const rows = (await listTasks(f({ view: "all", q: "Weekly social" }), TODAY)).items;
    const a = rows.find((t) => t.occurrence === "2027-03-01")!, b = rows.find((t) => t.occurrence === "2027-03-15")!;
    expect(taskLinkParams(a)).toEqual({ task: seriesId, occ: "2027-03-01" });
    expect(new URLSearchParams(taskLinkParams(a) as any).toString()).not.toBe(new URLSearchParams(taskLinkParams(b) as any).toString());
    // One-off and Task Tracker rows keep a plain task link.
    const tracker = (await listTasks(f({ view: "all", source: ["tracker"] }), TODAY)).items.find((t) => t.occurrence)!;
    expect(taskLinkParams(tracker).occ).toBeNull();

    const reassigned = (await call("viewer", "GET", `/tasks/${seriesId}?occurrence=2027-03-01`)).body;
    expect(reassigned.occurrence).toMatchObject({ due_date: "2027-03-01", owner: "Van Nguyen", status: "in_progress", owner_is_series_owner: false });
    expect(reassigned.occurrence.owner).toBe(a.owner);
    expect(reassigned.occurrence.status).toBe(a.status);
    const untouched = (await call("viewer", "GET", `/tasks/${seriesId}?occurrence=2027-03-15`)).body;
    expect(untouched.occurrence).toMatchObject({ due_date: "2027-03-15", owner: "Thao Nguyen", status: "todo", owner_is_series_owner: true });
    const done = (await call("viewer", "GET", `/tasks/${seriesId}?occurrence=2027-03-08`)).body;
    expect(done.occurrence.status).toBe("done");
    expect(done.occurrence.completed_at).toBeTruthy();
    // Without the date the series is returned as before; a date that isn't an occurrence is refused.
    expect((await call("viewer", "GET", `/tasks/${seriesId}`)).body.occurrence).toBeNull();
    expect((await call("viewer", "GET", `/tasks/${seriesId}?occurrence=2027-03-02`)).status).toBe(404);
    expect((await call("viewer", "GET", `/tasks/${seriesId}?occurrence=2027-3-1`)).status).toBe(404);
  });
});

describe("Upcoming occasions agenda", () => {
  it("lists gift and spreadsheet occasions in date order; a shared occasion shows once with both brands", async () => {
    const rows = await occasionAgenda("2027-02-01", "2027-02-28", null, "all", true);
    const v = rows.filter((r) => r.title === "Valentine’s Day");
    expect(v).toHaveLength(1);
    expect(v[0].brands).toEqual(["p2s", "sb"]);
    for (const b of ["sb", "p2s"]) expect((await occasionAgenda("2027-02-01", "2027-02-28", b, "all", true)).map((r) => r.title)).toContain("Valentine’s Day");
    expect(rows.map((r) => r.start)).toEqual([...rows.map((r) => r.start)].sort());
  });
  it("includes seasonal windows already in progress, with the lead-in kept separate, and hides them on request", async () => {
    const rows = await occasionAgenda("2027-05-20", "2027-08-17", null, "gift", true);
    const sw = rows.find((r) => r.occasionId === "spring-weddings");
    expect(sw).toMatchObject({ start: "2027-05-01", end: "2027-06-30", inProgress: true, leadIn: "Start the campaign in April", monthLabel: "May–June" });
    expect((await occasionAgenda("2027-05-20", "2027-08-17", null, "gift", false)).find((r) => r.occasionId === "spring-weddings")).toBeUndefined();
  });
  it("shows unconfirmed dates under their expected month", async () => {
    const rows = await occasionAgenda("2026-04-01", "2026-04-30", null, "gift", true);
    expect(rows.find((r) => r.occasionId === "national-volunteer-week")).toMatchObject({ tbc: true, start: "2026-04-01" });
  });
  it("lists linked promotions for that occurrence and merges a spreadsheet occasion reported for two businesses", async () => {
    await call("editor", "POST", "/promotions", { business_id: "p2s", title: "Valentine portraits", start_date: "2027-01-25", end_date: "2027-02-13", gift_occasion_id: "valentines-day", gift_occasion_year: 2027 });
    await q(`insert into occasions (business_id, identity_key, name, occasion_date, occasion_type) values ('sb','t:1','Lunar New Year','2027-02-06','holiday'), ('p2s','t:2','Lunar New Year','2027-02-06','holiday')`);
    const rows = await occasionAgenda("2027-02-01", "2027-02-28", null, "all", true);
    expect(rows.find((r) => r.title === "Valentine’s Day")!.promotions.map((p: any) => p.title)).toEqual(["Valentine portraits"]);
    const lny = rows.filter((r) => r.title === "Lunar New Year");
    expect(lny).toHaveLength(1);
    expect(lny[0].kind).toBe("sheet");
    expect([...lny[0].brands].sort()).toEqual(["p2s", "sb"]);
    expect((await occasionAgenda("2027-02-01", "2027-02-28", null, "sheet", true)).every((r) => r.kind === "sheet")).toBe(true);
    const api = await call("viewer", "GET", "/occasions/agenda?from=2027-02-01&to=2027-02-28");
    expect(api.status).toBe(200);
    expect((await call("viewer", "GET", "/occasions/agenda?from=2027-02-01&to=2028-06-01")).status).toBe(400);
  });
});
