import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshDb, call, q, closePool } from "./helpers";
import { GIFT_OCCASIONS, occurrence } from "../shared/giftCalendar";
import { seedGiftOccasions } from "../server/giftSeed";
import { getPool } from "../server/db";

beforeAll(async () => { await freshDb(); });
afterAll(closePool);

const rule = (id: string) => GIFT_OCCASIONS.find((o) => o.id === id)!.rule!;
const cal = async (from: string, to: string, extra = "", role: "viewer" | "editor" = "viewer") =>
  (await call(role, "GET", `/calendar?from=${from}&to=${to}${extra}`)).body;
const create = (role: "viewer" | "editor" | "admin", body: any) => call(role, "POST", "/promotions", body);
const promo = async (id: string) => (await call("viewer", "GET", `/promotions/${id}`)).body;

describe("recurrence", () => {
  it("places the 2027 occasions on the expected dates", () => {
    const one = (id: string) => { const x = occurrence(rule(id), 2027) as any; return x.start === x.end ? x.start : `${x.start}/${x.end}`; };
    expect(one("employee-appreciation-day")).toBe("2027-03-05");
    expect(one("administrative-professionals-day")).toBe("2027-04-21");
    expect(one("teacher-appreciation-week")).toBe("2027-05-03/2027-05-07");
    expect(one("teacher-appreciation-day")).toBe("2027-05-04");
    expect(one("grandparents-day")).toBe("2027-09-12");
    expect(one("customer-service-week")).toBe("2027-10-04/2027-10-08");
    expect(one("thanksgiving")).toBe("2027-11-25");
  });
  it("keeps all-day dates the same in Vietnam and U.S. time zones", () => {
    const run = (tz: string) => { process.env.TZ = tz; return GIFT_OCCASIONS.filter((o) => o.rule).map((o) => JSON.stringify(occurrence(o.rule!, 2027))); };
    const vn = run("Asia/Ho_Chi_Minh"), la = run("America/Los_Angeles"), ny = run("America/New_York");
    process.env.TZ = "UTC";
    expect(la).toEqual(vn); expect(ny).toEqual(vn);
  });
  it("uses the per-year override and otherwise marks organizer-set dates as to be confirmed", () => {
    expect(occurrence(rule("national-volunteer-week"), 2026)).toEqual({ tbc: true, month: 4 });
  });
});

describe("seed", () => {
  it("seeds both brands with stable ids and is safe to rerun without touching promotion links", async () => {
    const n = (await q("select count(*)::int n from gift_occasions"))[0].n;
    expect(n).toBe(GIFT_OCCASIONS.length);
    expect((await q("select count(*)::int n from gift_occasion_brands"))[0].n).toBe(GIFT_OCCASIONS.length * 2);
    const p = await create("editor", { business_id: "sb", title: "Mother's Day 2027 boxes", start_date: "2027-04-20", end_date: "2027-05-09", gift_occasion_id: "mothers-day", gift_occasion_year: 2027 });
    expect(p.status).toBe(200);
    await seedGiftOccasions(getPool());
    await seedGiftOccasions(getPool());
    expect((await q("select count(*)::int n from gift_occasions"))[0].n).toBe(n);
    expect((await q("select gift_occasion_id, gift_occasion_year from promotions where id = $1", [p.body.id]))[0]).toEqual({ gift_occasion_id: "mothers-day", gift_occasion_year: 2027 });
    expect((await q("select to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e from gift_occasion_overrides where occasion_id = 'national-volunteer-week' and year = 2027"))[0]).toEqual({ s: "2027-04-18", e: "2027-04-24" });
  });
});

