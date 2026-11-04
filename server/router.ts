import type { Session } from "./auth";

export type Ctx = { req: Request; url: URL; params: Record<string, string>; session: Session };
export type Handler = (ctx: Ctx) => Promise<Response | unknown>;
type Route = { method: string; re: RegExp; keys: string[]; role: "viewer" | "editor" | "admin"; h: Handler };

export class Router {
  routes: Route[] = [];
  add(method: string, path: string, role: Route["role"], h: Handler) {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, role, h });
  }
  get = (p: string, h: Handler, role: Route["role"] = "viewer") => this.add("GET", p, role, h);
  post = (p: string, h: Handler, role: Route["role"] = "editor") => this.add("POST", p, role, h);
  patch = (p: string, h: Handler, role: Route["role"] = "editor") => this.add("PATCH", p, role, h);
  delete = (p: string, h: Handler, role: Route["role"] = "admin") => this.add("DELETE", p, role, h);
  match(method: string, path: string) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? "method" : null;
  }
}
