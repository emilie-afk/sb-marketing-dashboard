// One Slack request, one task. Task Tracker's direct Slack intake turns clear Slack requests that tag a linked staff
// member into tasks within the hour. The same request may also be waiting here for the planning owner: as a Slack
// review suggestion, or as a Corporate Gifts draft. Each hourly Task Tracker pull asks Task Tracker whether it already
// has a task for a waiting item's Slack request (identity only: channel, message ts, request id) and, if exactly one
// task matches, links the item to it: the item shows as in Task Tracker and nobody sends it again. Nothing is created
// here, and anything Task Tracker cannot match exactly stays in the normal review.
// Each run checks up to LINK_BATCH items per queue, least recently checked first (intake_checked_at), so every waiting
// item is reached in turn however long the queue is.
import { query } from "./db";
import { linkTrackerTask, planningTrackerConfigured, type TrackerTask } from "./adapters/planningClient";
import { idempotencyKey, reviewSources, corporateSources } from "./trackerDelivery";
import { logServerError } from "./redact";

export const LINK_BATCH = 50;
const TRACKER_COLS = `delivery_status = 'created', delivery_error = null, tracker_task_id = $2, tracker_version = $3, tracker_title = $4, tracker_due_date = $5,
  tracker_status = $6, tracker_assignee_name_now = $7, tracker_updated_at = $8, tracker_read_at = now()`;
const params = (id: string, t: TrackerTask) => [id, t.task_id, t.version, t.title, t.due_date, t.status, t.assignee.name, t.updated_at];

export async function linkIntakeTasks() {
  if (!planningTrackerConfigured()) return { outcome: "not_configured" as const, linked: 0 };
  let linked = 0;
  // Slack review suggestions still waiting (never sent): linked as approved and in Task Tracker.
  const reviews = await query<{ id: string; source_key: string }>(
    `select id, source_key from review_suggestions where status = 'pending' and delivery_status = 'not_sent'
      order by intake_checked_at nulls first, posted_at, id limit $1`, [LINK_BATCH]);
  for (const r of reviews) {
    const sources = reviewSources(r.source_key);
    if (!sources) continue;
    const out = await linkTrackerTask({ key: idempotencyKey(r.id), plan_id: r.id, origin: "review", sources });
    if (out.kind === "unavailable") return { outcome: "unavailable" as const, linked };   // try again next hour
    await query("update review_suggestions set intake_checked_at = now() where id = $1", [r.id]);
    if (out.kind !== "linked") continue;
    try {
      const n = (await query(`update review_suggestions set status = 'approved', reviewed_at = coalesce(reviewed_at, now()), intake_linked_at = now(), ${TRACKER_COLS},
                                updated_at = now(), version = version + 1 where id = $1 and status = 'pending' and delivery_status = 'not_sent' returning id`, params(r.id, out.task))).length;
      linked += n;
    } catch (e) { logServerError("intake-link-review", e); }
  }
  // Corporate Gifts drafts still waiting: linked and reported back to Corporate Gifts as delivered.
  const drafts = await query<{ id: string; slack_sources: unknown }>(
    `select id, slack_sources from corporate_task_drafts where status = 'pending' and delivery_status = 'not_sent' and jsonb_array_length(slack_sources) > 0
      order by intake_checked_at nulls first, created_at, id limit $1`, [LINK_BATCH]);
  for (const d of drafts) {
    const sources = corporateSources(d.slack_sources);
    if (!sources) continue;
    const out = await linkTrackerTask({ key: idempotencyKey(d.id), plan_id: d.id, origin: "review", sources });
    if (out.kind === "unavailable") return { outcome: "unavailable" as const, linked };
    await query("update corporate_task_drafts set intake_checked_at = now() where id = $1", [d.id]);
    if (out.kind !== "linked") continue;
    try {
      const n = (await query(`update corporate_task_drafts set status = 'approved', reviewed_at = coalesce(reviewed_at, now()), intake_linked_at = now(), ${TRACKER_COLS},
                                synced_content_version = cg_content_version, receipt_due = true, updated_at = now(), version = version + 1
                              where id = $1 and status = 'pending' and delivery_status = 'not_sent' returning id`, params(d.id, out.task))).length;
      linked += n;
    } catch (e) { logServerError("intake-link-corporate", e); }
  }
  return { outcome: "done" as const, linked };
}
