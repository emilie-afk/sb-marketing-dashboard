// Background function (Netlify runs "-background" functions for up to 15 minutes and answers the caller with 202
// at once). Runs one queued sync job. Accepts only requests signed by this app (see server/syncJobs.ts).
import { runJob, verifyJobRequest, jobHeaders } from "../../server/syncJobs";
import { logServerError } from "../../server/redact";

export default async (req: Request) => {
  try {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = await req.text();
    if (body.length > 1000 || !verifyJobRequest(body, req.headers.get(jobHeaders.TS_HEADER), req.headers.get(jobHeaders.SIG_HEADER))) {
      return new Response(null, { status: 401 });
    }
    const id = (JSON.parse(body) as { job_id?: unknown }).job_id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 400 });
    await runJob(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    logServerError("sync-background", e);
    return new Response(null, { status: 500 });
  }
};
