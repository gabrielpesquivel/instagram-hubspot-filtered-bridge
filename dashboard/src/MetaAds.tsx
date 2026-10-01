import { Fragment, useEffect, useMemo, useRef, useState } from "react";

// Meta Ads: the numbers that matter from the ad account for a date range —
// what Meta claims (attributed ROAS) next to what Shopify actually took (MER),
// headline KPIs vs the previous equal-length period, a daily trend, campaigns
// with their ad sets, and the best / worst / most-fatigued ads.
// Data: GET /api/meta-ads (handlers/meta-ads.ts), cached 10 min server-side.

interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  purchases: number;
  revenue: number;
}

interface Totals extends Metrics {
  shopifyRevenue: number;
  shopifyOrders: number;
}

interface Budget {
  daily?: number;
  lifetime?: number;
}

interface AdSet extends Metrics {
  id: string;
  name: string;
  status: string;
  budget: Budget | null;
}

interface Campaign extends Metrics {
  id: string;
  name: string;
  objective?: string;
  status: string;
  budget: Budget | null;
  adsets: AdSet[];
}

interface Ad extends Metrics {
  id: string;
  name: string;
  campaign: string;
  adset: string;
  status: string | null;
  thumb: string | null;
}

interface DayRow {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
  shopifyRevenue: number | null;
}

interface Report {
  account: { id: string; name: string; currency: string; timezone: string };
  accounts: { id: string; name: string }[];
  range: { since: string; until: string };
  prev: { since: string; until: string };
  totals: { cur: Totals; prev: Totals };
  daily: DayRow[];
  campaigns: Campaign[];
  ads: Ad[];
  shopifyError: string | null;
  fetchedAt: string;
}

type PresetId = "today" | "yesterday" | "7d" | "14d" | "30d" | "month" | "custom";

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "14d", label: "Last 14 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];

// Ads seen this often by the same person are usually wearing out.
const FATIGUE_FREQ = 3;
const PRESET_KEY = "metaAds.preset";

const DAY_MS = 86400_000;
const aestToday = () => new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10);
const shift = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function presetRange(id: PresetId): { since: string; until: string } {
  const t = aestToday();
  switch (id) {
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

// ── Formatting ───────────────────────────────────────────────────────────────

let currency = "AUD";
const money = (n: number, dp = 0) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: dp, minimumFractionDigits: dp }).format(n);
const int = (n: number) => new Intl.NumberFormat("en-AU").format(Math.round(n));
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const ratio = (n: number) => `${n.toFixed(2)}×`;
const div = (a: number, b: number) => (b > 0 ? a / b : 0);
const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });

const roas = (m: Metrics) => div(m.revenue, m.spend);
const cpa = (m: Metrics) => div(m.spend, m.purchases);
const ctr = (m: Metrics) => div(m.clicks, m.impressions);
const cpm = (m: Metrics) => div(m.spend, m.impressions) * 1000;

function statusLabel(s: string | null): { text: string; tone: "on" | "off" | "warn" } {
  if (!s) return { text: "—", tone: "off" };
  if (s === "ACTIVE") return { text: "Active", tone: "on" };
  if (s.includes("PAUSED")) return { text: "Paused", tone: "off" };
  if (s === "WITH_ISSUES" || s === "DISAPPROVED" || s === "PENDING_BILLING_INFO") return { text: "Issue", tone: "warn" };
  if (s === "IN_PROCESS" || s === "PENDING_REVIEW") return { text: "In review", tone: "off" };
  return { text: s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " "), tone: "off" };
}

