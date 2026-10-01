import { Fragment, useEffect, useMemo, useRef, useState } from "react";

// Meta Ads: the numbers that matter from the ad account for a date range —
// what Meta claims (attributed ROAS), what Shopify's own last-click attribution
// credits to Meta ads, and what Shopify actually took (MER); headline KPIs vs
// the previous equal-length period, a daily trend, campaigns with their ad
// sets, and the best / worst / most-fatigued ads.
// Data: GET /api/meta-ads (handlers/meta-ads.ts), cached 10 min server-side.

interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  uniqueClicks: number;
  videoPlays: number; // 3-second plays
  thruplays: number;
  landingPageViews: number;
  contentViews: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
  revenue: number;
}

interface Totals extends Metrics {
  shopifyRevenue: number;
  shopifyOrders: number;
  shopifyNewOrders: number; // customer's first order
  shopifyNewRevenue: number;
  shopifyMetaRevenue: number; // Shopify last-click: tagged paid Meta sessions
  shopifyMetaOrders: number;
  shopifyMetaNewOrders: number;
  shopifyMetaNewRevenue: number;
}

/** Shopify last-click sales matched to a Meta row; null when Shopify is unavailable. */
interface ShopMatch {
  shopRevenue: number | null;
  shopOrders: number | null;
  shopNewOrders: number | null;
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

interface Campaign extends Metrics, ShopMatch {
  id: string;
  name: string;
  objective?: string;
  status: string;
  budget: Budget | null;
  adsets: AdSet[];
  utmCampaign: string;
}

interface Ad extends Metrics, ShopMatch {
  id: string;
  name: string;
  campaign: string;
  adset: string;
  status: string | null;
  thumb: string | null;
  utm: { campaign: string; content: string };
  rankings: { quality: string | null; engagement: string | null; conversion: string | null };
  // Fixed trailing week (report.fatigue) — independent of the picked range.
  recent: { spend: number; impressions: number; frequency: number; ctr: number; prevCtr: number; ctrDrop: number };
  fatigued: boolean;
}

interface BreakdownRow extends Metrics {
  name: string;
}

interface DayRow {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
  shopifyRevenue: number | null;
  shopifyMetaRevenue: number | null;
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
  breakdowns: { country: BreakdownRow[]; placement: BreakdownRow[]; ageGender: BreakdownRow[] };
  fatigue: { since: string; until: string; freq: number; ctrDrop: number };
  shopifyUnmatched: { revenue: number; orders: number } | null;
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
const cpc = (m: Metrics) => div(m.spend, m.clicks);
const aov = (m: Metrics) => div(m.revenue, m.purchases);
const hookRate = (m: Metrics) => div(m.videoPlays, m.impressions);
const spanDays = (r: { since: string; until: string }) => Math.round((Date.parse(r.until) - Date.parse(r.since)) / DAY_MS) + 1;

// ── "Is this good?" colouring ────────────────────────────────────────────────
// Every table colours ROAS and CPA against the account average for the same
// range, so outliers jump out without reading the numbers. Rows that spent
// too little to judge stay neutral.

interface Avg {
  roas: number;
  cpa: number;
  minSpend: number;
}
const avgOf = (t: Metrics): Avg => ({ roas: roas(t), cpa: cpa(t), minSpend: Math.max(20, t.spend * 0.02) });
function roasTone(m: Metrics, avg: Avg): string {
  if (m.spend < avg.minSpend || !avg.roas) return "";
  const r = roas(m);
  return r >= avg.roas * 1.2 ? " ads-good-text" : r <= avg.roas * 0.6 ? " ads-bad-text" : "";
}
function cpaTone(m: Metrics, avg: Avg): string {
  if (m.spend < avg.minSpend || !avg.cpa) return "";
  if (!m.purchases) return " ads-bad-text";
  const c = cpa(m);
  return c <= avg.cpa * 0.8 ? " ads-good-text" : c >= avg.cpa * 1.5 ? " ads-bad-text" : "";
}

/** Meta's relative rankings: only "below average" is worth a word. */
function rankingLabel(v: string | null): string | null {
  if (!v || !v.startsWith("BELOW_AVERAGE")) return null;
  const pctile = v.replace("BELOW_AVERAGE_", "");
  return pctile === "BELOW_AVERAGE" ? "below avg" : `bottom ${pctile}%`;
}

// ── CSV export ───────────────────────────────────────────────────────────────

function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const str = v == null ? "" : String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function metricCols(m: Metrics) {
  return {
    spend: m.spend.toFixed(2),
    impressions: m.impressions,
    reach: m.reach,
    frequency: m.frequency.toFixed(2),
    link_clicks: m.clicks,
    link_ctr: (ctr(m) * 100).toFixed(3),
    cpc: cpc(m).toFixed(2),
    cpm: cpm(m).toFixed(2),
    landing_page_views: m.landingPageViews,
    product_views: m.contentViews,
    add_to_carts: m.addToCarts,
    checkouts: m.checkouts,
    purchases: m.purchases,
    meta_sales: m.revenue.toFixed(2),
    meta_roas: roas(m).toFixed(2),
    cost_per_purchase: cpa(m).toFixed(2),
  };
}

function exportReport(report: Report, what: "campaigns" | "adsets" | "ads" | "daily" | "breakdowns") {
  const tag = `${report.range.since}_${report.range.until}`;
  const shop = (r: ShopMatch) => ({
    shopify_lastclick_sales: r.shopRevenue == null ? "" : r.shopRevenue.toFixed(2),
    shopify_lastclick_orders: r.shopOrders ?? "",
    shopify_lastclick_new_customers: r.shopNewOrders ?? "",
  });
  if (what === "campaigns") {
    downloadCsv(`meta-campaigns_${tag}.csv`, report.campaigns.map((c) => ({ campaign: c.name, status: c.status, objective: c.objective ?? "", utm_campaign: c.utmCampaign, ...metricCols(c), ...shop(c) })));
  } else if (what === "adsets") {
    downloadCsv(`meta-adsets_${tag}.csv`, report.campaigns.flatMap((c) => c.adsets.map((a) => ({ campaign: c.name, adset: a.name, status: a.status, ...metricCols(a) }))));
  } else if (what === "ads") {
    downloadCsv(`meta-ads_${tag}.csv`, report.ads.map((a) => ({
      ad: a.name, campaign: a.campaign, adset: a.adset, status: a.status ?? "", utm_campaign: a.utm.campaign, utm_content: a.utm.content,
      ...metricCols(a), ...shop(a),
      quality_ranking: a.rankings.quality ?? "", engagement_ranking: a.rankings.engagement ?? "", conversion_ranking: a.rankings.conversion ?? "",
      frequency_7d: a.recent.frequency.toFixed(2), ctr_7d: (a.recent.ctr * 100).toFixed(3), ctr_change_7d: (-a.recent.ctrDrop * 100).toFixed(1), fatigued: a.fatigued ? "yes" : "",
    })));
  } else if (what === "daily") {
    downloadCsv(`meta-daily_${tag}.csv`, report.daily.map((d) => ({
      date: d.date, spend: d.spend.toFixed(2), meta_sales: d.revenue.toFixed(2), meta_roas: div(d.revenue, d.spend).toFixed(2), meta_purchases: d.purchases,
      shopify_lastclick_sales: d.shopifyMetaRevenue?.toFixed(2) ?? "", shopify_sales: d.shopifyRevenue?.toFixed(2) ?? "", mer: d.shopifyRevenue == null ? "" : div(d.shopifyRevenue, d.spend).toFixed(2),
    })));
  } else {
    const rows = (kind: string, list: BreakdownRow[]) => list.map((b) => ({ breakdown: kind, segment: b.name, ...metricCols(b) }));
    downloadCsv(`meta-breakdowns_${tag}.csv`, [...rows("country", report.breakdowns.country), ...rows("placement", report.breakdowns.placement), ...rows("age_gender", report.breakdowns.ageGender)]);
  }
}

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

type TabId = "overview" | "funnel" | "campaigns" | "ads" | "settings";
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "funnel", label: "Funnel" },
  { id: "campaigns", label: "Campaigns" },
  { id: "ads", label: "Ads" },
  { id: "settings", label: "Settings" },
];
// Tab lives in the hash (#/ads/funnel) so links and back/forward work.
const tabFromHash = (): TabId => {
  const t = window.location.hash.split("/")[2] as TabId | undefined;
  return t && TABS.some((x) => x.id === t) ? t : "overview";
};

