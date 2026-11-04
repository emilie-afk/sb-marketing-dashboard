// P2S Etsy listing reviews: ingested from the scheduled competitor check (no browser automation here).
import { z } from "zod";
import type { Router } from "../router";
import { query, one, tx } from "../db";
import { badRequest, notFound, readJson, HttpError } from "../http";
import { pricePosition, sampleLabel, canApprove, findingLabel, diffChecks, Option } from "../../shared/listingReview";
import { applyFindingCorrections } from "../imports";
import { createTask } from "./work";
import { audit } from "../audit";

export function registerReviews(r: Router) {
  r.get("/listing-reviews", async () => ({
    runs: await query(`select run_id, to_char(window_start,'YYYY-MM-DD') window_start, to_char(window_end,'YYYY-MM-DD') window_end, timezone, collected_at, scope_note,
                              excluded_listing_ids, status, (select count(*) from listing_results l where l.run_id = r.run_id)::int listings
                         from listing_review_runs r order by window_end desc, collected_at desc`),
    note: "Each check covers its own last-30-days window. Windows overlap, so checks are shown one at a time and never added together.",
  }));

  r.get("/listing-reviews/:run", async ({ params }) => {
    const run = await one<any>("select *, to_char(window_start,'YYYY-MM-DD') window_start, to_char(window_end,'YYYY-MM-DD') window_end from listing_review_runs where run_id = $1", [params.run]);
    if (!run) throw notFound("Listing check");
    const prev = await one<any>("select run_id from listing_review_runs where window_end < $1 and status = 'active' order by window_end desc limit 1", [run.window_end]);
    const listings = await query<any>("select run_id, listing_id, title, url, clicks::float8 clicks, orders::float8 orders, spend::float8 spend from listing_results where run_id = $1 order by clicks desc nulls last", [params.run]);
    const opts = await query<any>("select listing_id, option_key, label, format, size, pages, pack_qty, addons, price::float8 price from listing_options where run_id = $1 order by price", [params.run]);
    const kws = await query<any>("select listing_id, keyword, kind, views::float8 views, clicks::float8 clicks, orders::float8 orders from listing_keywords where run_id = $1 order by kind, clicks desc nulls last", [params.run]);
    const comps = await query<any>("select id::text, listing_id, keyword, competitor_listing_id, competitor_url, competitor_title, option_label, format, size, pages, pack_qty, addons, price::float8 price, original_price::float8 original_price, price_basis, bestseller, review_count from competitor_options where run_id = $1 order by listing_id, price", [params.run]);
    const samples = await query<any>("select keyword, sample_size, sampling_scope, min_price::float8 min_price, median_price::float8 median_price, max_price::float8 max_price, pct_digital::float8 pct_digital from market_samples where run_id = $1", [params.run]);
    const findings = await query<any>(
      `select f.*, (select json_agg(json_build_object('decision', d.decision, 'decided_by', d.decided_by, 'decided_at', d.decided_at, 'note', d.note, 'task_id', d.task_id,
                                                     'implemented_at', d.implemented_at, 'implementation_note', d.implementation_note) order by d.decided_at) from action_decisions d where d.finding_id = f.id) as decisions,
              (select json_agg(json_build_object('reason', c.reason, 'corrected_by', c.corrected_by, 'corrected_at', c.corrected_at)) from finding_corrections c where c.supersedes_finding_id = f.id) as corrections
         from findings f where f.run_id = $1 order by f.listing_id nulls last, f.created_at`, [params.run]);
    const prevListings = prev ? await query<any>("select listing_id, clicks::float8 clicks, orders::float8 orders, spend::float8 spend from listing_results where run_id = $1", [prev.run_id]) : [];
    const prevOpts = prev ? await query<any>("select listing_id, label, format, price::float8 price from listing_options where run_id = $1", [prev.run_id]) : [];
    return {
      run, previousRunId: prev?.run_id ?? null,
      listings: listings.map((l) => {
        const ours: Option[] = opts.filter((o) => o.listing_id === l.listing_id);
        const theirs = comps.filter((c) => c.listing_id === l.listing_id);
        const p = prevListings.find((x) => x.listing_id === l.listing_id);
        return {
          ...l, options: ours,
          keywords: kws.filter((k) => k.listing_id === l.listing_id).map((k) => ({ ...k, label: k.kind === "fallback_title_phrase" ? "Fallback title phrase (not a reported keyword)" : "Reported keyword" })),
          competitors: theirs,
          positions: ours.map((o) => pricePosition(o, theirs)),
          samples: samples.filter((s) => kws.some((k) => k.listing_id === l.listing_id && k.keyword === s.keyword)).map((s) => ({ ...s, label: sampleLabel(s) })),
          findings: findings.filter((f) => f.listing_id === l.listing_id).map((f) => ({ ...f, label: findingLabel({ ...f, key: f.finding_key }) })),
          changesSincePrevious: p ? diffChecks({ ...p, options: prevOpts.filter((o) => o.listing_id === l.listing_id) }, { ...l, options: ours }) : null,
          newSincePrevious: !!prev && !p,
        };
      }),
      generalFindings: findings.filter((f) => !f.listing_id).map((f) => ({ ...f, label: findingLabel({ ...f, key: f.finding_key }) })),
    };
  });

  // Decision on a finding. Approval is required before a task can be created from it.
  r.post("/findings/:id/decision", async ({ req, params, session }) => {
    const body = z.object({ decision: z.enum(["approved", "rejected", "deferred"]), note: z.string().max(2000).optional(),
      create_task: z.object({ title: z.string().trim().min(1).max(300), owner: z.string().max(120).optional(), due_date: z.string().optional() }).optional() }).safeParse(await readJson(req));
    if (!body.success) throw badRequest("Invalid decision.");
    return tx(async (c) => {
      const f = (await c.query("select f.*, r.business_id from findings f join listing_review_runs r on r.run_id = f.run_id where f.id = $1 for update of f", [params.id])).rows[0];
      if (!f) throw notFound("Finding");
      if (body.data.decision === "approved") {
        const ok = canApprove({ key: f.finding_key, state: f.state, depends_on: f.depends_on, is_suggestion: f.is_suggestion, sensitive_topic: f.sensitive_topic });
        if (!ok.ok) throw new HttpError(409, "not_approvable", ok.reason!);
      }
      if (body.data.create_task && body.data.decision !== "approved") throw badRequest("Only approved findings can become tasks.");
      let taskId: string | null = null;
      if (body.data.create_task) {
        taskId = await createTask({ title: body.data.create_task.title, business_id: f.business_id, activity: "Listing improvement", owner: body.data.create_task.owner ?? null,
          status: "todo", due_date: body.data.create_task.due_date ?? null,
          links: [{ target_type: "finding", target_id: f.id, label: f.statement.slice(0, 120) }, ...(f.listing_id ? [{ target_type: "listing" as const, target_id: f.listing_id }] : [])] }, session.email, "finding_approval", c);
      }
      await c.query("insert into action_decisions (finding_id, decision, decided_by, note, task_id) values ($1,$2,$3,$4,$5)", [params.id, body.data.decision, session.email, body.data.note ?? null, taskId]);
      await audit(session.email, `finding.${body.data.decision}`, "finding", params.id);
      return { ok: true, task_id: taskId };
    });
  });

  r.post("/findings/:id/implemented", async ({ req, params, session }) => {
    const body = z.object({ note: z.string().trim().min(1).max(2000) }).safeParse(await readJson(req));
    if (!body.success) throw badRequest("Describe what was implemented.");
    const d = await one("update action_decisions set implemented_at = now(), implementation_note = $2 where id = (select id from action_decisions where finding_id = $1 and decision = 'approved' order by decided_at desc limit 1) returning id", [params.id, body.data.note]);
    if (!d) throw new HttpError(409, "not_approved", "Only an approved finding can be marked as implemented.");
    await audit(session.email, "finding.implemented", "finding", params.id);
    return { ok: true };
  });

  // Manual correction from the dashboard: supersedes the finding (history kept) and flags dependents.
  r.post("/findings/:id/correct", async ({ req, params, session }) => {
    const body = z.object({ reason: z.string().trim().min(3).max(1000) }).safeParse(await readJson(req));
    if (!body.success) throw badRequest("A reason is required.");
    return tx(async (c) => {
      const f = (await c.query("select run_id, finding_key from findings where id = $1", [params.id])).rows[0];
      if (!f) throw notFound("Finding");
      await applyFindingCorrections(c, [{ supersedes_run_id: f.run_id, supersedes_finding_key: f.finding_key, reason: body.data.reason }], session.email);
      return { ok: true };
    });
  });
}
