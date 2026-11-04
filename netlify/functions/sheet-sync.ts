// Scheduled every 15 minutes. Only queues the due spreadsheets (and the hourly Plant Revenue Breakdown pull) and
// starts the background function for each; it never reads a spreadsheet itself, so it finishes well within
// Netlify's 30-second limit for scheduled functions. One-way sync; nothing here sends messages.
import type { Config } from "@netlify/functions";
import { enqueueScheduled } from "../../server/syncJobs";
import { logServerError } from "../../server/redact";

export default async () => {
  try {
    await enqueueScheduled();
  } catch (e) {
    logServerError("scheduled-sync", e);
  }
};
export const config: Config = { schedule: "*/15 * * * *" };
