// Recurring U.S. gift calendar: occasion definitions (seeded into gift_occasions) and the date rules that place
// each dated occasion in a given year. Every date here is an all-day calendar date ('YYYY-MM-DD'), never a clock
// time, so an occasion shows on the same day for staff in Vietnam and in U.S. time zones.
import { addDays, daysInMonth, type DateRange } from "./dates";

export type GiftRule =
  | { t: "fixed"; m: number; d: number }                                   // Feb 14
  | { t: "fixed_range"; m: number; d1: number; d2: number }                 // May 6–12
  | { t: "nth_weekday"; m: number; wd: number; n: number }                  // wd: 0 = Sunday … 6 = Saturday
  | { t: "last_full_week_day"; m: number; wd: number }                      // weekday of the month's last full Sun–Sat week
  | { t: "first_full_workweek"; m: number; wd?: number }                    // Mon–Fri of the month's first full workweek, or one day of it
  | { t: "sunday_after_labor_day" }
  | { t: "window"; m1: number; d1: number; m2: number; d2: number | "end" } // seasonal or planning window
  | { t: "announced"; m: number };                                          // organizer-set dates: per-year overrides only

export type GiftOccasionDef = {
  id: string; name: string; kind: "dated" | "year_round"; category?: string;
  rule?: GiftRule; timing: string; month: string; themes?: string;
  leadIn?: string; leadInMonth?: number; seasonal?: boolean; parent?: string; brands: string[];
};
export type GiftOverride = { occasion: string; year: number; start: string; end: string; note?: string };

const BOTH = ["sb", "p2s"];
const fmt = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay();
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function nthWeekday(y: number, m: number, wd: number, n: number) {
  const first = fmt(y, m, 1);
  return addDays(first, ((wd - weekday(first) + 7) % 7) + (n - 1) * 7);
}
/** First Monday on or after the 1st: Monday–Friday of that week all fall inside the month. */
function firstFullWorkweekMonday(y: number, m: number) { return nthWeekday(y, m, 1, 1); }

export type Occurrence = (DateRange & { tbc?: false; overridden?: boolean }) | { tbc: true; month: number };

/** Where a dated occasion falls in `year`. Overrides win; an organizer-set occasion without one is "to be confirmed". */
export function occurrence(rule: GiftRule, year: number, override?: { start: string; end: string } | null): Occurrence {
  if (override) return { start: override.start, end: override.end, overridden: true };
  switch (rule.t) {
    case "fixed": { const d = fmt(year, rule.m, Math.min(rule.d, daysInMonth(year, rule.m))); return { start: d, end: d }; }
    case "fixed_range": return { start: fmt(year, rule.m, rule.d1), end: fmt(year, rule.m, rule.d2) };
    case "nth_weekday": { const d = nthWeekday(year, rule.m, rule.wd, rule.n); return { start: d, end: d }; }
    case "last_full_week_day": {
      const last = fmt(year, rule.m, daysInMonth(year, rule.m));
      const saturday = addDays(last, -((weekday(last) + 1) % 7));   // last Saturday of the month ends the last full Sun–Sat week
      const d = addDays(saturday, rule.wd - 6);
      return { start: d, end: d };
    }
    case "first_full_workweek": {
      const mon = firstFullWorkweekMonday(year, rule.m);
      if (rule.wd !== undefined) { const d = addDays(mon, rule.wd - 1); return { start: d, end: d }; }
      return { start: mon, end: addDays(mon, 4) };
    }
    case "sunday_after_labor_day": { const d = addDays(nthWeekday(year, 9, 1, 1), 6); return { start: d, end: d }; }
    case "window": return { start: fmt(year, rule.m1, rule.d1), end: fmt(year, rule.m2, rule.d2 === "end" ? daysInMonth(year, rule.m2) : rule.d2) };
    case "announced": return { tbc: true, month: rule.m };
  }
}

