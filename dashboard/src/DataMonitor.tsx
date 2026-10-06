import { useEffect, useState } from "react";

// Data Monitor: sales per main market (orders, sales, AOV, units, discounts,
// sessions, conversion) and, for every market in the storefront's Kit vs Tiers
// split test, the two groups side by side with lift and significance.
// Data: GET /api/data-monitor (handlers/data-monitor.ts), cached 5 min.
// Sessions come from the theme's beacon (snippets/bundle-test-head.liquid in
// the Essence theme repo); groups from the order's `_bundle_test` attribute.

interface Cell {
  sessions: number;
  visitors: number;
  orders: number;
  convOrders: number;
  revenue: number;
  sales: number;
  units: number;
  discounts: number;
}
interface MarketData {
  total: Cell;
  kit: Cell;
  tier: Cell;
  untracked: number;
}
type MarketKey = "AU" | "US" | "CA" | "NZ" | "EU" | "INTL" | "GB" | "NON_UK" | "ALL";
interface Report {
  range: { since: string; until: string; start: string | null };
  trackingSince: string | null;
  markets: Record<MarketKey, MarketData>;
  daily: { day: string; total: Cell; kit: Cell; tier: Cell }[];
  untracked: { orders: number; revenue: number; bySource: Record<string, number> };
  ordersBeforeTracking: number;
  shopifyError: string | null;
  fetchedAt: string;
}

const MARKET_ROWS: { key: MarketKey; label: string; split: boolean }[] = [
  { key: "AU", label: "Australia", split: true },
  { key: "US", label: "United States", split: true },
  { key: "CA", label: "Canada", split: true },
  { key: "NZ", label: "New Zealand", split: true },
  { key: "EU", label: "Europe (EU)", split: true },
  { key: "INTL", label: "International", split: true },
  { key: "GB", label: "United Kingdom", split: false },
];

// Split test went live 2026-10-06 ~10:20 UTC (Essence 3.0) — the moment orders
// started carrying their group. Matches SPLIT_TEST_START in handlers/data-monitor.ts.
const TEST_START_ISO = "2026-10-06T10:20:00Z";
const TEST_START = "2026-10-06"; // same instant as an AEST day (8:20pm)

type PresetId = "launch" | "today" | "yesterday" | "7d" | "14d" | "30d" | "month" | "custom";
const PRESETS: { id: PresetId; label: string }[] = [
  { id: "launch", label: "Since test start" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "14d", label: "Last 14 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];
const PRESET_KEY = "dataMonitor.preset";

const DAY_MS = 86400_000;
const aestToday = () => new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10);
const shift = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function presetRange(id: PresetId): { since: string; until: string } {
  const t = aestToday();
  switch (id) {
    case "launch":
      return { since: TEST_START < t ? TEST_START : t, until: t };
    case "today":
      return { since: t, until: t };
    case "yesterday":
      return { since: shift(t, -1), until: shift(t, -1) };
    case "14d":
      return { since: shift(t, -13), until: t };
    case "30d":
      return { since: shift(t, -29), until: t };
    case "month":
      return { since: `${t.slice(0, 8)}01`, until: t };
    default:
      return { since: shift(t, -6), until: t };
  }
}

// ── Formatting & maths ───────────────────────────────────────────────────────

const money = (n: number, dp = 0) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: dp, minimumFractionDigits: dp }).format(n);
const int = (n: number) => new Intl.NumberFormat("en-AU").format(Math.round(n));
const pct = (n: number, dp = 2) => `${(n * 100).toFixed(dp)}%`;
const div = (a: number, b: number) => (b > 0 ? a / b : 0);
const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const aov = (c: Cell) => div(c.revenue, c.orders);
const crVisitor = (c: Cell) => div(c.convOrders, c.visitors);
// Revenue per visitor uses the same tracked-period orders as the conversion rate.
const rpv = (c: Cell) => div(c.revenue * div(c.convOrders, c.orders), c.visitors);
// Discount rate = discounts ÷ products before discounts (revenue is after discounts).
const discRate = (c: Cell) => div(c.discounts, c.revenue + c.discounts);
const upo = (c: Cell) => div(c.units, c.orders);
const lift = (kit: number, tier: number) => (tier > 0 && kit > 0 ? kit / tier - 1 : null);
const plural = (n: number, word: string) => `${int(n)} ${word}${n === 1 ? "" : "s"}`;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf). */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

