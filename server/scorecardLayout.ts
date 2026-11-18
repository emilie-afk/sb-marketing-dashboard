// The figure workbooks' layout (which rows hold which figure) is private team configuration, read from the
// SCORECARD_LAYOUT server setting as JSON, or as "gz:" + base64 of gzipped JSON. It is never part of the repository.
import { gunzipSync } from "node:zlib";
import { HttpError } from "./http";
import { layoutProblems, ScorecardLayout } from "../shared/scorecardParse";

let cached: { raw: string; layout: ScorecardLayout } | null = null;

export function scorecardLayout(): ScorecardLayout {
  const raw = (process.env.SCORECARD_LAYOUT ?? "").trim();
  if (cached && cached.raw === raw) return cached.layout;
  if (!raw) throw new HttpError(503, "misconfigured", "The figure layout is not configured.");
  let parsed: unknown;
  try {
    const text = raw.startsWith("gz:") ? gunzipSync(Buffer.from(raw.slice(3), "base64")).toString("utf8") : raw;
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(503, "misconfigured", "The figure layout setting could not be read.");
  }
  const problems = layoutProblems(parsed);
  if (problems.length) throw new HttpError(503, "misconfigured", `The figure layout setting is incomplete (${problems.slice(0, 5).join(", ")}).`);
  cached = { raw, layout: parsed as ScorecardLayout };
  return cached.layout;
}
