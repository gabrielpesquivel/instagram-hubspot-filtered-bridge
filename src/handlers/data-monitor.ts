import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { adminGraphQL, shopifyConfigured } from "../services/shopify-api";
import { cerr } from "../services/logger";
import { aestDate } from "./gangsheet-orders";

// Data Monitor (#/data): sales per main market (orders, sales, AOV, units,
// discounts, sessions, conversion) and, for every market in the theme's kit vs
// % split test (Essence theme, snippets/bundle-test-head.liquid), the two
// groups side by side.
//
//   Sessions — the theme sends one beacon per storefront session (first page
//   view, or after 30 min idle) to POST /api/st/hit (public): random session
//   + visitor ids, group, storefront country. Stored in D1 (DATA_DB.sessions).
//   GB visitors are always "kit"; preview themes, the theme editor and bots
//   don't send.
//   Orders — Shopify orders in the same AEST window. The group comes from the
//   cart attribute `_bundle_test` (copied onto the order); GB storefront orders
//   carry none and count as kit. Anything else without it (Shop app, Buy it
//   now, drafts) is reported as untracked, not counted in either group.
//
// Market totals count EVERY order in the range (incl. untracked). Conversion
// is per VISITOR (the test randomises visitors) and per session, and only uses
// orders placed after the first recorded session, so both sides of the rate
// cover the same time.

// Essence 3.0 (split test) went live between #31653 (10:13 UTC, untagged) and
// #31654 (10:30 UTC, the first `_bundle_test` order) — no orders in between.
// The dashboard's "Since test start" sends this as `start`.
export const SPLIT_TEST_START = "2026-10-06T10:20:00Z";

const CACHE_PREFIX = "data_monitor:";
const CACHE_TTL = 300; // seconds
const DAY_MS = 86400_000;

export const MARKETS = ["AU", "US", "CA", "NZ", "EU", "INTL", "GB"] as const;
export type Market = (typeof MARKETS)[number];
const EU = new Set(["AT", "BE", "DE", "ES", "FR", "IE", "IT", "NL", "PT"]);
export function marketOf(cc: string | null | undefined): Market {
  const c = (cc || "").toUpperCase();
  if (c === "AU" || c === "US" || c === "CA" || c === "NZ" || c === "GB") return c;
  return EU.has(c) ? "EU" : "INTL";
}
const MARKET_SQL = `CASE
  WHEN country IN ('AU','US','CA','NZ','GB') THEN country
  WHEN country IN ('AT','BE','DE','ES','FR','IE','IT','NL','PT') THEN 'EU'
  ELSE 'INTL' END`;

// ── Beacon ───────────────────────────────────────────────────────────────────

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|bingpreview|python|curl|wget/i;
const ID_RE = /^[a-z0-9]{8,40}$/;
const ALLOWED_ORIGIN = /^https:\/\/(www\.)?bootink\.com$/;