interface Test {
  p: number | null; // two-sided p-value, Kit vs Tiers conversion per visitor
  needed: number | null; // visitors per group to detect a 10% relative lift (80% power, 5% two-sided)
}
function testOf(kit: Cell, tier: Cell): Test {
  const [v1, v2, o1, o2] = [kit.visitors, tier.visitors, kit.convOrders, tier.convOrders];
  let p: number | null = null;
  if (v1 > 0 && v2 > 0) {
    const pool = (o1 + o2) / (v1 + v2);
    const se = Math.sqrt(pool * (1 - pool) * (1 / v1 + 1 / v2));
    if (se > 0) p = 2 * (1 - phi(Math.abs((o1 / v1 - o2 / v2) / se)));
  }
  const base = div(o1 + o2, v1 + v2);
  let needed: number | null = null;
  if (base > 0) {
    const p1 = base, p2 = base * 1.1;
    needed = Math.ceil(((1.96 + 0.8416) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (p2 - p1) ** 2);
  }
  return { p, needed };
}

export function DataMonitor() {
  const [preset, setPreset] = useState<PresetId>(() => {
    try {
      const saved = localStorage.getItem(PRESET_KEY) as PresetId | null;
      return saved && saved !== "custom" && PRESETS.some((p) => p.id === saved) ? saved : "launch";
    } catch {
      return "launch";
    }
  });
  const [range, setRange] = useState(() => presetRange(preset));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ since: range.since, until: range.until });
      if (preset === "launch") qs.set("start", TEST_START_ISO);
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/data-monitor?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReport(data as Report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.since, range.until, preset === "launch"]);

  const choosePreset = (id: PresetId) => {
    setPreset(id);
    try {
      localStorage.setItem(PRESET_KEY, id);
    } catch {
      /* storage unavailable */
    }
    if (id !== "custom") setRange(presetRange(id));
  };

  return (
    <div style={styles.container}>
      <div style={styles.toolRow}>
        <div style={styles.presetGroup} role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`ads-chip${preset === p.id ? " active" : ""}`}
              aria-pressed={preset === p.id}
              onClick={() => choosePreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <span style={styles.customRange}>
              <input
                type="date"
                className="ads-date"
                value={range.since}
                max={range.until}
                onChange={(e) => e.target.value && setRange((r) => ({ ...r, since: e.target.value }))}
                aria-label="From"
              />
              <span style={{ color: "var(--text-muted)" }}>to</span>
              <input
                type="date"
                className="ads-date"
                value={range.until}
                min={range.since}
                max={aestToday()}
                onChange={(e) => e.target.value && setRange((r) => ({ ...r, until: e.target.value }))}
                aria-label="To"
              />
            </span>
          )}
        </div>
        <div style={styles.toolRight}>
          {report && (
            <span style={styles.meta}>
              Updated {new Date(report.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button style={styles.secondaryBtn} onClick={() => load(true)} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div style={styles.errorBox}>Couldn't load the data: {error}. Try Refresh.</div>}
      {report?.shopifyError && <div style={styles.errorBox}>Shopify orders unavailable: {report.shopifyError}</div>}
      {!report && loading && <div style={styles.empty}>Loading…</div>}

      {report && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity 0.15s" }}>
          <Headline r={report} />
          <Cards r={report} />
          <Daily r={report} />
          <Footnotes r={report} />
        </div>
      )}
    </div>
  );
}

function Headline({ r }: { r: Report }) {
  const all = r.markets.ALL.total;
  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: "Orders", value: int(all.orders) },
    { label: "Sales", value: money(all.sales), hint: "Order totals incl. shipping and tax, net of refunds (AUD)" },
    { label: "AOV", value: money(aov(all), 2), hint: "Products after discounts ÷ orders (AUD)" },
    { label: "Visitors", value: int(all.visitors) },
    { label: "Conversion", value: pct(crVisitor(all)), hint: "Orders ÷ visitors (orders since session tracking started)" },
    { label: "Units / order", value: div(all.units, all.orders).toFixed(1) },
  ];
  return (
    <div className="dm-kpis">
      {tiles.map((t) => (
        <div key={t.label} className="ads-kpi" title={t.hint}>
          <div className="ads-kpi-label">{t.label}</div>
          <div className="ads-kpi-value">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

type Status = { label: string; tone: "" | "good" | "bad"; detail: string };

/** Plain-English read of Kit vs Tiers for one market. */
function statusOf(kit: Cell, tier: Cell): Status {
  const t = testOf(kit, tier);
  const crLift = lift(crVisitor(kit), crVisitor(tier)) ?? 0;
  if (kit.visitors < 100 || tier.visitors < 100 || kit.convOrders + tier.convOrders < 10) {
    return {
      label: "Collecting data",
      tone: "",
      detail: `${int(kit.visitors + tier.visitors)} visitors and ${int(kit.convOrders + tier.convOrders)} orders so far — too early to read.`,
    };
  }
  const progress = t.needed ? `${pct(Math.min(1, div(Math.min(kit.visitors, tier.visitors), t.needed)), 0)} of the visitors needed to spot a 10% difference.` : "";
  if (t.p !== null && t.p < 0.05) {
    return crLift > 0
      ? { label: "Kit is winning", tone: "good", detail: `Significant (p = ${t.p.toFixed(3)}).` }
      : { label: "Tiers are winning", tone: "bad", detail: `Significant (p = ${t.p.toFixed(3)}).` };
  }
  return { label: "No clear winner yet", tone: "", detail: `p = ${t.p === null ? "–" : t.p.toFixed(2)} · ${progress}` };
}

function Lift({ label, value, judged }: { label: string; value: number | null; judged: boolean }) {
  const ok = value !== null && isFinite(value);
  const tone = !ok ? " none" : !judged ? "" : value! > 0.001 ? " good" : value! < -0.001 ? " bad" : "";
  return (
    <div className={`dm-lift${tone}`}>
      <span className="dm-lift-value">{ok ? `${value! > 0 ? "+" : ""}${(value! * 100).toFixed(0)}%` : "–"}</span>
      <span className="dm-lift-label">{label}</span>
    </div>
  );
}

function Side({ name, c }: { name: string; c: Cell }) {
  return (
    <div className={`dm-side ${name === "Kit" ? "kit" : "tier"}`}>
      <div className="dm-side-name">{name}</div>
      <div className="dm-pair">
        <div>
          <div className={`dm-big${c.visitors ? "" : " none"}`}>{c.visitors ? pct(crVisitor(c), 1) : "–"}</div>
          <div className="dm-cap">conversion</div>
        </div>
        <div>
          <div className={`dm-big${c.orders ? "" : " none"}`}>{c.orders ? money(aov(c), 0) : "–"}</div>
          <div className="dm-cap">AOV</div>
        </div>
      </div>
      <div className="dm-pair dm-minor">
        <div>
          <div className={`dm-big${c.orders ? "" : " none"}`}>{c.orders ? upo(c).toFixed(1) : "–"}</div>
          <div className="dm-cap">units / order</div>
        </div>
        <div>
          <div className={`dm-big${c.orders ? "" : " none"}`}>{c.orders ? pct(discRate(c), 1) : "–"}</div>
          <div className="dm-cap">discount rate</div>
        </div>
      </div>
      <div className="dm-small">
        {plural(c.orders, "order")} · {plural(c.visitors, "visitor")} · {money(c.revenue)}
      </div>
    </div>
  );
}

function MarketCard({ r, keyName, label, split, wide }: { r: Report; keyName: MarketKey; label: string; split: boolean; wide?: boolean }) {
  const m = r.markets[keyName];
  const t = m.total;
  const status = split ? statusOf(m.kit, m.tier) : null;
  const judged = status?.label !== "Collecting data";
  return (
    <div className={`dm-card${wide ? " wide" : ""}`}>
      <div className="dm-head">
        <h3 className="dm-market">{label}</h3>
        {status ? (
          <span className={`dm-status${status.tone ? ` ${status.tone}` : ""}`}>{status.label}</span>
        ) : (
          <span className="dm-status">Kit offer · not in test</span>
        )}
      </div>
      <div className="dm-sales">
        <span><b>{int(t.orders)}</b> {t.orders === 1 ? "order" : "orders"}</span>
        <span><b>{money(t.sales)}</b> sales</span>
        <span><b>{t.orders ? money(aov(t), 0) : "–"}</b> AOV</span>
        <span><b>{t.visitors ? pct(crVisitor(t), 1) : "–"}</b> conversion</span>
      </div>
      {split && status && (
        <>
          <div className="dm-compare">
            <Side name="Kit" c={m.kit} />
            <Side name="Tiers" c={m.tier} />
          </div>
          <div className="dm-lifts">
            <span className="dm-lifts-title">Kit vs Tiers</span>
            <Lift label="conversion" value={lift(crVisitor(m.kit), crVisitor(m.tier))} judged={judged} />
            <Lift label="AOV" value={lift(aov(m.kit), aov(m.tier))} judged={judged} />
            <Lift label="units / order" value={lift(upo(m.kit), upo(m.tier))} judged={judged} />
            <Lift label="revenue / visitor" value={lift(rpv(m.kit), rpv(m.tier))} judged={judged} />
          </div>
          <div className="dm-detail">{status.detail}</div>
        </>
      )}
    </div>
  );
}

function Cards({ r }: { r: Report }) {
  // Highest sales first; the UK (not in the test) always sits last.
  const rows = [...MARKET_ROWS].sort((a, b) => {
    if (a.key === "GB") return 1;
    if (b.key === "GB") return -1;
    return r.markets[b.key].total.sales - r.markets[a.key].total.sales || r.markets[b.key].total.orders - r.markets[a.key].total.orders;
  });
  return (
    <div className="dm-grid">
      <MarketCard r={r} keyName="NON_UK" label="All test markets" split wide />
      {rows.map((m) => (
        <MarketCard key={m.key} r={r} keyName={m.key} label={m.label} split={m.split} />
      ))}
    </div>
  );
}

function Daily({ r }: { r: Report }) {
  const days = [...r.daily].reverse();
  return (
    <details className="dm-daily">
      <summary>Daily breakdown</summary>
      <div className="ads-card ads-table-wrap">
        <table className="ads-table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Orders</th>
              <th className="num">Sales</th>
              <th className="num">AOV</th>
              <th className="num">Kit conv.</th>
              <th className="num">Kit orders</th>
              <th className="num">Tiers conv.</th>
              <th className="num">Tiers orders</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{shortDate(d.day)}</td>
                <td className="num">{int(d.total.orders)}</td>
                <td className="num">{money(d.total.sales)}</td>
                <td className="num">{money(aov(d.total), 2)}</td>
                <td className="num">{d.kit.visitors ? pct(crVisitor(d.kit)) : "–"}</td>
                <td className="num">{int(d.kit.orders)}</td>
                <td className="num">{d.tier.visitors ? pct(crVisitor(d.tier)) : "–"}</td>
                <td className="num">{int(d.tier.orders)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Footnotes({ r }: { r: Report }) {
  const sources = Object.entries(r.untracked.bySource)
    .map(([s, n]) => `${s} ${n}`)
    .join(", ");
  return (
    <p style={styles.footnote}>
      {r.range.start && `From the test start (${new Date(r.range.start).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}). `}
      Session tracking started{" "}
      {r.trackingSince ? new Date(r.trackingSince).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "— no sessions recorded yet"}
      ; conversion only counts orders placed since then
      {r.ordersBeforeTracking > 0 && ` (${int(r.ordersBeforeTracking)} earlier orders are in orders, sales and AOV only)`}.
      {r.untracked.orders > 0 && ` ${int(r.untracked.orders)} orders carry no test group (${sources}) — Shop app, Buy it now, drafts or carts from before launch; in market totals only.`}{" "}
      Kit / Tiers = the order's test group. AOV = products after discounts ÷ orders; discount rate = discounts ÷ products before discounts; sales = order totals incl. shipping and tax; both net of
      refunds, in AUD. Markets by shipping country; visitors by the storefront country they browsed. Differences are coloured once both groups
      have 100+ visitors and 10+ orders between them.
    </p>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    padding: "1.5rem",
    boxSizing: "border-box",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  toolRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap",
    marginBottom: "1.25rem",
    paddingBottom: "1rem",
    borderBottom: "1px solid var(--border)",
  },
  presetGroup: { display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" },
  customRange: { display: "inline-flex", gap: "0.4rem", alignItems: "center", marginLeft: "0.25rem" },
  toolRight: { display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" },
  meta: { fontSize: "0.8rem", color: "var(--text-muted)" },
  secondaryBtn: {
    padding: "0.45rem 1rem",
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  errorBox: {
    background: "var(--surface)",
    border: "1px solid #dc2626",
    color: "var(--text)",
    borderRadius: "8px",
    padding: "0.75rem 1rem",
    marginBottom: "1rem",
    fontSize: "0.85rem",
  },
  empty: { padding: "3rem", textAlign: "center", color: "var(--text-muted)" },
  section: { marginTop: "2rem" },
  sectionTitle: { margin: 0, fontSize: "1.05rem", fontWeight: 700 },
  sectionSub: { margin: "0.2rem 0 0.75rem", fontSize: "0.8rem", color: "var(--text-muted)" },
  verdict: { marginBottom: "0.75rem", fontSize: "0.9rem", lineHeight: 1.5, borderWidth: "1px", borderStyle: "solid" },
  footnote: { marginTop: "2rem", fontSize: "0.75rem", color: "var(--text-faint)", lineHeight: 1.5 },
};
