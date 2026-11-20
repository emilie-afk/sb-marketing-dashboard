import { useEffect, useState } from "react";
import { api, useApi, when } from "./lib";
import { Overview } from "./pages/Overview";
import { Business } from "./pages/Business";
import { CalendarPage } from "./pages/Calendar";
import { TasksPage } from "./pages/Tasks";
import { ReportsPage } from "./pages/Reports";
import { ToolboxPage } from "./pages/Toolbox";
import { SettingsPage } from "./pages/Settings";
import { PlanningPage } from "./pages/Planning";

const NAV: [string, string][] = [
  ["", "Marketing Overview"], ["sb", "Succulents Box"], ["p2s", "P2S"], ["perksradar", "Perksradar"],
  ["calendar", "Marketing Calendar"], ["planning", "Marketing Planning"], ["tasks", "Marketing Tasks"], ["reports", "Reports"], ["toolbox", "Toolbox"], ["settings", "Settings"],
];

export type Period = { start: string; end: string; compare: string } | null;

function useHash() {
  const [h, set] = useState(location.hash.replace(/^#\/?/, ""));
  useEffect(() => { const f = () => set(location.hash.replace(/^#\/?/, "")); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}

export function App() {
  const me = useApi<any>("/me");
  const hash = useHash();
  const [section, sub, sub2] = hash.split("?")[0].split("/");
  const [period, setPeriod] = useState<Period>(null);

  if (me.loading) return <div className="shell"><div className="state">Loading…</div></div>;
  if (!me.data?.signedIn) return <SignIn error={new URLSearchParams(location.search).get("auth_error")} />;
  const role = me.data.role as "viewer" | "editor" | "admin";
  const page = (() => {
    switch (section) {
      case "": case undefined: return <Overview period={period} setPeriod={setPeriod} />;
      case "sb": case "p2s": case "perksradar": return <Business id={section} tab={sub} period={period} setPeriod={setPeriod} role={role} />;
      case "calendar": return <CalendarPage role={role} planningOwner={!!me.data.planningOwner} />;
      case "planning": return <PlanningPage id={sub} sub={sub2} />;
      case "tasks": return <TasksPage role={role} />;
      case "reports": return <ReportsPage role={role} />;
      case "toolbox": return <ToolboxPage />;
      case "settings": return <SettingsPage role={role} />;
      default: return <div className="state">Page not found.</div>;
    }
  })();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/doodle.png" alt="" />
          <div><h1>Marketing Dashboard</h1><div className="label">Succulents Box · Marketing Workspace</div></div>
        </div>
        <div className="who">
          <StatusPill />
          <span>{me.data.email} · {role}</span>
          <button className="btn small" onClick={async () => { await api("/auth/logout", { method: "POST" }); location.href = "/"; }}>Sign out</button>
        </div>
      </header>
      <nav className="nav" aria-label="Main">
        {NAV.map(([k, l]) => <a key={k} href={`#/${k}`} className={(section ?? "") === k ? "active" : ""} aria-current={(section ?? "") === k ? "page" : undefined}>{l}</a>)}
      </nav>
      {me.data.demo && <div className="demo-banner" role="note">Synthetic demo data. These figures are invented for local review and are not live results.</div>}
      {page}
    </div>
  );
}

function StatusPill() {
  const s = useApi<any>("/status");
  if (!s.data) return null;
  const n = s.data.staleCount;
  const lastOk = s.data.sources.map((x: any) => x.last_success_at).filter(Boolean).sort().pop();
  const wk = s.data.weekly;
  // Missing weekly figures are named first: a sync that ran but brought nothing is not "up to date".
  const text = wk?.missing?.length ? `Weekly figures for ${wk.week.label} not received` : n ? `${n} source${n === 1 ? "" : "s"} need attention` : "Sources up to date";
  const title = wk?.missing?.length ? `Missing for ${wk.week.label}: ${wk.missing.join("; ")}. Last successful update: ${when(lastOk)}` : `Last successful update: ${when(lastOk)}`;
  return <a href="#/settings" className={`status-pill ${n ? "warn" : ""}`} title={title}>
    <span className={`dot ${n ? "warn" : ""}`} />{text}</a>;
}

function SignIn({ error }: { error: string | null }) {
  const msg: Record<string, string> = { not_authorized: "That Google account is not approved for this dashboard.", expired: "The sign-in took too long. Try again.", failed: "Sign-in failed. Try again." };
  return (
    <div className="shell" style={{ maxWidth: 520, paddingTop: 80 }}>
      <div className="card">
        <div className="brand"><img src="/doodle.png" alt="" /><div><h1>Marketing Dashboard</h1><div className="label">Succulents Box · Marketing Workspace</div></div></div>
        <p>Internal dashboard for the marketing team. Sign in with an approved team Google account.</p>
        {error && <div className="state error">{msg[error] ?? msg.failed}</div>}
        <p><a className="btn primary" href="/api/auth/login">Sign in with Google</a></p>
        <p className="sub">Looking for the public tool list? <a href="https://sb-marketing.netlify.app/">Open the Toolbox</a>.</p>
      </div>
    </div>
  );
}
