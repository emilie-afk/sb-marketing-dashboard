import { useState } from "react";
import data from "../toolbox.json";

export function ToolboxPage() {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const sections = data.sections.map((s) => ({ ...s, tools: s.tools.filter((t) => !needle || `${t.name} ${t.description} ${t.tag}`.toLowerCase().includes(needle)) })).filter((s) => s.tools.length);
  return (
    <div>
      <div className="toolbar">
        <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tool, task or tag" aria-label="Search tools" /></label>
        <span className="sub">Same list as the public <a href={data.source} target="_blank" rel="noreferrer">Toolbox</a>, which stays the source of this list.</span>
      </div>
      {!sections.length && <div className="state">No tools match "{q}".</div>}
      {sections.map((s) => (
        <section key={s.title} className="section">
          <header><h2><span className="num" style={{ background: s.tint }}>{s.icon}</span>{s.title}</h2></header>
          <div className="grid g3">{s.tools.map((t) => (
            <a key={t.url} className="card flat tool" href={t.url} target="_blank" rel="noreferrer">
              <div className="row"><span className="emoji" aria-hidden>{t.emoji}</span><b>{t.name}</b><span className="spacer" /><span className="chip muted">{t.tag}</span></div>
              <div className="sub" style={{ marginTop: 6 }}>{t.description}</div>
            </a>))}</div>
        </section>))}
    </div>
  );
}
