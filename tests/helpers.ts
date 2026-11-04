// Test harness: a real PostgreSQL database (TEST_DATABASE_URL), rebuilt from the migrations for each file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPool, closePool } from "../server/db";
import { createApp } from "../server/app";
import { issueSession } from "../server/auth";
import { _resetDefsCache } from "../server/metricQuery";
import { _setBlobStoreForTests } from "../server/blobStore";
import { checkSubmission } from "../shared/submission";
import { applySubmission } from "../server/imports";

export async function freshDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to a disposable database (its schema is dropped).");
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-123";
  process.env.TEAM_MEMBERS = "viewer@example.test:viewer,editor@example.test:editor,admin@example.test:admin";
  process.env.LOCAL_BLOB_DIR = mkdtempSync(join(tmpdir(), "mkd-blobs-"));
  _setBlobStoreForTests(null);
  await closePool();
  const pool = getPool();
  await pool.query("drop schema public cascade; create schema public;");
  const { migrate } = await import("../scripts/migrate");
  await migrate(() => {});
  _resetDefsCache();
}

export const app = createApp();
const cookies: Record<string, string> = {};
export async function as(role: "viewer" | "editor" | "admin" | "outsider") {
  const email = `${role}@example.test`;
  cookies[role] ??= await issueSession({ sub: `sub-${role}`, email });
  return cookies[role];
}
export async function call(role: "viewer" | "editor" | "admin" | "outsider" | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (role) h.cookie = `mkd_session=${await as(role)}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
  const r = await app(new Request(`http://localhost/api${path}`, { method, headers: h, body: payload }));
  const ct = r.headers.get("content-type") ?? "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.arrayBuffer(), headers: r.headers };
}

export async function submit(body: any, source = "submission.api", submitter = "test:a") {
  const c = checkSubmission(body);
  if (!c.ok) throw new Error(JSON.stringify(c.errors));
  return applySubmission(c.value, "test", source, submitter);
}
export const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;
export { closePool };
