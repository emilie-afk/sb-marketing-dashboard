// getJson with named options: the pull-check header callback and the caller-owned deadline work together, and
// redirect rejection and the body-size limit still apply. Fictional data only; no network.
import { describe, it, expect, afterEach } from "vitest";
import { getJson, CLIENT_LIMITS, _setReportingFetchForTests } from "../server/adapters/reportingClient";

const ORIGIN = "https://source.example.test";
const use = (f: (url: string, init: any) => Promise<Response> | Response) => _setReportingFetchForTests(((u: any, init: any) => f(String(u), init)) as any);
afterEach(() => _setReportingFetchForTests(null));

/** A 200 response whose body arrives after `ms`. */
const slowBody = (ms: number, headers: Record<string, string> = {}) => new Response(new ReadableStream({
  start(c) { setTimeout(() => { try { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close(); } catch { /* cancelled */ } }, ms); },
}), { status: 200, headers });

describe("getJson options", () => {
  it("passes the accepted response's headers to onHeaders and returns the body within the deadline", async () => {
    use(() => new Response('{"ok":true}', { status: 200, headers: { "x-reporting-key-slot": "1,2" } }));
    let slot: string | null = null;
    const out = await getJson(ORIGIN, "/x", {}, "Source", { deadline: Date.now() + 1_000, onHeaders: (h) => { slot = h.get("x-reporting-key-slot"); } });
    expect(out).toEqual({ ok: true });
    expect(slot).toBe("1,2");
  });
  it("still enforces the deadline on the body when onHeaders is given", async () => {
    use(() => slowBody(400, { "x-reporting-key-slot": "2" }));
    let called = 0;
    const t0 = Date.now();
    await expect(getJson(ORIGIN, "/x", {}, "Source", { deadline: Date.now() + 100, onHeaders: () => { called++; } }))
      .rejects.toMatchObject({ code: "source_timeout" });
    expect(Date.now() - t0).toBeLessThan(350);
    expect(called).toBe(1);
  });
  it("enforces the deadline while waiting for headers, even if the transport ignores the abort", async () => {
    use(() => new Promise<Response>((r) => setTimeout(() => r(new Response("{}")), 400)));
    let called = 0;
    const t0 = Date.now();
    await expect(getJson(ORIGIN, "/x", {}, "Source", { deadline: Date.now() + 100, onHeaders: () => { called++; } }))
      .rejects.toMatchObject({ code: "source_timeout" });
    expect(Date.now() - t0).toBeLessThan(350);
    expect(called).toBe(0);
  });
  it("refuses to start when the deadline has already passed", async () => {
    let fetched = 0;
    use(() => { fetched++; return new Response("{}"); });
    await expect(getJson(ORIGIN, "/x", {}, "Source", { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: "source_timeout" });
    expect(fetched).toBe(0);
  });
  it("never follows a redirect and does not show its headers to onHeaders", async () => {
    let redirect: string | undefined, called = 0;
    use((_u, init) => { redirect = init?.redirect; return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/", "x-reporting-key-slot": "1" } }); });
    await expect(getJson(ORIGIN, "/x", {}, "Source", { onHeaders: () => { called++; } })).rejects.toMatchObject({ code: "source_redirect" });
    expect(redirect).toBe("manual");
    expect(called).toBe(0);
  });
  it("rejects a body over the size limit", async () => {
    use(() => new Response("x".repeat(CLIENT_LIMITS.maxBytes + 1), { status: 200 }));
    await expect(getJson(ORIGIN, "/x", {}, "Source", { onHeaders: () => {} })).rejects.toMatchObject({ code: "source_too_large" });
  });
  it("works with no options (other adapters)", async () => {
    use(() => new Response('{"a":1}'));
    expect(await getJson(ORIGIN, "/x", {}, "Source")).toEqual({ a: 1 });
  });
});