describe("calendar", () => {
  it("shows a shared occasion once with both brands, and under each brand filter", async () => {
    const all = await cal("2027-02-01", "2027-02-28", "&types=gift");
    const vday = all.items.filter((i: any) => i.occasionId === "valentines-day");
    expect(vday).toHaveLength(1);
    expect(vday[0]).toMatchObject({ type: "gift", start: "2027-02-14", end: "2027-02-14", brands: ["p2s", "sb"] });
    for (const b of ["sb", "p2s"]) expect((await cal("2027-02-01", "2027-02-28", `&types=gift&business=${b}`)).items.map((i: any) => i.occasionId)).toContain("valentines-day");
    expect((await cal("2027-02-01", "2027-02-28", "&types=gift&business=perksradar")).items).toHaveLength(0);
  });
  it("hides seasonal windows on request and shows Teacher Appreciation Day inside its week", async () => {
    const may = await cal("2027-05-01", "2027-05-31", "&types=gift");
    const ids = may.items.map((i: any) => i.occasionId);
    expect(ids).toEqual(expect.arrayContaining(["teacher-appreciation-week", "mothers-day", "national-nurses-week", "spring-weddings", "graduation-season"]));
    expect(ids).not.toContain("teacher-appreciation-day");
    const noSeason = (await cal("2027-05-01", "2027-05-31", "&types=gift&seasonal=0")).items.map((i: any) => i.occasionId);
    expect(noSeason).not.toContain("spring-weddings");
    expect(noSeason).toContain("teacher-appreciation-week");
    const d = (await call("viewer", "GET", "/gift-occasions/teacher-appreciation-week?year=2027")).body;
    expect(d.datesText).toBe("May 3 to 7, 2027");
    expect(d.within).toEqual([expect.objectContaining({ id: "teacher-appreciation-day", datesText: "May 4, 2027" })]);
  });
  it("places National Volunteer Week from the 2027 override and lists 2026 as to be confirmed", async () => {
    const y27 = await cal("2027-04-01", "2027-04-30", "&types=gift");
    expect(y27.items.find((i: any) => i.occasionId === "national-volunteer-week")).toMatchObject({ start: "2027-04-18", end: "2027-04-24" });
    const y26 = await cal("2026-04-01", "2026-04-30", "&types=gift");
    expect(y26.items.find((i: any) => i.occasionId === "national-volunteer-week")).toBeUndefined();
    expect(y26.undated).toEqual([expect.objectContaining({ occasionId: "national-volunteer-week", text: "April, dates to be confirmed" })]);
    expect((await call("viewer", "GET", "/gift-occasions/national-volunteer-week?year=2026")).body.datesText).toBe("April, dates to be confirmed");
  });
  it("keeps lead-ins separate from the window shown", async () => {
    const d = (await call("viewer", "GET", "/gift-occasions/spring-weddings?year=2027")).body;
    expect(d.dates).toEqual({ start: "2027-05-01", end: "2027-06-30" });
    expect(d.occasion).toMatchObject({ leadIn: "Start the campaign in April", leadInMonth: "April", seasonal: true });
  });
  it("still shows promotions and read-only Task Tracker entries with Gift occasions turned off", async () => {
    await q(`insert into tracker_task_records (source_instance, record_id, task_id, kind, business_id, title, task_type, brand_name, assignee_name, status, due_date, snapshot_id)
             values ('tracker-test', 'task:11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'task', 'sb', 'Order wedding favors stock', 'adhoc', 'Succulents Box', 'A', 'open', '2027-04-15', 'snp_${"0".repeat(32)}')`);
    const r = await cal("2027-04-01", "2027-05-31", "&types=promotion,launch,task");
    expect(r.items.some((i: any) => i.type === "gift")).toBe(false);
    expect(r.items.find((i: any) => i.title === "Mother's Day 2027 boxes")).toMatchObject({ type: "promotion", giftOccasion: "Mother’s Day 2027" });
    expect(r.items.find((i: any) => i.title === "Order wedding favors stock")).toMatchObject({ type: "task", read_only: true });
  });
});

