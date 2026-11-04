import { useEffect, useState, useCallback, ReactNode } from "react";
import { formatFig, formatChange, Fig, Unit, Change } from "../shared/metrics";
import { formatRange } from "../shared/dates";

export class ApiError extends Error { constructor(public status: number, msg: string, public details?: any) { super(msg); } }

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init, credentials: "same-origin",
    headers: init?.json !== undefined ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, data?.error?.message ?? data?.message ?? `Request failed (${r.status})`, data?.error?.details ?? data?.errors);
  return data as T;
}

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [state, set] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const load = useCallback(() => {
    if (!path) return;
    set((s) => ({ ...s, loading: true, error: null }));
    api<T>(path).then((data) => set({ data, error: null, loading: false })).catch((error) => set({ data: null, error, loading: false }));
  }, [path, ...deps]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

export function Async<T>({ s, children, empty }: { s: { data: T | null; error: ApiError | null; loading: boolean }; children: (d: T) => ReactNode; empty?: string }) {
  if (s.loading && !s.data) return <div className="state" role="status">Loading…</div>;
  if (s.error) return <div className="state error" role="alert">Could not load: {s.error.message}</div>;
  if (!s.data) return <div className="state">{empty ?? "Nothing to show."}</div>;
  return <>{children(s.data)}</>;
}

export const fmt = (f: Fig | null | undefined, unit: Unit) => (f ? formatFig(f as any, unit) : "Missing");
export const fmtChange = (c: Change | null | undefined, unit: Unit) => (c ? formatChange(c, unit) : "");
export const range = (r: { start: string; end: string } | null | undefined) => (r ? formatRange(r) : "");
export const money = (v: number | null | undefined) => (v === null || v === undefined ? "Missing" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "N/A" : `${v.toFixed(1)}%`);
export const BUSINESS_NAMES: Record<string, string> = { sb: "Succulents Box", p2s: "P2S", perksradar: "Perksradar" };
export const PLATFORM_NAMES: Record<string, string> = { google: "Google Ads", facebook: "Facebook / Meta", amazon: "Amazon Ads", etsy: "Etsy Ads", tiktok: "TikTok" };
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Never");

export function Section({ n, title, sub, right, children }: { n?: number; title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header><div><h2>{n !== undefined && <span className="num">{n}</span>}{title}</h2>{sub && <div className="sub">{sub}</div>}</div>{right}</header>
      {children}
    </section>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? "active" : ""} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

export function ChangeText({ c, unit }: { c: Change; unit: Unit }) {
  const cls = c.sentiment === "good" ? "good" : c.sentiment === "bad" ? "bad" : "neutral";
  return <span className={cls}>{fmtChange(c, unit)}</span>;
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return <><div className="drawer-bg" onClick={onClose} /><aside className="drawer" role="dialog" aria-modal="true"><button className="btn small close" onClick={onClose}>Close</button>{children}</aside></>;
}

export function Unavailable({ title, reason }: { title: string; reason: string }) {
  return <div className="state unavailable"><b>{title}: unavailable.</b> {reason}</div>;
}
