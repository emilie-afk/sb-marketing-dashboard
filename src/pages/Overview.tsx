import { useApi, Async, Section, range, money, BUSINESS_NAMES } from "../lib";
import { BusinessPanel, TrendPanel, AdvertisingBlock, PromotionList, WorkBlock, ProductsBlock, PeriodBar } from "../components";
import type { Period } from "../App";

export const periodQuery = (p: Period) => (p ? `?start=${p.start}&end=${p.end}&compare=${p.compare}` : "");

export function Overview({ period, setPeriod }: { period: Period; setPeriod: (p: Period) => void }) {
  const s = useApi<any>(`/overview${periodQuery(period)}`, [period]);
  return (
    <Async s={s}>{(d) => d.empty ? <div className="state">{d.message} Register sources in <a href="#/settings">Settings</a>.</div> : (
      <>
        <PeriodBar start={d.period.start} end={d.period.end} compare={d.comparison?.kind ?? "none"} onChange={(a, b, c) => setPeriod({ start: a, end: b, compare: c })}
          note={`Showing ${d.period.label}${d.comparison ? `, compared with ${range(d.comparison)}` : ""}${d.comparison?.clamped ? " (month-end adjusted)" : ""}.`} />
        {d.status.staleCount > 0 && <div className="notice">Some sources are outdated or failing, so parts of this page may be incomplete. See <a href="#/settings">Settings</a>.</div>}

        <Section n={1} title="Business performance" sub="Each business uses its own sources. No combined conversion rate, CPA or ROAS is calculated across businesses.">
          <div className="grid">{d.businesses.map((b: any) => <BusinessPanel key={b.id} b={b} />)}</div>
          {d.sbChannels.total.revenue !== null && (
            <div className="card flat" style={{ marginTop: 12 }}>
              <h3>Succulents Box channels</h3>
              <div className="table-wrap"><table><thead><tr><th>Channel</th><th className="n">Revenue</th><th className="n">Orders</th></tr></thead><tbody>
                {d.sbChannels.tracked.map((c: any) => <tr key={c.scope}><td>{c.label}</td><td className="n">{money(c.revenue)}</td><td className="n">{c.orders ?? "Missing"}</td></tr>)}
                <tr><td>Other channels (not itemized)</td><td className="n">{money(d.sbChannels.otherRevenue)}</td><td className="n"></td></tr>
                <tr><td><b>All channels (reported total)</b></td><td className="n"><b>{money(d.sbChannels.total.revenue)}</b></td><td className="n"><b>{d.sbChannels.total.orders ?? ""}</b></td></tr>
              </tbody></table></div>
              <div className="sub">{d.sbChannels.note}</div>
            </div>)}
        </Section>

        <Section n={2} title="Trends" sub="A few charts by default. Choose more metrics below each set.">
          <TrendPanel trends={d.trends} initial={["sb:revenue", "sb:conversion_rate", "sb:roas", "p2s:revenue"]} />
        </Section>

        <Section n={3} title="Advertising" sub={`By business, then platform. ${d.period.label}.`}>
          <AdvertisingBlock platforms={d.advertising} />
        </Section>

        <Section n={4} title="Promotions" sub={d.promotions.note}>
          <div className="grid g2">
            <div><h3 style={{ marginBottom: 6 }}>Current</h3><PromotionList items={d.promotions.current} onOpen={(id) => (location.hash = `#/sb/promotions/${id}`)} /></div>
            <div><h3 style={{ marginBottom: 6 }}>Upcoming (next 45 days)</h3><PromotionList items={d.promotions.upcoming} onOpen={(id) => (location.hash = `#/sb/promotions/${id}`)} /></div>
          </div>
        </Section>

        <Section n={5} title="Marketing work" sub={`Deadlines in Vietnam time. Today is ${d.today}.`}>
          <WorkBlock work={d.work} />
        </Section>

        <Section n={6} title="Products and vendors" sub={`${BUSINESS_NAMES.sb}, ${d.period.label}.`} right={<a href="#/sb/vendors">Open vendors</a>}>
          <ProductsBlock p={d.products} onVendor={(id) => (location.hash = `#/sb/vendors/${id}`)} />
        </Section>

        <Section n={7} title="Latest reports" right={<a href="#/reports">All reports</a>}>
          {d.reports.length ? <ul className="list">{d.reports.map((r: any) => (
            <li key={r.id}><a href={`#/reports/${r.id}`}><b>{r.title}</b></a> <span className="chip muted">{r.kind}</span>
              <span className="sub"> {range({ start: r.period_start, end: r.period_end })} · {r.published_revision ? `revision ${r.published_revision} published` : "draft only"}</span></li>))}</ul>
            : <div className="state">No reports yet.</div>}
        </Section>
      </>)}
    </Async>
  );
}