describe("promotions and occasion links", () => {
  it("lets both brands link separate promotions to the same occasion, each with its own dates", async () => {
    const a = await create("editor", { business_id: "sb", title: "SB Thanksgiving hosts", start_date: "2027-11-01", end_date: "2027-11-24", gift_occasion_id: "thanksgiving", gift_occasion_year: 2027 });
    const b = await create("editor", { business_id: "p2s", title: "P2S Thanksgiving portraits", start_date: "2027-10-20", end_date: "2027-11-20", execution_status: "preparing", gift_occasion_id: "thanksgiving", gift_occasion_year: 2027 });
    expect([a.status, b.status]).toEqual([200, 200]);
    const d = (await call("viewer", "GET", "/gift-occasions/thanksgiving?year=2027")).body;
    expect(d.dates).toEqual({ start: "2027-11-25", end: "2027-11-25" });
    expect(d.promotions.map((p: any) => [p.business, p.title, p.start_date, p.end_date, p.status])).toEqual([
      ["p2s", "P2S Thanksgiving portraits", "2027-10-20", "2027-11-20", "preparing"], ["sb", "SB Thanksgiving hosts", "2027-11-01", "2027-11-24", "planned"]]);
    expect((await call("viewer", "GET", "/gift-occasions/thanksgiving?year=2027&business=sb")).body.promotions).toHaveLength(1);
    expect((await cal("2027-11-01", "2027-11-30", "&types=gift")).items.find((i: any) => i.occasionId === "thanksgiving").linkedPromotions).toBe(2);
  });
  it("links a December campaign to the next year's occasion", async () => {
    const r = await create("editor", { business_id: "p2s", title: "Valentine sketches early bird", start_date: "2026-12-26", end_date: "2027-02-10", gift_occasion_id: "valentines-day", gift_occasion_year: 2027 });
    expect(r.status).toBe(200);
    const d = (await call("viewer", "GET", "/gift-occasions/valentines-day?year=2027")).body;
    expect(d.promotions.map((p: any) => p.title)).toContain("Valentine sketches early bird");
    expect((await call("viewer", "GET", "/gift-occasions/valentines-day?year=2026")).body.promotions).toHaveLength(0);
  });
  it("validates the link: dated needs a year, year-round takes none, and the brand must apply", async () => {
    const base = { title: "x", start_date: "2027-03-01", end_date: "2027-03-05" };
    expect((await create("editor", { ...base, business_id: "sb", gift_occasion_id: "employee-appreciation-day" })).status).toBe(400);
    expect((await create("editor", { ...base, business_id: "sb", gift_occasion_id: "yr-birthdays", gift_occasion_year: 2027 })).status).toBe(400);
    expect((await create("editor", { ...base, business_id: "perksradar", gift_occasion_id: "employee-appreciation-day", gift_occasion_year: 2027 })).status).toBe(400);
    expect((await create("editor", { ...base, business_id: "sb", gift_occasion_id: "nope", gift_occasion_year: 2027 })).status).toBe(400);
    expect((await create("editor", { ...base, business_id: "sb", end_date: "2027-02-01" })).status).toBe(400);
    const yr = await create("editor", { ...base, business_id: "sb", title: "Birthday plant boxes", gift_occasion_id: "yr-birthdays" });
    expect(yr.status).toBe(200);
    const shown = await cal("2027-03-01", "2027-03-31", "&types=promotion");
    expect(shown.items.find((i: any) => i.title === "Birthday plant boxes").giftOccasion).toBe("Birthdays");
    expect((await call("viewer", "GET", "/gift-occasions/yr-birthdays?year=2027")).body.promotions.map((p: any) => p.title)).toContain("Birthday plant boxes");
  });
  it("keeps existing promotions valid, and linking or clearing a spreadsheet promotion preserves its other fields", async () => {
    const src = (await q("insert into sheet_sources (business_id, year, role, label, file_id, file_kind, created_by) values ('sb', 2027, 'annual_calendar', 'Gift test', 'TESTgiftFILEid0000000000001', 'xlsx', 't') returning id"))[0].id;
    const p = (await q(`insert into promotions (business_id, year, kind, title, start_date, end_date, offer, code, created_by) values ('sb', 2027, 'promotion', 'Spring sale', '2027-04-01', '2027-04-15', '10% off', 'SPRING10', 'sync:x') returning id`))[0].id;
    await q("insert into promotion_source_links (promotion_id, sheet_source_id, identity_key) values ($1,$2,'code:SPRING10')", [p, src]);
    const before = (await promo(p)).promotion;
    expect(before.gift_occasion_id).toBeNull();
    expect((await promo(p)).sourceOwned).toBe(true);
    let r = await call("editor", "PATCH", `/promotions/${p}`, { gift_occasion_id: "spring-weddings", gift_occasion_year: 2027, version: before.version });
    expect(r.status).toBe(200);
    let after = (await promo(p)).promotion;
    expect(after).toMatchObject({ gift_occasion_id: "spring-weddings", gift_occasion_year: 2027, title: "Spring sale", offer: "10% off", code: "SPRING10", start_date: "2027-04-01", end_date: "2027-04-15", execution_status: "planned" });
    // Spreadsheet-owned fields stay in the spreadsheet.
    expect((await call("editor", "PATCH", `/promotions/${p}`, { title: "Renamed", version: after.version })).status).toBe(400);
    // Change the link, then clear it.
    r = await call("editor", "PATCH", `/promotions/${p}`, { gift_occasion_id: "administrative-professionals-day", gift_occasion_year: 2027, version: after.version });
    expect(r.status).toBe(200);
    after = (await promo(p)).promotion;
    r = await call("editor", "PATCH", `/promotions/${p}`, { gift_occasion_id: null, version: after.version });
    expect(r.status).toBe(200);
    after = (await promo(p)).promotion;
    expect(after).toMatchObject({ gift_occasion_id: null, gift_occasion_year: null, title: "Spring sale", offer: "10% off", start_date: "2027-04-01", end_date: "2027-04-15" });
    const hist = (await promo(p)).history.map((h: any) => Object.keys(h.changes));
    expect(hist.flat()).toEqual(expect.arrayContaining(["gift_occasion_id", "gift_occasion_year"]));
    // Execution fields still save as before.
    expect((await call("editor", "PATCH", `/promotions/${p}`, { execution_status: "ready", version: after.version })).status).toBe(200);
  });
  it("edits a dashboard promotion's name, offer, dates and status without losing its link", async () => {
    const id = (await create("editor", { business_id: "sb", title: "Grandparents Day keepsakes", start_date: "2027-08-25", end_date: "2027-09-12", gift_occasion_id: "grandparents-day", gift_occasion_year: 2027 })).body.id;
    const v = (await promo(id)).promotion.version;
    expect((await promo(id)).sourceOwned).toBe(false);
    const r = await call("editor", "PATCH", `/promotions/${id}`, { title: "Grandparents Day gift boxes", offer: "Free card", start_date: "2027-08-20", end_date: "2027-09-11", execution_status: "ready", version: v });
    expect(r.status).toBe(200);
    expect((await promo(id)).promotion).toMatchObject({ title: "Grandparents Day gift boxes", offer: "Free card", start_date: "2027-08-20", end_date: "2027-09-11", execution_status: "ready", gift_occasion_id: "grandparents-day", gift_occasion_year: 2027 });
    expect((await call("editor", "PATCH", `/promotions/${id}`, { end_date: "2027-08-01", version: v + 1 })).status).toBe(400);
  });
  it("refuses creating promotions and changing links for read-only users", async () => {
    expect((await create("viewer", { business_id: "sb", title: "x", start_date: "2027-03-01", end_date: "2027-03-02" })).status).toBe(403);
    const id = (await q("select id from promotions where title = 'Spring sale'"))[0].id;
    const v = (await promo(id)).promotion.version;
    expect((await call("viewer", "PATCH", `/promotions/${id}`, { gift_occasion_id: "halloween", gift_occasion_year: 2027, version: v })).status).toBe(403);
    expect((await promo(id)).promotion.gift_occasion_id).toBeNull();
    expect((await call("viewer", "GET", "/gift-occasions/halloween?year=2027")).body.canCreate).toBe(false);
    expect((await call("editor", "GET", "/gift-occasions/halloween?year=2027")).body.canCreate).toBe(true);
  });
  it("lists link candidates and the picker for both brands", async () => {
    const picker = (await call("viewer", "GET", "/gift-occasions?year=2027")).body;
    expect(picker.find((o: any) => o.id === "teacher-appreciation-day")).toMatchObject({ parent: "teacher-appreciation-week", kind: "dated" });
    expect(picker.find((o: any) => o.id === "national-volunteer-week").dates["2026"]).toBe("April, dates to be confirmed");
    expect(picker.filter((o: any) => o.kind === "year_round").length).toBe(30);
    const c = (await call("viewer", "GET", "/gift-occasions/halloween/candidates?year=2027")).body;
    expect(c.map((p: any) => p.title)).toContain("Spring sale");
  });
});