export function MetaAds() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const goTab = (t: TabId) => {
    window.location.hash = t === "overview" ? "#/ads" : `#/ads/${t}`;
    setTab(t);
  };
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
          {report && (
            <span style={styles.meta}>Updated {new Date(report.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          )}
          {report && (
            <details className="ads-menu">
              <summary style={styles.secondaryBtn}>Export CSV</summary>
              <div className="ads-menu-list">
                {(
                  [
                    ["campaigns", "Campaigns"],
                    ["adsets", "Ad sets"],
                    ["ads", "Ads"],
                    ["daily", "Daily"],
                    ["breakdowns", "Breakdowns"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className="ads-menu-item" onClick={(e) => { exportReport(report, k); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
                    {label}
                  </button>
                ))}
              </div>
            </details>
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
          <Verdict report={report} goTab={goTab} />
          <nav className="ads-tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button key={t.id} className={`ads-tab${tab === t.id ? " active" : ""}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => goTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <>
              <Hero report={report} />
              <KpiStrip cur={report.totals.cur} prev={report.totals.prev} prevRange={report.prev} />
              {!report.shopifyError && (
                <Section title="New vs returning customers" sub="What it costs to win a first-time customer, and how much of the period's business was new">
                  <Customers cur={report.totals.cur} prev={report.totals.prev} />
                </Section>
              )}
              <Section title="Daily trend" sub="Ad spend against the sales it's meant to drive">
                <TrendChart days={report.daily} />
              </Section>
            </>
          )}

          {tab === "funnel" && (
            <Section title="Funnel" sub="Where people drop off between seeing an ad and buying · cost per step · vs previous period">
              <Funnel report={report} />
            </Section>
          )}

          {tab === "campaigns" && (
            <>
              <Section title="Campaigns" sub="Click a campaign for its ad sets · click a column to sort · green / orange = well above or below the account's ROAS and CPA">
                <CampaignTable campaigns={report.campaigns} days={spanDays(report.range)} avg={avgOf(report.totals.cur)} />
              </Section>
              <Section title="Where the spend works" sub="Same numbers cut by country, placement and audience · sorted by spend">
                <Breakdowns data={report.breakdowns} avg={avgOf(report.totals.cur)} />
              </Section>
            </>
          )}

          {tab === "ads" && (
            <Section title="Ads" sub="Ranked by Meta-attributed ROAS · ads with too little spend to judge are left out">
              <AdBoards ads={report.ads} totalSpend={report.totals.cur.spend} fatigue={report.fatigue} avg={avgOf(report.totals.cur)} />
            </Section>
          )}

          {tab === "settings" && (
            <>
              {report.accounts.length > 1 && (
                <Section title="Ad account" sub="Which Meta ad account this page reports on">
                  <div className="ads-card">
                    <select className="ads-date" value={report.account.id} onChange={(e) => switchAccount(e.target.value)} aria-label="Ad account">
                      {report.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </Section>
              )}
              <Section title="Weekly digest" sub="Every Monday 9am AEST: last week vs the week before, best / worst / tired ads, funnel leak, top countries">
                <DigestSettings />
              </Section>
              <Section title="How the numbers are made" sub="Read this once">
                <div className="ads-card ads-prose">
                  <p>
                    <strong>Meta says</strong> uses the ad account's default attribution (usually 7-day click, 1-day view). It can
                    count a sale that Shopify also credits to Google or email, so it over-states.
                  </p>
                  <p>
                    <strong>Shopify last-click</strong> counts only orders whose final visit carried paid Meta UTM tags, matched to
                    campaigns and ads by the URL parameters on each ad. Organic Instagram and Facebook visits are left out. It
                    under-states, because ads that influenced a sale without getting the final click don't count.
                  </p>
                  <p>
                    <strong>MER</strong> is every Shopify sale (order totals incl. shipping and tax, net of refunds, by AEST day) divided
                    by Meta spend. The truth sits between last-click and MER.
                  </p>
                  <p>
                    <strong>Wearing out</strong> is judged on a fixed trailing week, whatever date range is picked: seen 3+ times per
                    person, or link CTR down 30%+ on the week before.
                  </p>
                  <p>
                    Meta restates the last ~3 days as late conversions arrive, so recent days firm up over time. Reports cache for 10
                    minutes — Refresh forces a rebuild.
                  </p>
                </div>
              </Section>
            </>
          )}

          <p style={styles.footnote}>
            {report.shopifyUnmatched && report.shopifyUnmatched.orders > 0 &&
              `${int(report.shopifyUnmatched.orders)} tagged orders (${money(report.shopifyUnmatched.revenue)}) carry a UTM campaign that matches no campaign spending in this range. `}
            {report.shopifyError && `Shopify sales unavailable: ${report.shopifyError}. `}
            Meta figures are attributed; Shopify last-click and MER are what the store actually took — see Settings for how each is made.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Verdict: the three lines to read before anything else ────────────────────

function Chg({ cur, prev, better }: { cur: number; prev: number; better: "up" | "down" }) {
  if (!prev) return null;
  const ch = (cur - prev) / prev;
  if (Math.abs(ch) < 0.005) return <span className="ads-chg">flat</span>;
  const good = (ch > 0) === (better === "up");
  return <span className={`ads-chg ${good ? "good" : "bad"}`}>{ch > 0 ? "▲" : "▼"}{Math.abs(ch * 100).toFixed(0)}%</span>;
}

function Verdict({ report, goTab }: { report: Report; goTab: (t: TabId) => void }) {
  const { cur, prev } = report.totals;
  const hasShop = !report.shopifyError;
  const mer = div(cur.shopifyRevenue, cur.spend);
  const cac = div(cur.spend, cur.shopifyNewOrders);
  const leak = funnelLeak(cur);
  const tired = report.ads.filter((a) => a.fatigued).length;
  const claim = div(cur.revenue, cur.shopifyRevenue);
  const credit = div(cur.shopifyMetaRevenue, cur.shopifyRevenue);
  return (
    <div className="ads-verdict">
      <div className="ads-verdict-line">
        Spent <strong>{money(cur.spend)}</strong> <Chg cur={cur.spend} prev={prev.spend} better="up" />
        {hasShop ? (
          <>
            {" "}· MER <strong>{ratio(mer)}</strong> <Chg cur={mer} prev={div(prev.shopifyRevenue, prev.spend)} better="up" />
            {" "}· new customer costs <strong>{money(cac, 2)}</strong> <Chg cur={cac} prev={div(prev.spend, prev.shopifyNewOrders)} better="down" />
          </>
        ) : (
          <>
            {" "}· Meta ROAS <strong>{ratio(roas(cur))}</strong> <Chg cur={roas(cur)} prev={roas(prev)} better="up" />
            {" "}· cost per purchase <strong>{money(cpa(cur), 2)}</strong> <Chg cur={cpa(cur)} prev={cpa(prev)} better="down" />
          </>
        )}
      </div>
      {hasShop && cur.shopifyRevenue > 0 && (
        <div className="ads-verdict-line">
          Meta claims <strong>{Math.round(claim * 100)}%</strong> of Shopify sales; Shopify's own last-click gives it{" "}
          <strong>{Math.round(credit * 100)}%</strong>.
        </div>
      )}
      <div className="ads-verdict-line">
        {leak ? (
          <>
            Biggest leak: <button className="ads-link-inline" onClick={() => goTab("funnel")}>{leak.from} → {leak.to}</button>, only <strong>{pct(leak.rate)}</strong> carry on.
          </>
        ) : (
          "No funnel data yet."
        )}{" "}
        {tired > 0 ? (
          <>
            <button className="ads-link-inline" onClick={() => goTab("ads")}>{tired} ad{tired === 1 ? "" : "s"} wearing out</button>.
          </>
        ) : (
          "No ads wearing out."
        )}
      </div>
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
  const lastClick = div(cur.shopifyMetaRevenue, cur.spend);
  const prevLastClick = div(prev.shopifyMetaRevenue, prev.spend);
  const hasShop = !report.shopifyError;
  const shares = [
    { label: "Meta claims", value: cur.revenue, cls: "s2", aria: "Share of Shopify sales Meta attributes to ads" },
    {
      label: "Shopify last-click credits Meta with",
      value: cur.shopifyMetaRevenue,
      cls: "s1",
      aria: "Share of Shopify sales whose last session came from a paid Meta ad",
    },
  ];

  return (
    <div className="ads-hero">
      <div className="ads-hero-col">
        <div className="ads-eyebrow" title={`${money(cur.revenue)} attributed by Meta from ${money(cur.spend)} spend`}>Meta says</div>
        <div className="ads-big">{ratio(metaRoas)}</div>
        <Delta cur={metaRoas} prev={roas(prev)} better="up" format={ratio} />
      </div>
      <div className="ads-hero-vs" aria-hidden="true">
        vs
      </div>
      <div className="ads-hero-col">
        <div className="ads-eyebrow" title={hasShop ? `${money(cur.shopifyMetaRevenue)} across ${int(cur.shopifyMetaOrders)} orders whose last visit came from a Meta ad` : "Shopify sales unavailable"}>
          Shopify last-click
        </div>
        <div className="ads-big">{hasShop ? ratio(lastClick) : "—"}</div>
        {hasShop && <Delta cur={lastClick} prev={prevLastClick} better="up" format={ratio} />}
      </div>
      <div className="ads-hero-vs" aria-hidden="true">
        vs
      </div>
      <div className="ads-hero-col">
        <div className="ads-eyebrow" title={hasShop ? `${money(cur.shopifyRevenue)} total Shopify sales across ${int(cur.shopifyOrders)} orders` : "Shopify sales unavailable"}>
          All sales (MER)
        </div>
        <div className="ads-big">{hasShop ? ratio(mer) : "—"}</div>
        {hasShop && <Delta cur={mer} prev={prevMer} better="up" format={ratio} />}
      </div>
      {hasShop && cur.shopifyRevenue > 0 && (
        <div className="ads-share">
          {shares.map((s) => {
            const share = div(s.value, cur.shopifyRevenue);
            return (
              <div key={s.label}>
                <div className="ads-share-label">
                  <span>
                    {s.label} {Math.round(share * 100)}% of Shopify sales
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {money(s.value)} of {money(cur.shopifyRevenue)}
                  </span>
                </div>
                <div
                  className="ads-share-track"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(Math.min(share, 1) * 100)}
                  aria-label={s.aria}
                >
                  <div className={`ads-share-fill ${s.cls}`} style={{ width: `${Math.min(share, 1) * 100}%` }} />
                </div>
              </div>
            );
          })}
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
    { label: "AOV (Meta)", value: aov, format: (n) => money(n, 2), better: "up" },
    { label: "Link CTR", value: ctr, format: pct, better: "up" },
    { label: "CPC", value: cpc, format: (n) => money(n, 2), better: "down" },
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

// ── New vs returning ─────────────────────────────────────────────────────────

function Customers({ cur, prev }: { cur: Totals; prev: Totals }) {
  const retOrders = (m: Totals) => m.shopifyOrders - m.shopifyNewOrders;
  const retRevenue = (m: Totals) => m.shopifyRevenue - m.shopifyNewRevenue;
  const blendedCac = (m: Totals) => div(m.spend, m.shopifyNewOrders);
  const metaCac = (m: Totals) => div(m.spend, m.shopifyMetaNewOrders);
  const newShare = (m: Totals) => div(m.shopifyNewOrders, m.shopifyOrders);
  const newMer = (m: Totals) => div(m.shopifyNewRevenue, m.spend);
  const aovNew = (m: Totals) => div(m.shopifyNewRevenue, m.shopifyNewOrders);
  const aovRet = (m: Totals) => div(retRevenue(m), retOrders(m));
  const tiles: { label: string; hint: string; value: (m: Totals) => number; format: (n: number) => string; better: "up" | "down" | "neutral" }[] = [
    {
      label: "Blended CAC",
      hint: "Ad spend ÷ every first-time customer Shopify saw, whatever channel they came from. The honest cost of a new customer.",
      value: blendedCac,
      format: (n) => money(n, 2),
      better: "down",
    },
    {
      label: "Meta last-click CAC",
      hint: "Ad spend ÷ first-time customers whose last visit came from a Meta ad. Higher than blended because it ignores the new customers ads influenced but didn't get the final click for.",
      value: metaCac,
      format: (n) => money(n, 2),
      better: "down",
    },
    {
      label: "New-customer MER",
      hint: "Revenue from first orders ÷ ad spend. The return on spend counting only the customers you didn't already have.",
      value: newMer,
      format: ratio,
      better: "up",
    },
    {
      label: "New customers",
      hint: "First-time orders in the period (Shopify, all channels).",
      value: (m) => m.shopifyNewOrders,
      format: int,
      better: "up",
    },
    {
      label: "New-order share",
      hint: "First orders as a share of all orders.",
      value: newShare,
      format: (n) => `${Math.round(n * 100)}%`,
      better: "neutral",
    },
    {
      label: "AOV new / returning",
      hint: "Average order value of first orders vs repeat orders.",
      value: aovNew,
      format: (n) => money(n, 2),
      better: "up",
    },
  ];
  const share = newShare(cur);
  return (
    <div className="ads-card">
      <div className="ads-kpis ads-kpis-inset">
        {tiles.map((t) => (
          <div key={t.label} className="ads-kpi" title={t.hint}>
            <div className="ads-kpi-label">{t.label}</div>
            <div className="ads-kpi-value">
              {t.format(t.value(cur))}
              {t.label.startsWith("AOV") && <span className="ads-kpi-aside"> / {money(aovRet(cur), 2)}</span>}
            </div>
            <Delta cur={t.value(cur)} prev={t.value(prev)} better={t.better} format={t.format} />
          </div>
        ))}
      </div>
      {cur.shopifyOrders > 0 && (
        <div className="ads-split" role="img" aria-label={`${int(cur.shopifyNewOrders)} new and ${int(retOrders(cur))} returning orders`}>
          <div className="ads-split-bar">
            <div className="ads-split-new" style={{ width: `${share * 100}%` }} />
          </div>
          <div className="ads-split-legend">
            <span>
              <span className="ads-legend-key s1" /> New {int(cur.shopifyNewOrders)} orders · {money(cur.shopifyNewRevenue)}
            </span>
            <span>
              <span className="ads-legend-key s4" /> Returning {int(retOrders(cur))} orders · {money(retRevenue(cur))}
            </span>
          </div>
        </div>
      )}
      <p style={styles.compareNote}>
        "New" = the customer's first ever order on the store. CAC uses total Meta spend because ads are the only paid
        acquisition channel; if that changes, blended CAC needs the other spend added. Hover a tile for its definition.
      </p>
    </div>
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────────

// Each stage carries what a weak conversion INTO it usually means, so the page
// can say it outright instead of leaving the reader to guess.
const STAGES: { key: keyof Metrics; label: string; hint: string; weak: string }[] = [
  {
    key: "clicks",
    label: "Link clicks",
    hint: "Clicks on the ad's link",
    weak: "Low CTR: the creative isn't stopping the scroll — hook, thumbnail, or the audience is wrong.",
  },
  {
    key: "landingPageViews",
    label: "Landing page views",
    hint: "Clicks where the page actually loaded",
    weak: "Clicks that never load: slow site, or accidental taps (common on Reels and Audience Network placements).",
  },
  {
    key: "contentViews",
    label: "Product views",
    hint: "Pixel ViewContent — reached a product page",
    weak: "People land but never reach a product: the landing page doesn't lead to the product the ad showed.",
  },
  {
    key: "addToCarts",
    label: "Added to cart",
    hint: "Pixel AddToCart",
    weak: "Look but don't add: the ad promised something the page doesn't deliver — price, product, or offer mismatch.",
  },
  {
    key: "checkouts",
    label: "Started checkout",
    hint: "Pixel InitiateCheckout",
    weak: "Cart but no checkout: hesitation — shipping cost revealed, sizing or option doubt, no reason to buy now.",
  },
  {
    key: "purchases",
    label: "Purchases",
    hint: "Meta-attributed purchases",
    weak: "Checkout but no purchase: checkout friction — shipping cost, delivery time, payment options, forced account.",
  },
];

/** Stages the pixel actually reports for this data (clicks + purchases always). */
function funnelStages(cur: Metrics, prev?: Metrics | null) {
  return STAGES.filter((s) => s.key === "clicks" || s.key === "purchases" || cur[s.key] > 0 || (prev?.[s.key] ?? 0) > 0);
}
/** Index of the step losing the most people (lowest step-to-step rate; CTR
 *  is excluded as it's on a different scale), or -1. */
function worstStep(cur: Metrics, stages: typeof STAGES): number {
  let worst = -1;
  const rate = (i: number) => div(cur[stages[i].key], cur[stages[i - 1].key]);
  for (let i = 1; i < stages.length; i++) {
    if (cur[stages[i - 1].key] > 0 && (worst < 0 || rate(i) < rate(worst))) worst = i;
  }
  return worst;
}
function funnelLeak(cur: Metrics): { from: string; to: string; rate: number; weak: string } | null {
  const stages = funnelStages(cur);
  const w = worstStep(cur, stages);
  if (w < 1) return null;
  return { from: stages[w - 1].label, to: stages[w].label, rate: div(cur[stages[w].key], cur[stages[w - 1].key]), weak: stages[w].weak };
}

function Funnel({ report }: { report: Report }) {
  const [pick, setPick] = useState<string>("all");
  const campaign = report.campaigns.find((c) => c.id === pick);
  const cur: Metrics = campaign || report.totals.cur;
  // Previous period only exists at account level.
  const prev: Metrics | null = campaign ? null : report.totals.prev;
  // Drop stages the pixel never reports (zero in both periods) so the funnel
  // doesn't show a fake 0% step; clicks and purchases always stay.
  const stages = funnelStages(cur, prev);
  const top = Math.max(1, cur[stages[0].key]);
  const rate = (m: Metrics, i: number) => (i === 0 ? div(m[stages[i].key], m.impressions) : div(m[stages[i].key], m[stages[i - 1].key]));
  const missing = STAGES.filter((s) => !stages.includes(s));
  // The step losing the most people (lowest step-to-step rate, ignoring CTR
  // which is on a different scale) is the one to fix first.
  const worst = worstStep(cur, stages);

  return (
    <div className="ads-card">
      <div className="ads-funnel-head">
        <select className="ads-date" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Funnel for">
          <option value="all">Whole account</option>
          {report.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
          {int(cur.impressions)} impressions · {int(cur.reach)} people reached
        </span>
      </div>
      <div className="ads-funnel">
        {stages.map((s, i) => {
          const n = cur[s.key];
          const r = rate(cur, i);
          const pr = prev ? rate(prev, i) : null;
          const cost = div(cur.spend, n);
          return (
            <div key={s.key} className={`ads-funnel-row${i === worst ? " worst" : ""}`} title={s.hint}>
              <div className="ads-funnel-label">{s.label}</div>
              <div className="ads-funnel-bar-wrap">
                <div className="ads-funnel-bar" style={{ width: `${Math.max(1.5, (n / top) * 100)}%` }} />
                <span className="ads-funnel-n">{int(n)}</span>
              </div>
              <div className="ads-funnel-rate">
                <strong>{pct(r)}</strong>
                <span className="ads-funnel-of">{i === 0 ? "of impressions" : `of ${stages[i - 1].label.toLowerCase()}`}</span>
                {pr != null && <Delta cur={r} prev={pr} better="up" format={pct} />}
              </div>
              <div className="ads-funnel-cost">{n ? money(cost, 2) : "—"}<span className="ads-funnel-of">each</span></div>
            </div>
          );
        })}
      </div>
      {worst > 0 && (
        <div className="ads-funnel-callout">
          <div className="ads-funnel-callout-title">
            Biggest leak: {stages[worst - 1].label} → {stages[worst].label} — only {pct(rate(cur, worst))} carry on
          </div>
          <div>{stages[worst].weak}</div>
        </div>
      )}
      <details className="ads-funnel-guide">
        <summary>How to read each step</summary>
        <ul>
          <li>The step with the biggest percentage drop is the problem to fix first — it's highlighted above.</li>
          {STAGES.map((s) => (
            <li key={s.key}>
              <strong>{s.label}:</strong> {s.weak}
            </li>
          ))}
        </ul>
      </details>
      {missing.length > 0 && (
        <p style={styles.compareNote}>
          Not reported by the pixel in this range: {missing.map((m) => m.label.toLowerCase()).join(", ")}.
        </p>
      )}
    </div>
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
            {hd.shopifyMetaRevenue != null && (
              <div className="ads-tooltip-row">
                <span className="ads-tooltip-key" />
                <strong>{money(hd.shopifyMetaRevenue)}</strong>
                <span>Shopify last-click from Meta</span>
              </div>
            )}
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
                {series.length === 3 && <th className="num">Shopify last-click</th>}
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
                  {series.length === 3 && <td className="num">{money(d.shopifyMetaRevenue ?? 0)}</td>}
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

type SortKey = "name" | "spend" | "revenue" | "shop" | "roas" | "purchases" | "cpa" | "ctr" | "cpc" | "cpm" | "frequency";
type Row = Metrics & Partial<ShopMatch>;

const COLS: { key: SortKey; label: string; title?: string; value: (m: Row) => number; format: (m: Row) => string }[] = [
  { key: "spend", label: "Spend", value: (m) => m.spend, format: (m) => money(m.spend) },
  { key: "revenue", label: "Meta sales", value: (m) => m.revenue, format: (m) => money(m.revenue) },
  {
    key: "shop",
    label: "Shop sales",
    title: "Shopify last-click sales from sessions tagged with this row's UTM · order count · how many were first-time customers",
    value: (m) => m.shopRevenue ?? -1,
    format: (m) =>
      m.shopRevenue == null
        ? "—"
        : `${money(m.shopRevenue)}${m.shopOrders ? ` · ${int(m.shopOrders)}${m.shopNewOrders ? ` (${int(m.shopNewOrders)} new)` : ""}` : ""}`,
  },
  { key: "roas", label: "ROAS", value: roas, format: (m) => (m.spend ? ratio(roas(m)) : "—") },
  { key: "purchases", label: "Purch.", value: (m) => m.purchases, format: (m) => int(m.purchases) },
  { key: "cpa", label: "CPA", value: cpa, format: (m) => (m.purchases ? money(cpa(m), 2) : "—") },
  { key: "ctr", label: "CTR", value: ctr, format: (m) => pct(ctr(m)) },
  { key: "cpc", label: "CPC", value: cpc, format: (m) => (m.clicks ? money(cpc(m), 2) : "—") },
  { key: "cpm", label: "CPM", value: cpm, format: (m) => money(cpm(m), 2) },
  { key: "frequency", label: "Freq.", value: (m) => m.frequency, format: (m) => m.frequency.toFixed(2) },
];
// Frequency only reads as "fatigue" over a week or less — over a month it's naturally high.
const FREQ_WARN_MAX_DAYS = 7;
const FREQ_WARN = 3;

function StatusPill({ status }: { status: string | null }) {
  const s = statusLabel(status);
  return <span className={`ads-pill ${s.tone}`}>{s.text}</span>;
}

const DEFAULT_COLS: SortKey[] = ["spend", "revenue", "shop", "roas", "purchases", "cpa", "ctr"];
const MORE_KEY = "metaAds.moreCols";

function CampaignTable({ campaigns, days, avg }: { campaigns: Campaign[]; days: number; avg: Avg }) {
  const warnFreq = days <= FREQ_WARN_MAX_DAYS;
  const [more, setMore] = useState(() => {
    try {
      return localStorage.getItem(MORE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleMore = () => {
    setMore((v) => {
      try {
        localStorage.setItem(MORE_KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  };
  const cols = more ? COLS : COLS.filter((c) => DEFAULT_COLS.includes(c.key));
  const cellClass = (col: SortKey, m: Metrics) =>
    col === "roas" ? roasTone(m, avg) : col === "cpa" ? cpaTone(m, avg) : col === "frequency" && warnFreq && m.frequency >= FREQ_WARN ? " ads-warn-text" : "";
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "spend", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const val = (c: Campaign): number | string => (sort.key === "name" ? c.name : COLS.find((k) => k.key === sort.key)!.value(c));
    return [...campaigns].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
      return sort.desc ? -cmp : cmp;
    });
  }, [campaigns, sort]);

  if (!campaigns.length) return <div className="ads-card ads-empty">No campaign spent anything in this range.</div>;

  const header = (key: SortKey, label: string, num = true, title?: string) => (
    <th className={num ? "num" : undefined} title={title} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className="ads-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <div className="ads-card ads-table-wrap">
      <div className="ads-table-tools">
        <button className="ads-link" onClick={toggleMore}>
          {more ? "Fewer columns" : "More columns (budget, CPC, CPM, frequency)"}
        </button>
      </div>
      <table className="ads-table">
        <thead>
          <tr>
            {header("name", "Campaign", false)}
            <th>Status</th>
            {more && <th className="num">Budget</th>}
            {cols.map((c) => header(c.key, c.label, true, c.title))}
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
                {more && <td className="num">{budgetLabel(c.budget)}</td>}
                {cols.map((col) => (
                  <td key={col.key} className={`num${cellClass(col.key, c)}`}>
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
                      {more && <td className="num">{budgetLabel(a.budget)}</td>}
                      {cols.map((col) => (
                        <td key={col.key} className={`num${cellClass(col.key, a)}`}>
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

function AdBoards({ ads, totalSpend, fatigue, avg }: { ads: Ad[]; totalSpend: number; fatigue: Report["fatigue"]; avg: Avg }) {
  // Only judge ads that spent enough to mean something.
  const minSpend = Math.max(20, totalSpend * 0.02);
  const eligible = ads.filter((a) => a.spend >= minSpend);
  const byRoas = [...eligible].sort((a, b) => roas(b) - roas(a));
  const best = byRoas.slice(0, 5);
  const worst = byRoas
    .filter((a) => !best.includes(a))
    .reverse()
    .slice(0, 5);
  // Fatigue is judged by the backend on a fixed trailing week, not this range.
  const fatigued = ads.filter((a) => a.fatigued).sort((a, b) => b.recent.frequency - a.recent.frequency);

  if (!eligible.length) {
    return <div className="ads-card ads-empty">No ad has spent {money(minSpend)} or more in this range yet — try a longer range.</div>;
  }

  return (
    <div className="ads-boards">
      <AdList title="Best performers" tone="good" ads={best} avg={avg} />
      <AdList title="Worst performers" tone="bad" ads={worst} empty="Every ad that spent enough is in the best list." avg={avg} />
      <AdList
        title={`Wearing out — ${shortDate(fatigue.since)} to ${shortDate(fatigue.until)}: seen ${fatigue.freq}+ times per person, or link CTR down ${Math.round(fatigue.ctrDrop * 100)}%+ on the week before`}
        tone="warn"
        ads={fatigued.slice(0, 6)}
        empty="No active ad is wearing out this week."
        recent
        wide
        avg={avg}
      />
    </div>
  );
}

function AdList({ title, tone, ads, empty, wide, recent, avg }: { title: string; tone: "good" | "bad" | "warn"; ads: Ad[]; empty?: string; wide?: boolean; recent?: boolean; avg: Avg }) {
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
                <span className={roasTone(a, avg).trim() || undefined}>
                  <strong>{ratio(roas(a))}</strong> ROAS
                </span>
                <span>
                  <strong>{money(a.spend)}</strong> spend
                </span>
                <span>
                  <strong>{a.purchases ? money(cpa(a), 2) : "—"}</strong> CPA
                </span>
                <span title={`Shopify last-click orders tagged utm_campaign=${a.utm.campaign} utm_content=${a.utm.content}`}>
                  <strong>{a.shopRevenue == null ? "—" : money(a.shopRevenue)}</strong> Shopify
                </span>
                {recent ? (
                  <>
                    <span className={a.recent.frequency >= 3 ? "ads-warn-text" : undefined}>
                      <strong>{a.recent.frequency.toFixed(1)}</strong> freq. (7d)
                    </span>
                    <span className={a.recent.ctrDrop >= 0.3 ? "ads-warn-text" : undefined}>
                      <strong>{a.recent.ctrDrop > 0 ? "▼" : "▲"} {Math.abs(a.recent.ctrDrop * 100).toFixed(0)}%</strong> CTR vs prior week
                    </span>
                  </>
                ) : (
                  <span>
                    <strong>{a.frequency.toFixed(1)}</strong> freq.
                  </span>
                )}
                {a.videoPlays > 0 && (
                  <span title="3-second plays ÷ impressions — how often the video stops the scroll">
                    <strong>{pct(hookRate(a))}</strong> hook
                  </span>
                )}
              </div>
              <AdFlags ad={a} />
            </div>
            {a.status && a.status !== "ACTIVE" && <StatusPill status={a.status} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Meta's below-average rankings, shown only when they're bad. */
function AdFlags({ ad }: { ad: Ad }) {
  const flags = [
    ["Quality", rankingLabel(ad.rankings.quality)],
    ["Engagement", rankingLabel(ad.rankings.engagement)],
    ["Conversion", rankingLabel(ad.rankings.conversion)],
  ].filter((f): f is [string, string] => !!f[1]);
  if (!flags.length) return null;
  return (
    <div className="ads-flags">
      {flags.map(([k, v]) => (
        <span key={k} className="ads-pill warn" title={`Meta ranks this ad's ${k.toLowerCase()} ${v} against ads competing for the same audience`}>
          {k} {v}
        </span>
      ))}
    </div>
  );
}

// ── Breakdowns ───────────────────────────────────────────────────────────────

const countryNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
function countryName(code: string): string {
  if (!code || code === "unknown") return "Unknown";
  try {
    return countryNames?.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}
function placementName(raw: string): string {
  const [platform, position] = raw.split("/");
  const plat = { facebook: "Facebook", instagram: "Instagram", messenger: "Messenger", audience_network: "Audience Network", threads: "Threads" }[platform] || platform;
  const pos = (position || "")
    .replace(/^(facebook|instagram|messenger|an)_/, "")
    .replace(/_/g, " ")
    .replace(/\bfeed\b/, "Feed")
    .replace(/\breels\b/, "Reels")
    .replace(/\bstor(y|ies)\b/, "Stories")
    .replace(/\bexplore\b/, "Explore")
    .replace(/\bsearch\b/, "Search")
    .replace(/\bclassic\b/, "Classic");
  return pos ? `${plat} · ${pos.charAt(0).toUpperCase()}${pos.slice(1)}` : plat;
}

function Breakdowns({ data, avg }: { data: Report["breakdowns"]; avg: Avg }) {
  const tables: { title: string; rows: BreakdownRow[]; name: (s: string) => string; max: number }[] = [
    { title: "Country", rows: data.country, name: countryName, max: 8 },
    { title: "Placement", rows: data.placement, name: placementName, max: 8 },
    { title: "Age & gender", rows: data.ageGender, name: (s) => s.replace(/\b(male|female|unknown)\b/, (g) => (g === "male" ? "men" : g === "female" ? "women" : "unknown")), max: 10 },
  ];
  return (
    <div className="ads-breakdowns">
      {tables.map((t) => {
        const top = t.rows.slice(0, t.max);
        const rest = t.rows.slice(t.max);
        const other = rest.length
          ? rest.reduce<BreakdownRow>((acc, r) => ({ ...acc, spend: acc.spend + r.spend, impressions: acc.impressions + r.impressions, clicks: acc.clicks + r.clicks, purchases: acc.purchases + r.purchases, revenue: acc.revenue + r.revenue }), { ...rest[0], name: `Other (${rest.length})`, spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 })
          : null;
        const list = other ? [...top, other] : top;
        const total = t.rows.reduce((a, r) => a + r.spend, 0);
        return (
          <div key={t.title} className="ads-card ads-table-wrap">
            <h3 className="ads-board-title">{t.title}</h3>
            {!list.length ? (
              <div className="ads-empty">No data.</div>
            ) : (
              <table className="ads-table ads-table-compact">
                <thead>
                  <tr>
                    <th>{t.title}</th>
                    <th className="num">Spend</th>
                    <th className="num">ROAS</th>
                    <th className="num">Purch.</th>
                    <th className="num">CPA</th>
                    <th className="num">CTR</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.name}>
                      <td className="ads-name">
                        {r.name.startsWith("Other") ? r.name : t.name(r.name)}
                        <span className="ads-share-inline" style={{ width: `${div(r.spend, total) * 100}%` }} />
                      </td>
                      <td className="num">{money(r.spend)} <span className="ads-funnel-of">{Math.round(div(r.spend, total) * 100)}%</span></td>
                      <td className={`num${roasTone(r, avg)}`}>{r.spend ? ratio(roas(r)) : "—"}</td>
                      <td className="num">{int(r.purchases)}</td>
                      <td className={`num${cpaTone(r, avg)}`}>{r.purchases ? money(cpa(r), 2) : "—"}</td>
                      <td className="num">{pct(ctr(r))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Weekly digest settings ───────────────────────────────────────────────────

function DigestSettings() {
  const [to, setTo] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "sending" | "saved" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/api/meta-ads/digest")
      .then((r) => r.json())
      .then((d) => {
        setTo(d.to || "");
        setEnabled(!!d.enabled);
      })
      .catch(() => {});
  }, []);
  const post = async (body: Record<string, unknown>, busy: "saving" | "sending", done: "saved" | "sent") => {
    setState(busy);
    setMsg("");
    try {
      const res = await fetch("/api/meta-ads/digest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (done === "saved") setEnabled(!!d.enabled);
      setState(done);
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="ads-card ads-digest">
      <input
        type="email"
        className="ads-date"
        placeholder="marketing@…"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        aria-label="Digest recipient"
        style={{ minWidth: 240 }}
      />
      <label className="ads-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send every Monday
      </label>
      <button style={styles.secondaryBtn} onClick={() => post({ to, enabled }, "saving", "saved")} disabled={state === "saving"}>
        {state === "saving" ? "Saving…" : "Save"}
      </button>
      <button style={styles.secondaryBtn} onClick={() => post({ send: true, to }, "sending", "sent")} disabled={state === "sending" || !to}>
        {state === "sending" ? "Sending…" : "Send now"}
      </button>
      <span style={{ fontSize: "0.8rem", color: state === "error" ? "var(--ads-bad)" : "var(--text-muted)" }}>
        {state === "saved" && "Saved."}
        {state === "sent" && "Sent — check the inbox."}
        {state === "error" && msg}
      </span>
      <p style={{ ...styles.compareNote, flexBasis: "100%", margin: 0 }}>
        Sent from the connected Gmail account. Covers the last 7 complete days (to yesterday) against the 7 before. Use "Send now" to preview.
      </p>
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
