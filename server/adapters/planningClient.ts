// Client for Task Tracker's planning API (docs: sb-task-tracker docs/PLANNING_API.md). Server side only.
//   TASK_TRACKER_API_URL           the tracker's https origin (shared with the reporting pull)
//   TASK_TRACKER_PLANNING_SECRET   the tracker's planning secret (Integrations → Marketing planning there)
// The secret is sent only in a header, only to the configured origin, never to the browser.
import { HttpError } from "../http";
import { originOf, sendJson } from "./reportingClient";

export const planningTrackerConfigured = () => !!originOf(process.env.TASK_TRACKER_API_URL) && (process.env.TASK_TRACKER_PLANNING_SECRET ?? "").length >= 32;
const LABEL = "Task Tracker";
export let PLANNING_TIMEOUT_MS = 15_000;
let sentClock: (() => number) | null = null;
export function _setSentClockForTests(f: (() => number) | null) { sentClock = f; }
export const sentAtNow = () => new Date(sentClock ? sentClock() : Date.now()).toISOString();
export function _setPlanningTimeoutForTests(ms: number | null) { PLANNING_TIMEOUT_MS = ms ?? 15_000; }

function cfg() {
  const origin = originOf(process.env.TASK_TRACKER_API_URL);
  const secret = process.env.TASK_TRACKER_PLANNING_SECRET ?? "";
  if (!origin || secret.length < 32) throw new HttpError(503, "tracker_not_configured", "Task Tracker is not connected for planning (TASK_TRACKER_API_URL and TASK_TRACKER_PLANNING_SECRET).");
  return { origin, headers: { "x-tracker-planning-key": secret } };
}