export const monthName = (m: number) => MONTHS[m - 1];
export const tbcText = (month: number) => `${monthName(month)}, dates to be confirmed`;

export const GIFT_OCCASIONS: GiftOccasionDef[] = [
  { id: "valentines-day", name: "Valentine’s Day", kind: "dated", rule: { t: "fixed", m: 2, d: 14 }, month: "February", timing: "Feb 14", themes: "Romantic gifts, couple keepsakes", brands: BOTH },
  { id: "national-caregivers-day", name: "National Caregivers Day", kind: "dated", rule: { t: "nth_weekday", m: 2, wd: 5, n: 3 }, month: "February", timing: "Third Friday in February", themes: "Caregiver thank-you gifts", brands: BOTH },
  { id: "employee-appreciation-day", name: "Employee Appreciation Day", kind: "dated", rule: { t: "nth_weekday", m: 3, wd: 5, n: 1 }, month: "March", timing: "First Friday in March", themes: "Employee desk gifts, team orders, coworker thank-yous", brands: BOTH },
  { id: "administrative-professionals-day", name: "Administrative Professionals Day", kind: "dated", rule: { t: "last_full_week_day", m: 4, wd: 3 }, month: "April", timing: "Wednesday of the last full week of April", themes: "Gifts for assistants and office staff", brands: BOTH },
  { id: "national-volunteer-week", name: "National Volunteer Week", kind: "dated", rule: { t: "announced", m: 4 }, month: "April", timing: "Organizer-set dates in April", themes: "Volunteer thank-you gifts", brands: BOTH },
  { id: "teacher-appreciation-week", name: "Teacher Appreciation Week", kind: "dated", rule: { t: "first_full_workweek", m: 5 }, month: "May", timing: "Monday through Friday of the first full school week in May", themes: "Teacher gifts from parents, students, PTAs, and schools", brands: BOTH },
  { id: "teacher-appreciation-day", name: "Teacher Appreciation Day", kind: "dated", rule: { t: "first_full_workweek", m: 5, wd: 2 }, month: "May", timing: "Tuesday of Teacher Appreciation Week", themes: "Teacher thank-you gifts", parent: "teacher-appreciation-week", brands: BOTH },
  { id: "mothers-day", name: "Mother’s Day", kind: "dated", rule: { t: "nth_weekday", m: 5, wd: 0, n: 2 }, month: "May", timing: "Second Sunday in May", themes: "Gifts for moms and grandmas", brands: BOTH },
  { id: "national-nurses-week", name: "National Nurses Week", kind: "dated", rule: { t: "fixed_range", m: 5, d1: 6, d2: 12 }, month: "May", timing: "May 6–12", themes: "Nurse appreciation gifts", brands: BOTH },
  { id: "graduation-season", name: "Graduation and end-of-school-year gifting", kind: "dated", rule: { t: "window", m1: 5, d1: 1, m2: 6, d2: "end" }, seasonal: true, month: "May–June", timing: "Seasonal window", themes: "Graduate keepsakes and teacher thank-yous", brands: BOTH },
  { id: "spring-weddings", name: "Spring and early summer weddings", kind: "dated", rule: { t: "window", m1: 5, d1: 1, m2: 6, d2: "end" }, seasonal: true, month: "May–June", timing: "Seasonal window", themes: "Bridal showers, wedding gifts, favors, and keepsakes", leadIn: "Start the campaign in April", leadInMonth: 4, brands: BOTH },
  { id: "fathers-day", name: "Father’s Day", kind: "dated", rule: { t: "nth_weekday", m: 6, wd: 0, n: 3 }, month: "June", timing: "Third Sunday in June", themes: "Gifts for dads and grandpas", brands: BOTH },
  { id: "fourth-of-july", name: "Fourth of July", kind: "dated", rule: { t: "fixed", m: 7, d: 4 }, month: "July", timing: "Jul 4", themes: "Kids’ gifts and family gifts", brands: BOTH },
  { id: "back-to-school", name: "Back to school", kind: "dated", rule: { t: "window", m1: 8, d1: 1, m2: 8, d2: "end" }, seasonal: true, month: "August", timing: "August planning window; school dates vary", themes: "Student gifts", brands: BOTH },
  { id: "grandparents-day", name: "Grandparents Day", kind: "dated", rule: { t: "sunday_after_labor_day" }, month: "September", timing: "First Sunday after Labor Day", themes: "Gifts for grandparents and family keepsakes", brands: BOTH },
  { id: "fall-weddings", name: "Fall weddings", kind: "dated", rule: { t: "window", m1: 9, d1: 1, m2: 10, d2: "end" }, seasonal: true, month: "September–October", timing: "Seasonal window", themes: "Bridal showers, wedding gifts, favors, and keepsakes", leadIn: "Start the campaign in August", leadInMonth: 8, brands: BOTH },
  { id: "customer-service-week", name: "Customer Service Week", kind: "dated", rule: { t: "first_full_workweek", m: 10 }, month: "October", timing: "First full workweek in October", themes: "Gifts for customer service and support teams", brands: BOTH },
  { id: "world-teachers-day", name: "World Teachers’ Day", kind: "dated", rule: { t: "fixed", m: 10, d: 5 }, month: "October", timing: "Oct 5", themes: "Fall teacher thank-you gifts", brands: BOTH },
  { id: "bosses-day", name: "Boss’s Day", kind: "dated", rule: { t: "fixed", m: 10, d: 16 }, month: "October", timing: "Oct 16", themes: "Group gifts for managers", brands: BOTH },
  { id: "halloween", name: "Halloween", kind: "dated", rule: { t: "fixed", m: 10, d: 31 }, month: "October", timing: "Oct 31", themes: "Halloween-themed gifts", brands: BOTH },
  { id: "thanksgiving", name: "Thanksgiving", kind: "dated", rule: { t: "nth_weekday", m: 11, wd: 4, n: 4 }, month: "November", timing: "Fourth Thursday in November", themes: "Host gifts, thank-you gifts, and holiday ordering for clients and teams", brands: BOTH },
  { id: "christmas", name: "Christmas", kind: "dated", rule: { t: "fixed", m: 12, d: 25 }, month: "December", timing: "Dec 25", themes: "Family keepsakes and stocking stuffers", brands: BOTH },
  { id: "year-end-gifting", name: "Year-end gifting", kind: "dated", rule: { t: "window", m1: 12, d1: 1, m2: 12, d2: "end" }, seasonal: true, month: "December", timing: "December planning window", themes: "Gifts for teachers, coworkers, clients, and teams", brands: BOTH },
  ...yearRound("Celebrations and milestones", ["Birthdays", "Milestone birthdays", "Anniversaries", "Weddings", "Bridal showers", "Graduation", "New jobs", "Retirement", "Congratulations"]),
  ...yearRound("Home and family", ["Housewarming", "New homeowners", "Pregnancy announcements", "Baby showers", "New babies"]),
  ...yearRound("Appreciation", ["Teacher thank-yous", "Coworker thank-yous", "Manager thank-yous", "Employee thank-yous", "Client thank-yous", "Volunteer thank-yous", "Caregiver thank-yous"]),
  ...yearRound("Care and support", ["Sympathy", "Encouragement", "Pet memorials", "Apologies"]),
  ...yearRound("Just because", ["Friendship", "Love and romance", "Family", "Pet lovers", "Sports fans"]),
];

export const GIFT_OVERRIDES: GiftOverride[] = [
  { occasion: "national-volunteer-week", year: 2027, start: "2027-04-18", end: "2027-04-24", note: "Organizer-announced dates" },
];

function yearRound(category: string, names: string[]): GiftOccasionDef[] {
  return names.map((name) => ({ id: `yr-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, name, kind: "year_round" as const, category, month: "Year-round", timing: "Year-round", brands: BOTH }));
}