function budgetLabel(b: Budget | null): string {
  if (!b) return "—";
  if (b.daily != null) return `${money(b.daily)}/day`;
  if (b.lifetime != null) return `${money(b.lifetime)} total`;
  return "—";
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function MetaAds() {
  const [preset, setPreset] = useState<PresetId>(() => {
    try {
      const saved = localStorage.getItem(PRESET_KEY) as PresetId | null;
      return saved && saved !== "custom" && PRESETS.some((p) => p.id === saved) ? saved : "7d";
    } catch {
      return "7d";
    }
  });
  const [range, setRange] = useState(() => presetRange(preset));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ since: range.since, until: range.until });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/meta-ads?${qs}`);
      const data = await res.json();
      if (res.status === 409 && data.needsReconnect) {
        setNeedsReconnect(true);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNeedsReconnect(false);
      currency = data.account?.currency || "AUD";
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
  }, [range.since, range.until]);

  const choosePreset = (id: PresetId) => {
    setPreset(id);
    try {
      localStorage.setItem(PRESET_KEY, id);
    } catch {
      /* storage unavailable */
    }
    if (id !== "custom") setRange(presetRange(id));
  };

  const switchAccount = async (id: string) => {
    await fetch("/api/meta-ads/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  };

  if (needsReconnect) {
    return (
      <div style={styles.container}>
        <div style={styles.notice}>
          <h2 style={styles.noticeTitle}>Connect Meta to see ad data</h2>
          <p style={styles.noticeText}>
            The Meta connection doesn't have permission to read your ad account yet. Reconnect once and approve
            the <strong>ads_read</strong> permission — Instagram DMs keep working the same.
          </p>
          <a href="/auth/facebook" style={styles.primaryBtn}>
            Reconnect Meta
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Filters: one row above everything they scope */}
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
          {report && report.accounts.length > 1 && (
            <select
              className="ads-date"
              value={report.account.id}
              onChange={(e) => switchAccount(e.target.value)}
              aria-label="Ad account"
            >
              {report.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {report && (
            <span style={styles.meta}>Updated {new Date(report.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          )}
          <button style={styles.secondaryBtn} onClick={() => load(true)} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.errorBox}>
          Couldn't load ad data: {error}. Try Refresh. If it keeps failing,{" "}
          <a href="/auth/facebook" style={{ color: "var(--accent)" }}>
            reconnect Meta
          </a>{" "}
          and approve the ads permission.
        </div>
      )}

      {!report && loading && <div style={styles.empty}>Loading ad data…</div>}

      {report && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity 0.15s" }}>
          <Hero report={report} />
          <KpiStrip cur={report.totals.cur} prev={report.totals.prev} prevRange={report.prev} />
          <Section title="Daily trend" sub="Ad spend against the sales it's meant to drive">
            <TrendChart days={report.daily} />
          </Section>
          <Section title="Campaigns" sub="Click a campaign to see its ad sets · click a column to sort">
            <CampaignTable campaigns={report.campaigns} />
          </Section>
          <Section title="Ads" sub="Ranked by Meta-attributed ROAS · ads with too little spend to judge are left out">
            <AdBoards ads={report.ads} totalSpend={report.totals.cur.spend} />
          </Section>
          <p style={styles.footnote}>
            Meta figures use the ad account's default attribution (usually 7-day click, 1-day view) and can count a
            sale Shopify also credits elsewhere. Shopify sales are order totals incl. shipping and tax, net of refunds,
            by AEST day.
            {report.shopifyError && ` Shopify sales unavailable: ${report.shopifyError}.`}
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.sectionTitle}>{title}</h2>
      <p style={styles.sectionSub}>{sub}</p>
      {children}
    </section>
  );
}

// ── Hero: Meta's claim vs Shopify's till ─────────────────────────────────────

function Hero({ report }: { report: Report }) {
  const { cur, prev } = report.totals;
  const mer = div(cur.shopifyRevenue, cur.spend);
  const prevMer = div(prev.shopifyRevenue, prev.spend);
  const metaRoas = roas(cur);
  const share = div(cur.revenue, cur.shopifyRevenue);
  const hasShop = !report.shopifyError;

  return (
    <div className="ads-hero">
      <div className="ads-hero-col">
        <div className="ads-eyebrow">Meta says</div>
        <div className="ads-big">{ratio(metaRoas)}</div>
        <div className="ads-hero-sub">
          {money(cur.revenue)} in attributed sales from {money(cur.spend)} spend
        </div>
        <Delta cur={metaRoas} prev={roas(prev)} better="up" format={ratio} />
      </div>
      <div className="ads-hero-vs" aria-hidden="true">
        vs
      </div>
      <div className="ads-hero-col">
        <div className="ads-eyebrow">Shopify says (MER)</div>
        <div className="ads-big">{hasShop ? ratio(mer) : "—"}</div>
        <div className="ads-hero-sub">
          {hasShop
            ? `${money(cur.shopifyRevenue)} total sales across ${int(cur.shopifyOrders)} orders`
            : "Shopify sales unavailable"}
        </div>
        {hasShop && <Delta cur={mer} prev={prevMer} better="up" format={ratio} />}
      </div>
      {hasShop && cur.shopifyRevenue > 0 && (
        <div className="ads-share">
          <div className="ads-share-label">
            <span>Meta claims {Math.round(share * 100)}% of all Shopify sales</span>
            <span style={{ color: "var(--text-muted)" }}>
              {money(cur.revenue)} of {money(cur.shopifyRevenue)}
            </span>
          </div>
          <div
            className="ads-share-track"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(share, 1) * 100)}
            aria-label="Share of Shopify sales Meta attributes to ads"
          >
            <div className="ads-share-fill" style={{ width: `${Math.min(share, 1) * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── KPI strip ────────────────────────────────────────────────────────────────

function Delta({
  cur,
  prev,
  better,
  format,
}: {
  cur: number;
  prev: number;
  better: "up" | "down" | "neutral";
  format: (n: number) => string;
}) {
  if (!prev) return <div className="ads-delta">No data last period</div>;
  const change = (cur - prev) / prev;
  if (Math.abs(change) < 0.005) return <div className="ads-delta">Flat vs {format(prev)}</div>;
  const up = change > 0;
  const tone = better === "neutral" ? "" : (better === "up") === up ? " good" : " bad";
  return (
    <div className={`ads-delta${tone}`}>
      {up ? "▲" : "▼"} {Math.abs(change * 100).toFixed(0)}% <span className="ads-delta-was">vs {format(prev)}</span>
    </div>
  );
}

function KpiStrip({ cur, prev, prevRange }: { cur: Totals; prev: Totals; prevRange: Report["prev"] }) {
  const tiles: { label: string; value: (m: Totals) => number; format: (n: number) => string; better: "up" | "down" | "neutral" }[] = [
    { label: "Spend", value: (m) => m.spend, format: (n) => money(n), better: "neutral" },
    { label: "Purchases", value: (m) => m.purchases, format: int, better: "up" },
    { label: "Cost per purchase", value: cpa, format: (n) => money(n, 2), better: "down" },
    { label: "Link CTR", value: ctr, format: pct, better: "up" },
    { label: "CPM", value: cpm, format: (n) => money(n, 2), better: "down" },
    { label: "Frequency", value: (m) => m.frequency, format: (n) => n.toFixed(2), better: "neutral" },
  ];
  return (
    <>
      <div className="ads-kpis">
        {tiles.map((t) => (
          <div key={t.label} className="ads-kpi">
            <div className="ads-kpi-label">{t.label}</div>
            <div className="ads-kpi-value">{t.format(t.value(cur))}</div>
            <Delta cur={t.value(cur)} prev={t.value(prev)} better={t.better} format={t.format} />
          </div>
        ))}
      </div>
      <p style={styles.compareNote}>
        Compared with {shortDate(prevRange.since)}
        {prevRange.since !== prevRange.until && ` – ${shortDate(prevRange.until)}`}
      </p>
    </>
  );
}

// ── Trend chart ──────────────────────────────────────────────────────────────

const SERIES: { key: "spend" | "revenue" | "shopifyRevenue"; label: string; cls: string }[] = [
  { key: "spend", label: "Ad spend", cls: "s1" },
  { key: "revenue", label: "Meta-attributed sales", cls: "s2" },
  { key: "shopifyRevenue", label: "Shopify sales", cls: "s3" },
];

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function TrendChart({ days }: { days: DayRow[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = SERIES.filter((s) => s.key !== "shopifyRevenue" || days.some((d) => d.shopifyRevenue != null));
  const H = 260;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...days.flatMap((d) => series.map((s) => d[s.key] ?? 0))));
  const x = (i: number) => pad.l + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelIdx = days.length <= 1 ? [0] : days.length <= 8 ? days.map((_, i) => i) : [0, Math.floor((days.length - 1) / 2), days.length - 1];

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = days.length === 1 ? 0 : Math.round((px / rect.width) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  const hd = hover != null ? days[hover] : null;

  return (
    <div className="ads-card">
      <div className="ads-legend">
        {series.map((s) => (
          <span key={s.key} className="ads-legend-item">
            <span className={`ads-legend-key ${s.cls}`} />
            {s.label}
          </span>
        ))}
        <button className="ads-link" onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Hide table" : "Show as table"}
        </button>
      </div>
      <div ref={wrapRef} style={{ position: "relative" }}>
        <svg width={width} height={H} role="img" aria-label="Daily ad spend, Meta-attributed sales and Shopify sales" style={{ display: "block" }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="ads-grid" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="ads-axis">
                {money(t)}
              </text>
            </g>
          ))}
          {labelIdx.map((i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor={days.length === 1 ? "middle" : i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} className="ads-axis">
              {shortDate(days[i].date)}
            </text>
          ))}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} className="ads-crosshair" />}
          {series.map((s) => (
            <polyline
              key={s.key}
              className={`ads-line ${s.cls}`}
              points={days.map((d, i) => `${x(i)},${y(d[s.key] ?? 0)}`).join(" ")}
            />
          ))}
          {series.map((s) =>
            (hover != null ? [hover] : days.length === 1 ? [0] : []).map((i) => (
              <circle key={`${s.key}${i}`} cx={x(i)} cy={y(days[i][s.key] ?? 0)} r={4.5} className={`ads-dot ${s.cls}`} />
            ))
          )}
          <rect
            x={pad.l}
            y={pad.t}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hd && hover != null && (
          <div
            className="ads-tooltip"
            style={{
              left: Math.min(Math.max(x(hover) + 12, 0), width - 200),
              top: pad.t,
            }}
          >
            <div className="ads-tooltip-date">{shortDate(hd.date)}</div>
            {series.map((s) => (
              <div key={s.key} className="ads-tooltip-row">
                <span className={`ads-tooltip-key ${s.cls}`} />
                <strong>{money(hd[s.key] ?? 0)}</strong>
                <span>{s.label}</span>
              </div>
            ))}
            <div className="ads-tooltip-row">
              <span className="ads-tooltip-key" />
              <strong>{int(hd.purchases)}</strong>
              <span>Meta purchases · ROAS {ratio(div(hd.revenue, hd.spend))}</span>
            </div>
          </div>
        )}
      </div>
      {showTable && (
        <div className="ads-table-wrap">
          <table className="ads-table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Spend</th>
                <th className="num">Meta sales</th>
                <th className="num">ROAS</th>
                <th className="num">Purchases</th>
                {series.length === 3 && <th className="num">Shopify sales</th>}
                {series.length === 3 && <th className="num">MER</th>}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{shortDate(d.date)}</td>
                  <td className="num">{money(d.spend)}</td>
                  <td className="num">{money(d.revenue)}</td>
                  <td className="num">{ratio(div(d.revenue, d.spend))}</td>
                  <td className="num">{int(d.purchases)}</td>
                  {series.length === 3 && <td className="num">{money(d.shopifyRevenue ?? 0)}</td>}
                  {series.length === 3 && <td className="num">{ratio(div(d.shopifyRevenue ?? 0, d.spend))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Campaign table ───────────────────────────────────────────────────────────

type SortKey = "name" | "spend" | "revenue" | "roas" | "purchases" | "cpa" | "ctr" | "cpm" | "frequency";

const COLS: { key: SortKey; label: string; value: (m: Metrics & { name: string }) => number | string; format: (m: Metrics) => string }[] = [
  { key: "spend", label: "Spend", value: (m) => m.spend, format: (m) => money(m.spend) },
  { key: "revenue", label: "Meta sales", value: (m) => m.revenue, format: (m) => money(m.revenue) },
  { key: "roas", label: "ROAS", value: roas, format: (m) => (m.spend ? ratio(roas(m)) : "—") },
  { key: "purchases", label: "Purch.", value: (m) => m.purchases, format: (m) => int(m.purchases) },
  { key: "cpa", label: "CPA", value: cpa, format: (m) => (m.purchases ? money(cpa(m), 2) : "—") },
  { key: "ctr", label: "CTR", value: ctr, format: (m) => pct(ctr(m)) },
  { key: "cpm", label: "CPM", value: cpm, format: (m) => money(cpm(m), 2) },
  { key: "frequency", label: "Freq.", value: (m) => m.frequency, format: (m) => m.frequency.toFixed(2) },
];

function StatusPill({ status }: { status: string | null }) {
  const s = statusLabel(status);
  return <span className={`ads-pill ${s.tone}`}>{s.text}</span>;
}

function CampaignTable({ campaigns }: { campaigns: Campaign[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "spend", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const val = (c: Campaign) => (sort.key === "name" ? c.name : COLS.find((k) => k.key === sort.key)!.value(c));
    return [...campaigns].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
      return sort.desc ? -cmp : cmp;
    });
  }, [campaigns, sort]);

  if (!campaigns.length) return <div className="ads-card ads-empty">No campaign spent anything in this range.</div>;

  const header = (key: SortKey, label: string, num = true) => (
    <th className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className="ads-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <div className="ads-card ads-table-wrap">
      <table className="ads-table">
        <thead>
          <tr>
            {header("name", "Campaign", false)}
            <th>Status</th>
            <th className="num">Budget</th>
            {COLS.map((c) => header(c.key, c.label))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <Fragment key={c.id}>
              <tr className="ads-row-click" onClick={() => setOpen(open === c.id ? null : c.id)}>
                <td className="ads-name">
                  <button className="ads-expand" aria-expanded={open === c.id} aria-label={`Show ad sets for ${c.name}`}>
                    {open === c.id ? "▾" : "▸"}
                  </button>
                  {c.name}
                </td>
                <td>
                  <StatusPill status={c.status} />
                </td>
                <td className="num">{budgetLabel(c.budget)}</td>
                {COLS.map((col) => (
                  <td key={col.key} className={`num${col.key === "frequency" && c.frequency >= FATIGUE_FREQ ? " ads-warn-text" : ""}`}>
                    {col.format(c)}
                  </td>
                ))}
              </tr>
              {open === c.id &&
                [...c.adsets]
                  .sort((a, b) => b.spend - a.spend)
                  .map((a) => (
                    <tr key={a.id} className="ads-subrow">
                      <td className="ads-name">{a.name}</td>
                      <td>
                        <StatusPill status={a.status} />
                      </td>
                      <td className="num">{budgetLabel(a.budget)}</td>
                      {COLS.map((col) => (
                        <td key={col.key} className={`num${col.key === "frequency" && a.frequency >= FATIGUE_FREQ ? " ads-warn-text" : ""}`}>
                          {col.format(a)}
                        </td>
                      ))}
                    </tr>
                  ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Best / worst / fatigued ads ──────────────────────────────────────────────

function AdBoards({ ads, totalSpend }: { ads: Ad[]; totalSpend: number }) {
  // Only judge ads that spent enough to mean something.
  const minSpend = Math.max(20, totalSpend * 0.02);
  const eligible = ads.filter((a) => a.spend >= minSpend);
  const byRoas = [...eligible].sort((a, b) => roas(b) - roas(a));
  const best = byRoas.slice(0, 5);
  const worst = byRoas
    .filter((a) => !best.includes(a))
    .reverse()
    .slice(0, 5);
  const fatigued = eligible.filter((a) => a.frequency >= FATIGUE_FREQ).sort((a, b) => b.frequency - a.frequency);

  if (!eligible.length) {
    return <div className="ads-card ads-empty">No ad has spent {money(minSpend)} or more in this range yet — try a longer range.</div>;
  }

  return (
    <div className="ads-boards">
      <AdList title="Best performers" tone="good" ads={best} />
      <AdList title="Worst performers" tone="bad" ads={worst} empty="Every ad that spent enough is in the best list." />
      {fatigued.length > 0 && (
        <AdList
          title={`Wearing out — seen ${FATIGUE_FREQ}+ times per person`}
          tone="warn"
          ads={fatigued.slice(0, 6)}
          wide
        />
      )}
    </div>
  );
}

function AdList({ title, tone, ads, empty, wide }: { title: string; tone: "good" | "bad" | "warn"; ads: Ad[]; empty?: string; wide?: boolean }) {
  return (
    <div className={`ads-card ads-board${wide ? " wide" : ""}`}>
      <h3 className={`ads-board-title ${tone}`}>{title}</h3>
      {!ads.length && <div className="ads-empty">{empty}</div>}
      <div className={wide ? "ads-board-grid" : undefined}>
        {ads.map((a) => (
          <div key={a.id} className="ads-ad">
            {a.thumb ? <img src={a.thumb} alt="" className="ads-thumb" loading="lazy" /> : <div className="ads-thumb" />}
            <div className="ads-ad-body">
              <div className="ads-ad-name" title={a.name}>
                {a.name}
              </div>
              <div className="ads-ad-where" title={`${a.campaign} › ${a.adset}`}>
                {a.campaign} › {a.adset}
              </div>
              <div className="ads-ad-stats">
                <span>
                  <strong>{ratio(roas(a))}</strong> ROAS
                </span>
                <span>
                  <strong>{money(a.spend)}</strong> spend
                </span>
                <span>
                  <strong>{a.purchases ? money(cpa(a), 2) : "—"}</strong> CPA
                </span>
                <span className={a.frequency >= FATIGUE_FREQ ? "ads-warn-text" : undefined}>
                  <strong>{a.frequency.toFixed(1)}</strong> freq.
                </span>
              </div>
            </div>
            {a.status && a.status !== "ACTIVE" && <StatusPill status={a.status} />}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    padding: "1.5rem",
    boxSizing: "border-box",
    maxWidth: "1100px",
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
  primaryBtn: {
    display: "inline-block",
    padding: "0.55rem 1.2rem",
    background: "var(--accent)",
    color: "#fff",
    borderRadius: "8px",
    fontSize: "0.9rem",
    fontWeight: 600,
    textDecoration: "none",
  },
  notice: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    padding: "2rem",
    maxWidth: "520px",
    margin: "3rem auto",
  },
  noticeTitle: { margin: "0 0 0.5rem", fontSize: "1.15rem" },
  noticeText: { margin: "0 0 1.25rem", color: "var(--text-muted)", lineHeight: 1.5, fontSize: "0.9rem" },
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
  compareNote: { margin: "0.5rem 0 0", fontSize: "0.75rem", color: "var(--text-faint)" },
  footnote: { marginTop: "2rem", fontSize: "0.75rem", color: "var(--text-faint)", lineHeight: 1.5 },
};