/** POST /api/st/hit — public. Sent with navigator.sendBeacon (text/plain, no preflight). */
export async function handleSessionHit(request: Request, env: Env): Promise<Response> {
  const done = new Response(null, { status: 204 });
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGIN.test(origin)) return new Response(null, { status: 403 });
  if (BOT_UA.test(request.headers.get("User-Agent") || "")) return done;

  let b: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 2000) return new Response(null, { status: 413 });
    b = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const sid = String(b.sid || "");
  const vid = String(b.vid || "");
  const grp = String(b.grp || "");
  const country = String(b.cc || "").toUpperCase();
  if (!ID_RE.test(sid) || !ID_RE.test(vid) || (grp !== "kit" && grp !== "tier") || !/^[A-Z]{2}$/.test(country)) {
    return new Response(null, { status: 400 });
  }
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
  const now = new Date();
  try {
    await env.DATA_DB.prepare(
      `INSERT OR IGNORE INTO sessions (sid, vid, ts, day, grp, country, currency, landing, referrer, mobile)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
      .bind(sid, vid, now.getTime(), aestDate(now), grp, country, str(b.cur, 3), str(b.path, 200), str(b.ref, 100), b.m ? 1 : 0)
      .run();
  } catch (e) {
    await cerr(env, "data-monitor: session insert failed", e);
  }
  return done;
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface Cell {
  sessions: number;
  visitors: number;
  orders: number; // all orders in the window (market totals) / all tagged orders (groups)
  convOrders: number; // orders placed since tracking started — the conversion numerator
  revenue: number; // AUD, products after discounts (subtotal), net of refunds
  sales: number; // AUD, order totals incl. shipping/tax, net of refunds
  units: number;
  discounts: number; // AUD
}
const emptyCell = (): Cell => ({ sessions: 0, visitors: 0, orders: 0, convOrders: 0, revenue: 0, sales: 0, units: 0, discounts: 0 });
type MarketData = { total: Cell; kit: Cell; tier: Cell; untracked: number };
const emptyMarket = (): MarketData => ({ total: emptyCell(), kit: emptyCell(), tier: emptyCell(), untracked: 0 });

export interface DataMonitorReport {
  range: { since: string; until: string; start: string | null };
  trackingSince: string | null; // first recorded session (ISO)
  markets: Record<Market | "NON_UK" | "ALL", MarketData>;
  daily: { day: string; total: Cell; kit: Cell; tier: Cell }[]; // total = all markets; kit/tier = non-UK
  untracked: { orders: number; revenue: number; bySource: Record<string, number> };
  ordersBeforeTracking: number; // in the market totals, not in any conversion rate
  shopifyError: string | null;
  fetchedAt: string;
}

const ORDERS_QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt test cancelledAt sourceName currentSubtotalLineItemsQuantity
      customAttributes { key value }
      currentTotalDiscountsSet { shopMoney { amount } }
      shippingAddress { countryCodeV2 }
      billingAddress { countryCodeV2 }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
    }
  }
}`;

type OrderNode = {
  createdAt: string;
  test: boolean;
  cancelledAt: string | null;
  sourceName: string | null;
  currentSubtotalLineItemsQuantity: number;
  currentTotalDiscountsSet: { shopMoney: { amount: string } };
  customAttributes: { key: string; value: string | null }[];
  shippingAddress: { countryCodeV2: string | null } | null;
  billingAddress: { countryCodeV2: string | null } | null;
  currentSubtotalPriceSet: { shopMoney: { amount: string } };
  currentTotalPriceSet: { shopMoney: { amount: string } };
};

const ymd = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const startOfAest = (day: string) => Date.parse(`${day}T00:00:00Z`) - 10 * 3600_000;

/** GET /api/data-monitor?since=YYYY-MM-DD&until=YYYY-MM-DD[&start=ISO][&refresh=1]
 *  `start` (optional) drops orders and sessions before that instant — "Since test start". */
export async function handleGetDataMonitor(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const url = new URL(request.url);
  const today = aestDate();
  const until = ymd(url.searchParams.get("until")) || today;
  const since = ymd(url.searchParams.get("since")) || until;
  if (since > until) return jsonResponse({ error: "since is after until" }, 400);
  if ((Date.parse(until) - Date.parse(since)) / DAY_MS > 120) return jsonResponse({ error: "Range too long (max 120 days)" }, 400);
  const startParam = url.searchParams.get("start");
  const start = startParam && !isNaN(Date.parse(startParam)) ? new Date(startParam).toISOString() : null;

  const cacheKey = `${CACHE_PREFIX}${since}:${until}:${start || ""}`;
  if (url.searchParams.get("refresh") !== "1") {
    const hit = await env.PROFILE_CACHE.get(cacheKey, "json");
    if (hit) return jsonResponse(hit);
  }

  try {
    const report = await buildReport(env, since, until, start);
    await env.PROFILE_CACHE.put(cacheKey, JSON.stringify(report), { expirationTtl: CACHE_TTL });
    return jsonResponse(report);
  } catch (e) {
    await cerr(env, "data-monitor: report failed", e);
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

async function buildReport(env: Env, since: string, until: string, start: string | null): Promise<DataMonitorReport> {
  const startMs = start ? Date.parse(start) : 0;
  const markets = Object.fromEntries([...MARKETS, "NON_UK", "ALL"].map((m) => [m, emptyMarket()])) as DataMonitorReport["markets"];
  const daily = new Map<string, DataMonitorReport["daily"][number]>();
  for (let t = Date.parse(since); t <= Date.parse(until); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    daily.set(day, { day, total: emptyCell(), kit: emptyCell(), tier: emptyCell() });
  }
  const grpOf = (g: string): "kit" | "tier" | null => (g === "kit" || g === "tier" ? g : null);

  // Sessions
  const db = env.DATA_DB;
  // Visitors are distinct per row, so every level (market+group, market,
  // non-UK, all) is its own COUNT(DISTINCT) rather than a sum.
  const W = `FROM sessions WHERE day BETWEEN ?1 AND ?2 AND ts >= ${startMs}`;
  const NUK = `AND country != 'GB'`;
  const [byMarketGrp, byMarket, nonUkGrp, nonUk, all, byDayGrp, byDay, first] = await db.batch([
    db.prepare(`SELECT ${MARKET_SQL} AS market, grp, COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W} GROUP BY market, grp`).bind(since, until),
    db.prepare(`SELECT ${MARKET_SQL} AS market, COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W} GROUP BY market`).bind(since, until),
    db.prepare(`SELECT grp, COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W} ${NUK} GROUP BY grp`).bind(since, until),
    db.prepare(`SELECT COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W} ${NUK}`).bind(since, until),
    db.prepare(`SELECT COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W}`).bind(since, until),
    db.prepare(`SELECT day, grp, COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W} ${NUK} GROUP BY day, grp`).bind(since, until),
    db.prepare(`SELECT day, COUNT(*) AS s, COUNT(DISTINCT vid) AS v ${W} GROUP BY day`).bind(since, until),
    db.prepare(`SELECT MIN(ts) AS t FROM sessions`),
  ]);
  type Row = { market?: string; day?: string; grp?: string; s: number; v: number };
  const setSV = (c: Cell | undefined, r: Row) => c && Object.assign(c, { sessions: r.s, visitors: r.v });
  for (const r of byMarketGrp.results as Row[]) {
    const g = grpOf(r.grp || "");
    if (g) setSV(markets[r.market as Market]?.[g], r);
  }
  for (const r of byMarket.results as Row[]) setSV(markets[r.market as Market]?.total, r);
  for (const r of nonUkGrp.results as Row[]) {
    const g = grpOf(r.grp || "");
    if (g) setSV(markets.NON_UK[g], r);
  }
  for (const r of nonUk.results as Row[]) setSV(markets.NON_UK.total, r);
  for (const r of all.results as Row[]) setSV(markets.ALL.total, r);
  for (const r of byDayGrp.results as Row[]) {
    const g = grpOf(r.grp || "");
    if (g) setSV(daily.get(r.day!)?.[g], r);
  }
  for (const r of byDay.results as Row[]) setSV(daily.get(r.day!)?.total, r);
  const firstTs = (first.results[0] as { t: number | null } | undefined)?.t ?? null;

  // Orders
  const untracked = { orders: 0, revenue: 0, bySource: {} as Record<string, number> };
  let ordersBeforeTracking = 0;
  let shopifyError: string | null = null;
  if (!shopifyConfigured(env)) {
    shopifyError = "Shopify is not configured";
  } else {
    const fromISO = new Date(Math.max(startOfAest(since), startMs)).toISOString();
    const toISO = new Date(startOfAest(until) + DAY_MS).toISOString();
    const q = `created_at:>='${fromISO}' created_at:<'${toISO}'`;
    try {
      let after: string | null = null;
      for (let page = 0; page < 100; page++) {
        type R = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: OrderNode[] } };
        const data: R = await adminGraphQL<R>(env, ORDERS_QUERY, { q, after });
        for (const o of data.orders.nodes) {
          if (o.test || o.cancelledAt) continue;
          const created = Date.parse(o.createdAt);
          const tracked = firstTs !== null && created >= firstTs;
          const cc = o.shippingAddress?.countryCodeV2 || o.billingAddress?.countryCodeV2 || null;
          const market = marketOf(cc);
          const nonUk = market !== "GB";
          const attr = o.customAttributes.find((a) => a.key === "_bundle_test")?.value || "";
          const web = o.sourceName === "web";
          const g = grpOf(attr) ?? (market === "GB" && web ? "kit" : null);
          const revenue = Number(o.currentSubtotalPriceSet.shopMoney.amount) || 0;
          const sales = Number(o.currentTotalPriceSet.shopMoney.amount) || 0;
          const discounts = Number(o.currentTotalDiscountsSet.shopMoney.amount) || 0;
          const add = (c: Cell | undefined) => {
            if (!c) return;
            c.orders++;
            if (tracked) c.convOrders++;
            c.revenue += revenue;
            c.sales += sales;
            c.units += o.currentSubtotalLineItemsQuantity || 0;
            c.discounts += discounts;
          };
          const day = daily.get(aestDate(new Date(created)));

          // Market totals: every order.
          add(markets[market].total);
          add(markets.ALL.total);
          if (nonUk) add(markets.NON_UK.total);
          add(day?.total);
          if (!tracked) ordersBeforeTracking++;

          // Split groups: every tagged order (orders, AOV, units); only those placed
          // while session tracking was running count toward conversion (convOrders).
          if (!g) {
            markets[market].untracked++;
            if (nonUk) markets.NON_UK.untracked++;
            untracked.orders++;
            untracked.revenue += revenue;
            const src = o.sourceName || "unknown";
            untracked.bySource[src] = (untracked.bySource[src] || 0) + 1;
            continue;
          }
          add(markets[market][g]);
          if (nonUk) {
            add(markets.NON_UK[g]);
            add(day?.[g]);
          }
        }
        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
      }
    } catch (e) {
      shopifyError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    range: { since, until, start },
    trackingSince: firstTs ? new Date(firstTs).toISOString() : null,
    markets,
    daily: [...daily.values()],
    untracked,
    ordersBeforeTracking,
    shopifyError,
    fetchedAt: new Date().toISOString(),
  };
}
