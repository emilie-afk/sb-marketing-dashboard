// Scheduled spreadsheet sync. Runs every 15 minutes and syncs only the sources whose own interval has elapsed.
// One-way (spreadsheet to dashboard). Nothing here sends messages or changes other scheduled tasks.
import type { Config } from "@netlify/functions";
import { dueSources, runSheetSync } from "../../server/sheetSync";
import { pullPlantBreakdown, plantBreakdownConfigured } from "../../server/adapters/plantBreakdown";
import { logServerError } from "../../server/redact";

export default async () => {
  try {
    for (const s of await dueSources()) await runSheetSync(s.id, "schedule", "schedule");
    if (plantBreakdownConfigured() && new Date().getUTCMinutes() < 15) await pullPlantBreakdown();
  } catch (e) {
    logServerError("scheduled-sync", e);
  }
};
export const config: Config = { schedule: "*/15 * * * *" };
