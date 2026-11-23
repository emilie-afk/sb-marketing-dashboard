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
        <img className="signin-logo" src="data:image/png;base64,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" alt="Succulents Box" width={120} height={14} />
        <div className="brand"><img src="/doodle.png" alt="" /><div><h1>Marketing Dashboard</h1><div className="label">Succulents Box · Marketing Workspace</div></div></div>
        <p>Internal dashboard for the marketing team. Sign in with an approved team Google account.</p>
        {error && <div className="state error">{msg[error] ?? msg.failed}</div>}
        <p><a className="btn primary" href="/api/auth/login">Sign in with Google</a></p>
        <p className="sub">Looking for the public tool list? <a href="https://sb-marketing.netlify.app/">Open the Toolbox</a>.</p>
      </div>
    </div>
  );
}