export type TrackerTask = {
  idempotency_key: string; plan_id: string; task_id: string; title: string; due_date: string | null; status: "open" | "done" | "deleted";
  completed_on: string | null; brand: { id: string; name: string } | null; assignee: { id: string; name: string }; version: number; updated_at: string; open_url: string;
};
export type Directory = { brands: { id: string; name: string; business_id: string }[]; people: { id: string; name: string; brand_ids: string[] }[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Minimal shape check of a task answer; anything else is treated as an unknown outcome. */
export function validTask(t: any): t is TrackerTask {
  return !!t && typeof t === "object" && UUID.test(t.task_id ?? "") && typeof t.title === "string" && ["open", "done", "deleted"].includes(t.status)
    && Number.isInteger(t.version) && typeof t.updated_at === "string" && !Number.isNaN(Date.parse(t.updated_at)) && t.assignee && UUID.test(t.assignee.id ?? "");
}
const failure = (status: number, body: any, fallback: string) =>
  new HttpError(status === 401 ? 502 : status, body?.error?.code ?? "tracker_failed", status === 401 ? "Task Tracker refused the planning credential." : body?.error?.message ?? fallback, body?.error?.details);

export async function trackerDirectory(): Promise<Directory> {
  const c = cfg();
  const r = await sendJson(c.origin, "GET", "/api/planning/v1/directory", c.headers, undefined, LABEL, PLANNING_TIMEOUT_MS);
  if (r.status !== 200 || !Array.isArray(r.body?.brands) || !Array.isArray(r.body?.people)) throw failure(r.status === 200 ? 502 : r.status, r.body, "Task Tracker did not return its directory.");
  const brands = r.body.brands.filter((b: any) => UUID.test(b?.id ?? "") && typeof b.name === "string" && typeof b.business_id === "string")
    .map((b: any) => ({ id: b.id, name: b.name.slice(0, 80), business_id: b.business_id }));
  const people = r.body.people.filter((p: any) => UUID.test(p?.id ?? "") && typeof p.name === "string" && Array.isArray(p.brand_ids))
    .map((p: any) => ({ id: p.id, name: p.name.slice(0, 120), brand_ids: p.brand_ids.filter((x: any) => UUID.test(x)) }));
  return { brands, people };
}

export type CreateOutcome =
  | { kind: "created"; task: TrackerTask; created: boolean }
  // Refused by Task Tracker. task_exists is false only when Task Tracker explicitly confirmed that no task exists for
  // this key (details.task_exists === false); null means the refusal says nothing about it (e.g. key_unavailable).
  | { kind: "refused"; status: number; code: string; message: string; task_exists: false | null; fenced_through: string | null }
  | { kind: "unknown"; message: string };                                     // may or may not exist: retry with the same key

export type SlackSource = { channel_id: string; message_ts: string; action_id?: string | null };
export type SourceWorkflow = "review" | "corporate" | "plan";
export type Sources = { slack_sources: SlackSource[]; source_workflow: SourceWorkflow };
export async function createTrackerTask(input: { key: string; plan_id: string; brand_id: string; assignee_id: string; title: string; brief: string; due_date: string; sent_at: string; supersedes_sent_at: string | null; origin?: "plan" | "review"; sources?: Sources | null }): Promise<CreateOutcome> {
  const c = cfg();
  let r;
  try {
    r = await sendJson(c.origin, "POST", "/api/planning/v1/tasks", c.headers, {
      idempotency_key: input.key, plan_id: input.plan_id, brand_id: input.brand_id, assignee_id: input.assignee_id, title: input.title, brief: input.brief || null, due_date: input.due_date,
      sent_at: input.sent_at, supersedes_sent_at: input.supersedes_sent_at,
      ...(input.origin && input.origin !== "plan" ? { origin: input.origin } : {}),
      ...(input.sources?.slack_sources.length ? { slack_sources: input.sources.slack_sources, source_workflow: input.sources.source_workflow } : {}),
    }, LABEL, PLANNING_TIMEOUT_MS);
  } catch (e: any) {
    return { kind: "unknown", message: e?.message ?? "Task Tracker could not be reached." };
  }
  if ((r.status === 200 || r.status === 201) && validTask(r.body?.task)) return { kind: "created", task: r.body.task, created: r.status === 201 };
  const confirmedAbsent = r.body?.error?.details?.task_exists === false ? false : null;
  const ft = r.body?.error?.details?.fenced_through;
  const fencedThrough = confirmedAbsent === false && typeof ft === "string" && !Number.isNaN(Date.parse(ft)) ? new Date(ft).toISOString() : null;
  if ([400, 409, 422].includes(r.status)) return { kind: "refused", status: r.status, code: r.body?.error?.code ?? "refused", message: r.body?.error?.message ?? "Task Tracker refused the task.", task_exists: confirmedAbsent, fenced_through: fencedThrough };
  if (r.status === 401) return { kind: "refused", status: r.status, code: "tracker_auth", message: "Task Tracker refused the planning credential.", task_exists: null, fenced_through: null };
  if (r.status === 503) return { kind: "refused", status: r.status, code: r.body?.error?.code ?? "planning_disabled", message: r.body?.error?.message ?? "Task Tracker has planning turned off.", task_exists: null, fenced_through: null };
  return { kind: "unknown", message: `Task Tracker answered ${r.status}.` };
}

/**
 * Links an item still waiting for review to the task Task Tracker's Slack intake already created for the same Slack
 * request. Never creates a task. Returns the task when linked (or already linked to this id).
 */
export type LinkOutcome = { kind: "linked"; task: TrackerTask } | { kind: "not_linked"; reason: string } | { kind: "unavailable"; message: string };
export async function linkTrackerTask(input: { key: string; plan_id: string; origin?: "plan" | "review"; sources: Sources }): Promise<LinkOutcome> {
  const c = cfg();
  let r;
  try {
    r = await sendJson(c.origin, "POST", "/api/planning/v1/slack-links", c.headers, {
      idempotency_key: input.key, plan_id: input.plan_id, ...(input.origin && input.origin !== "plan" ? { origin: input.origin } : {}),
      slack_sources: input.sources.slack_sources, source_workflow: input.sources.source_workflow,
    }, LABEL, PLANNING_TIMEOUT_MS);
  } catch (e: any) {
    return { kind: "unavailable", message: e?.message ?? "Task Tracker could not be reached." };
  }
  if (r.status === 200 && r.body?.linked === true && validTask(r.body?.task)) return { kind: "linked", task: r.body.task };
  if (r.status === 200 && r.body?.linked === false) return { kind: "not_linked", reason: String(r.body?.reason ?? "not_found").slice(0, 40) };
  // An older Task Tracker without the endpoint, or any refusal: nothing is linked; the item stays for review.
  return { kind: "unavailable", message: r.body?.error?.message ?? `Task Tracker answered ${r.status}.` };
}

export async function readTrackerTasks(keys: string[]): Promise<TrackerTask[]> {
  if (!keys.length) return [];
  const c = cfg();
  const out: TrackerTask[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await sendJson(c.origin, "GET", `/api/planning/v1/tasks?keys=${keys.slice(i, i + 100).map(encodeURIComponent).join(",")}`, c.headers, undefined, LABEL, PLANNING_TIMEOUT_MS);
    if (r.status !== 200 || !Array.isArray(r.body?.items)) throw failure(r.status === 200 ? 502 : r.status, r.body, "Task Tracker did not return the tasks.");
    out.push(...r.body.items.filter(validTask));
  }
  return out;
}

export type DueOutcome = { kind: "updated"; task: TrackerTask } | { kind: "conflict"; code: string; message: string; task: TrackerTask | null } | { kind: "missing" };
export async function changeTrackerDueDate(key: string, due_date: string, expected_version: number): Promise<DueOutcome> {
  const c = cfg();
  const r = await sendJson(c.origin, "PATCH", `/api/planning/v1/tasks/${encodeURIComponent(key)}/due-date`, c.headers, { due_date, expected_version }, LABEL, PLANNING_TIMEOUT_MS);
  if (r.status === 200 && validTask(r.body?.task)) return { kind: "updated", task: r.body.task };
  if (r.status === 409) return { kind: "conflict", code: r.body?.error?.code ?? "conflict", message: r.body?.error?.message ?? "Changed in Task Tracker.", task: validTask(r.body?.error?.details?.task) ? r.body.error.details.task : null };
  if (r.status === 404) return { kind: "missing" };
  throw failure(r.status, r.body, "Task Tracker did not change the due date.");
}

export type CompleteOutcome = { kind: "done"; task: TrackerTask } | { kind: "refused"; code: string; message: string; task: TrackerTask | null } | { kind: "missing" };
/** Marks a task done in Task Tracker with its own completion rules (Resolve). Repeating it keeps the first completion. */
export async function completeTrackerTask(key: string): Promise<CompleteOutcome> {
  const c = cfg();
  const r = await sendJson(c.origin, "POST", `/api/planning/v1/tasks/${encodeURIComponent(key)}/complete`, c.headers, {}, LABEL, PLANNING_TIMEOUT_MS);
  if (r.status === 200 && validTask(r.body?.task)) return { kind: "done", task: r.body.task };
  if (r.status === 404) return { kind: "missing" };
  if (r.status === 409 || r.status === 422) return { kind: "refused", code: r.body?.error?.code ?? "refused", message: r.body?.error?.message ?? "Task Tracker refused the completion.", task: validTask(r.body?.error?.details?.task) ? r.body.error.details.task : null };
  throw failure(r.status, r.body, "Task Tracker did not complete the task.");
}
