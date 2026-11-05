// POST /api/pull-check { source } — confirms that THIS deployment can read a reporting source with the credential
// it holds now. Used by the source apps' key-rotation workflows before they retire the previous key.
//
// Authentication: an automation token whose allowed sources include exactly "pull-check" ("*" does not count), so
// the permission is granted on purpose and revoked like any other token. The answer never contains figures, records,
// addresses, credentials or the source's response. It does contain:
//   result  one word about the connection;
//   key_id  a non-secret identifier of the key this deployment holds (16 hex characters of SHA-256 over
//           "sb-reporting-key-id:" + key), so a rotation can confirm the LIVE deployment holds its new key;
//   slots   which Worker key slot(s) accepted it ("1", "2"), as reported by the source.
import { createHash } from "node:crypto";
import { HttpError, json, readJson } from "./http";
import { clientFromRequest } from "./automation";
import { hit } from "./rateLimit";
import { originOf, getJson } from "./adapters/reportingClient";
import { grossProfitConfigured } from "./adapters/grossProfit";
import { plantBreakdownConfigured } from "./adapters/plantBreakdown";
import { corporateGiftingCredentials } from "./adapters/corporateGifting";

export const PULL_CHECK_PERMISSION = "pull-check";

type Probe = { configured: () => boolean; origin: () => string | null; path: string; headers: () => Record<string, string>; key: () => string | undefined; label: string };

export const keyId = (key: string) => createHash("sha256").update(`sb-reporting-key-id:${key}`).digest("hex").slice(0, 16);
const PROBES: Record<string, Probe> = {
  gross_profit: {
    configured: grossProfitConfigured, origin: () => originOf(process.env.GROSS_PROFIT_API_URL),
    path: "/v1/reporting/weeks?limit=1", headers: () => ({ "x-reporting-secret": process.env.GROSS_PROFIT_REPORTING_SECRET! }), key: () => process.env.GROSS_PROFIT_REPORTING_SECRET, label: "Gross Profit",
  },
  plant_breakdown: {
    configured: plantBreakdownConfigured, origin: () => originOf(process.env.PLANT_BREAKDOWN_API_URL),
    path: "/v1/reports", headers: () => ({ authorization: `Bearer ${process.env.PLANT_BREAKDOWN_REPORTING_KEY}` }), key: () => process.env.PLANT_BREAKDOWN_REPORTING_KEY, label: "Plant Revenue Breakdown",
  },
  corporate_gifting: {
    configured: corporateGiftingCredentials, origin: () => originOf(process.env.CORPORATE_GIFTING_API_URL),
    path: "/api/reporting/v1/months?limit=1", headers: () => ({ authorization: `Bearer ${process.env.CORPORATE_GIFTING_REPORTING_SECRET}` }), key: () => process.env.CORPORATE_GIFTING_REPORTING_SECRET, label: "Corporate Gifting",
  },
};

const RESULT_BY_CODE: Record<string, string> = {
  source_auth_failed: "unauthorized", source_disabled: "disabled", source_timeout: "unreachable",
  source_redirect: "unexpected_response", source_bad_response: "unexpected_response", source_too_large: "unexpected_response",
  source_failed: "source_error",
};

export async function pullCheck(req: Request): Promise<Response> {
  const client = await clientFromRequest(req);
  if (!client.allowed_sources.includes(PULL_CHECK_PERMISSION)) throw new HttpError(403, "forbidden", "This token may not run pull checks.");
  await hit({ bucket: `pullcheck:${client.id}`, limit: 60, windowSec: 3600 });
  const body = await readJson(req, 1_000).catch(() => null);
  const source = typeof body?.source === "string" ? body.source : "";
  const probe = Object.prototype.hasOwnProperty.call(PROBES, source) ? PROBES[source] : null;
  if (!probe) throw new HttpError(400, "invalid_request", "Unknown source.");
  if (!probe.configured()) return json({ source, result: "not_configured", key_id: null, slots: [] });
  const key_id = keyId(probe.key()!);
  let result = "ok", slots: string[] = [];
  try {
    const out = await getJson(probe.origin()!, probe.path, probe.headers(), probe.label, (h) => {
      slots = (h.get("x-reporting-key-slot") ?? "").split(",").filter((s) => s === "1" || s === "2");
    });
    if (!out || typeof out !== "object") result = "unexpected_response";
  } catch (e) {
    result = e instanceof HttpError ? (RESULT_BY_CODE[e.code] ?? "source_error") : "unreachable";
    slots = [];
  }
  return json({ source, result, key_id, slots });
}
