// Applying one pulled record (a Gross Profit week, a Corporate Gifting month, a Plant Revenue Breakdown report).
//
// Each record belongs to a family (its week, month or report) and carries an id that encodes its content revision.
// It is compared with the family's ACTIVE submission only, never with superseded ones:
//   - the same revision is active                → unchanged, nothing written;
//   - a different revision                      → a correction of the active submission;
//   - a revision seen before but not active now → still a correction (content A → B → A ends on A). Its id gets a
//     ":c<n>" counter, because a submission id is never reused.
import { checkSubmission } from "../../shared/submission";
import { applySubmission } from "../imports";
import { query } from "../db";
import { HttpError } from "../http";
import { ZodError } from "zod";

export type PullIdentity = { sourceId: string; submitter: string; submissionSource: string };

const baseOf = (id: string) => id.replace(/:c\d+$/, "");

export async function applyPulled(body: any, family: string, who: PullIdentity, actor: string) {
  const base: string = body.submission_id;
  const active = (await query<{ submission_id: string; rejected_count: number }>(
    `select submission_id, rejected_count from import_runs where source_id = $1 and submitter = $2 and business_id = $3 and submission_source = $4
       and status = 'active' and left(submission_id, length($5)) = $5 order by revision desc limit 1`,
    [who.sourceId, who.submitter, body.business, who.submissionSource, family]))[0];
  // Same revision already active. If it was stored with rejected records, say so every time: an incomplete revision
  // is never reported as unchanged and healthy.
  if (active && baseOf(active.submission_id) === base) {
    return { outcome: "unchanged" as const, submission_id: active.submission_id, stored_with_rejected: Number(active.rejected_count) };
  }

  const used = new Set((await query<{ submission_id: string }>(
    `select submission_id from import_runs where source_id = $1 and (submission_id = $2 or left(submission_id, length($2) + 2) = $2 || ':c')`,
    [who.sourceId, base])).map((r) => r.submission_id));
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}:c${n}`;
  const out = { ...body, submission_id: id };
  if (active) out.corrects = active.submission_id; else delete out.corrects;

  const checked = checkSubmission(out);
  if (!checked.ok) return { outcome: "rejected" as const, submission_id: id, errors: checked.errors };
  return applySubmission(checked.value, actor, who.sourceId, who.submitter);
}

/**
 * Walks cursor pages. A repeated cursor, more pages than the limit, or a page that cannot be fetched or read is
 * reported as a problem and stops the walk, never treated as finished. Records already applied stay applied (each
 * is its own submission), so the caller can report partial progress and a retry is safe.
 */
export async function walkPages<T>(label: string, maxPages: number, fetchPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
  onItem: (item: T) => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) { problems.push(`${label} has more than ${maxPages} pages; reading stopped before the end`); break; }
    let page: { items: T[]; next: string | null };
    try { page = await fetchPage(cursor); } catch (e) {
      problems.push(`${label}: page ${pages + 1} could not be read (${describe(e)}); reading stopped there`);
      break;
    }
    for (const item of page.items) await onItem(item);
    if (!page.next) break;
    if (seen.has(page.next) || page.next === cursor) { problems.push(`${label} repeated a page cursor; reading stopped`); break; }
    seen.add(page.next);
    cursor = page.next;
  }
  return problems;
}

/** A short, safe description of a fetch or format error (no response bodies, no credentials). */
export function describe(e: unknown) {
  if (e instanceof HttpError) return e.message.replace(/\.$/, "");
  if (e instanceof ZodError) return "unexpected response format";
  return "unexpected error";
}
