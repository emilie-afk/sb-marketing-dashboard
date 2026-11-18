// The occasion matcher for Slack Review suggestions (pure; synthetic messages only).
import { describe, it, expect } from "vitest";
import { matchOccasion, normalize, type MatchOccasion } from "../shared/occasionMatch";
import { GIFT_OCCASIONS, GIFT_OVERRIDES, occurrence } from "../shared/giftCalendar";
import { twoQuarterWindow } from "../server/planningTimeline";

const OCCS: MatchOccasion[] = GIFT_OCCASIONS.map((o) => ({ id: o.id, name: o.name, aliases: o.aliases ?? [], brands: o.brands, rule: o.rule ?? null, kind: o.kind, parent_id: o.parent ?? null }));
const OVS = new Map(GIFT_OVERRIDES.map((v) => [`${v.occasion}:${v.year}`, { start: v.start, end: v.end }]));
const m = (title: string, over: Record<string, unknown> = {}) => matchOccasion({ title, posted_at: "2026-11-10T09:00:00Z", ...over }, OCCS, OVS);

describe("occasion dates", () => {
  it("Black Friday is the day after Thanksgiving and Cyber Monday the Monday after, in any year", () => {
    const at = (id: string, y: number) => { const x = occurrence(GIFT_OCCASIONS.find((o) => o.id === id)!.rule!, y); return x.tbc ? null : x.start; };
    expect([at("thanksgiving", 2026), at("black-friday", 2026), at("cyber-monday", 2026)]).toEqual(["2026-11-26", "2026-11-27", "2026-11-30"]);
    expect([at("thanksgiving", 2024), at("black-friday", 2024), at("cyber-monday", 2024)]).toEqual(["2024-11-28", "2024-11-29", "2024-12-02"]);
  });
  it("the planning window is the next two calendar quarters, across a year boundary", () => {
    expect(twoQuarterWindow("2026-11-18")).toEqual({ months: ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"], from: "2027-01-01", to: "2027-06-30" });
    expect(twoQuarterWindow("2027-03-31").from).toBe("2027-04-01");
    expect(twoQuarterWindow("2027-08-02")).toMatchObject({ from: "2027-10-01", to: "2028-03-31" });
  });
});

describe("matching", () => {
  it("an exact keyword or alias is one suggested match (not confirmed), with the next occurrence's year", () => {
    expect(normalize("BF/CM email!")).toBe(" bf cm email ");
    const r = m("Draft the BF/CM email for the gift sets");
    expect(r).toMatchObject({ status: "suggested", occasion_id: "black-friday", occasion_year: 2026 });
    expect(r.candidates[0]).toMatchObject({ name: "Black Friday", matched: "BF/CM", start: "2026-11-27" });
    expect(m("Mother's Day banner")).toMatchObject({ status: "suggested", occasion_id: "mothers-day", occasion_year: 2027 });
    expect(m("Xmas stocking stuffer post").occasion_id).toBe("christmas");
    expect(m("Admin Day desk plants")).toMatchObject({ occasion_id: "administrative-professionals-day", occasion_year: 2027 });
  });

  it("a broad holiday reference is not mapped to Christmas (or anything)", () => {
    expect(m("Draft the holiday email", { excerpt: "Synthetic: can someone draft the holiday email before the sale?" })).toEqual({ status: "unmatched", occasion_id: null, occasion_year: null, candidates: [] });
    expect(m("Plan the holiday season promo").status).toBe("unmatched");
  });

  it("several occasions in one message are listed, none preselected", () => {
    const r = m("Black Friday and Cyber Monday social posts");
    expect(r.status).toBe("ambiguous");
    expect(r.occasion_id).toBeNull();
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["black-friday", "cyber-monday"]);
    // The longer name wins over a shorter one inside it: one occasion, not two.
    expect(m("Black Friday Cyber Monday bundle")).toMatchObject({ status: "suggested", occasion_id: "black-friday" });
    expect(m("Teacher Appreciation Day cards")).toMatchObject({ status: "suggested", occasion_id: "teacher-appreciation-week" });
  });

  it("the same occasion across two years: a written year wins; two years or a far-off date leave it unconfirmed with both", () => {
    expect(m("Valentine's 2028 bundle")).toMatchObject({ status: "suggested", occasion_id: "valentines-day", occasion_year: 2028 });
    const two = m("Compare Valentine's 2026 and 2027 results for the bundle");
    expect(two.status).toBe("ambiguous");
    expect(two.candidates.map((c) => `${c.id}:${c.year}`)).toEqual(["valentines-day:2026", "valentines-day:2027"]);
    // Halloween 2026 has just passed; the next one is almost a year away: both years are offered.
    const far = m("Halloween recap photos");
    expect(far.status).toBe("ambiguous");
    expect(far.candidates.map((c) => c.year)).toEqual([2026, 2027]);
    // An exact deadline picks the occurrence it leads into.
    expect(m("Halloween banner", { due_date: "2027-10-01" })).toMatchObject({ status: "suggested", occasion_year: 2027 });
    expect(m("Christmas card copy", { due_date: "2026-12-28" })).toMatchObject({ status: "suggested", occasion_id: "christmas", occasion_year: 2027 });
  });

  it("the business narrows the occasions; unconfirmed dates are not given a day", () => {
    expect(m("Black Friday ads", { business: "perksradar" }).status).toBe("unmatched");
    const vol = matchOccasion({ title: "Volunteer Week thank-you boxes", posted_at: "2027-12-10T00:00:00Z" }, OCCS, OVS);
    expect(vol).toMatchObject({ status: "suggested", occasion_id: "national-volunteer-week", occasion_year: 2028 });
    expect(vol.candidates[0]).toMatchObject({ tbc: true, start: null, end: null });
  });
});
