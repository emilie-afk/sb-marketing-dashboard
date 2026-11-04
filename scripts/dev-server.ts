// Local preview: serves the built SPA (dist/) and the same API handler as the Netlify function.
// Usage: npm run build && DATABASE_URL=... npm run dev
// LOCAL_DEV_LOGIN=1 adds /dev/login?role=viewer|editor|admin with placeholder identities. It refuses to run
// on Netlify or in production, and the deployed function has no such route.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { createApp } from "../server/app";
import { issueSession } from "../server/auth";
import { isDeployedRuntime } from "../server/runtime";

if (isDeployedRuntime()) throw new Error("dev-server is for local use only");
const devLogin = process.env.LOCAL_DEV_LOGIN === "1";
if (devLogin) {
  process.env.SESSION_SECRET ||= "local-dev-only-secret-local-dev-only-secret";
  process.env.TEAM_MEMBERS ||= "viewer@example.test:viewer,editor@example.test:editor,admin@example.test:admin";
  process.env.LOCAL_BLOB_DIR ||= join(import.meta.dirname, "..", ".local-blobs");
  process.env.DEMO_DATA_BANNER = "1";
  process.env.TRACKED_CHANNELS ||= "online_store:Shopify website,amazon:Amazon,faire:Faire";
  process.env.EXCLUDED_BRANDS ||= "Excluded Demo Brand";
}
const app = createApp();
const dist = join(import.meta.dirname, "..", "dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const port = Number(process.env.PORT ?? 8888);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (devLogin && url.pathname === "/dev/login") {
    const role = ["viewer", "editor", "admin"].includes(url.searchParams.get("role") ?? "") ? url.searchParams.get("role") : "editor";
    const token = await issueSession({ sub: `local-${role}`, email: `${role}@example.test` });
    res.writeHead(302, { location: url.searchParams.get("next") ?? "/", "set-cookie": `mkd_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end();
  }
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await app(new Request(url, { method: req.method, headers: req.headers as Record<string, string>,
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks), duplex: "half" } as RequestInit));
    const headers: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => { headers[k] = k === "set-cookie" ? r.headers.getSetCookie() : v; });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = normalize(join(dist, url.pathname === "/" ? "index.html" : url.pathname));
  const safe = file.startsWith(dist) ? file : join(dist, "index.html");
  try {
    const body = await readFile(safe);
    res.writeHead(200, { "content-type": TYPES[extname(safe)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(await readFile(join(dist, "index.html")));
  }
}).listen(port, "127.0.0.1", () => console.log(`Preview on http://localhost:${port}${devLogin ? " (local dev login: /dev/login?role=editor)" : ""}`));
