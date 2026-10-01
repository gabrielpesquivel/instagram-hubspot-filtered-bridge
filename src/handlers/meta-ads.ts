import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { getConnection } from "../services/facebook-oauth";
import { adminGraphQL, shopifyConfigured } from "../services/shopify-api";
import { aestDate } from "./gangsheet-orders";

// Meta Ads page (#/ads). Read-only reporting over the Marketing API using the
// long-lived USER token kept by the Meta connection (needs the ads_read scope —
// connections made before it was added must reconnect once in Settings).
//
// One GET returns everything the page shows for a date range: headline totals
// vs the previous equal-length period, a daily trend, campaigns → ad sets, and
// per-ad rows with thumbnails. Meta's own purchase value is blended with real
// Shopify sales for MER (Shopify revenue ÷ Meta spend), since Meta's attributed
// ROAS over-counts. Day boundaries are AEST (UTC+10, like the rest of the
// worker); Meta buckets by the ad account's timezone, so during daylight saving
// the two can be an hour apart at the day edges.

// Marketing API versions retire ~yearly (v24 expires 2026-10-06) — bump here.
const ADS_API = "https://graph.facebook.com/v25.0";
const ACCOUNT_KEY = "meta_ads_account";
const CACHE_PREFIX = "meta_ads_report:";
const CACHE_TTL_SEC = 600;
const SHOP_DAY_PREFIX = "meta_ads_shopday:";
const SHOP_DAY_TTL_SEC = 7 * 86400; // completed days; re-pulled weekly to pick up refunds
const MAX_RANGE_DAYS = 92;
const THUMB_ADS = 80; // ads (by spend) that get a thumbnail lookup

// Purchase action types overlap (omni ⊇ pixel) — take the first present, never sum.
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

const INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "inline_link_clicks",
  "actions",
  "action_values",
];

class NeedsReconnect extends Error {}

interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number; // link clicks
  purchases: number;
  revenue: number; // Meta-attributed purchase value
}

interface InsightRow {
  [k: string]: unknown;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
  date_start?: string;
}

interface AdAccount {
  id: string;
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
  amount_spent?: string; // lifetime, minor units
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function pickAction(list: InsightRow["actions"]): number {
  if (!list) return 0;
  for (const t of PURCHASE_TYPES) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

function toMetrics(r: InsightRow | undefined): Metrics {
  return {
    spend: num(r?.spend),
    impressions: num(r?.impressions),
    reach: num(r?.reach),
    frequency: num(r?.frequency),
    clicks: num(r?.inline_link_clicks),
    purchases: pickAction(r?.actions),
    revenue: pickAction(r?.action_values),
  };
}

async function userToken(env: Env): Promise<string> {
  const conn = await getConnection(env);
  if (!conn?.user_access_token) throw new NeedsReconnect("Meta connection has no user token — reconnect in Settings.");
  // Without ads_read Meta answers ad-account calls with a generic "#100
  // Unsupported get request" rather than a permission error, so check the
  // grant explicitly.
  const perms: { data?: { permission: string; status: string }[] } = await graphGet(
    `${ADS_API}/me/permissions?access_token=${encodeURIComponent(conn.user_access_token)}`
  );
  if (!perms.data?.some((p) => p.permission === "ads_read" && p.status === "granted")) {
    throw new NeedsReconnect("The Meta connection hasn't been granted ads_read.");
  }
  return conn.user_access_token;
}

/** GET a Marketing API path, following paging.next. Permission/token errors
 *  surface as NeedsReconnect so the page can show the reconnect prompt. */
async function graphAll<T>(token: string, path: string, params: Record<string, string>, maxPages = 20): Promise<T[]> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  let url: string | null = `${ADS_API}/${path}?${qs}`;
  const out: T[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const json: { data: T[]; paging?: { next?: string } } = await graphGet(url);
    out.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return out;
}

async function graphGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as { error?: { message: string; code: number } } & T;
  if (json.error) {
    const { code, message } = json.error;
    // 190 = bad/expired token; 10 / 200-299 = missing permission (ads_read)
    if (code === 190 || code === 10 || (code >= 200 && code < 300)) throw new NeedsReconnect(message);
    const where = new URL(url).pathname.replace(/^\/v[\d.]+/, "") || "/";
    throw new Error(`Meta API ${code} on ${where}: ${message}`);
  }
  if (!res.ok) throw new Error(`Meta API HTTP ${res.status}`);
  return json;
}

async function listAccounts(token: string): Promise<AdAccount[]> {
  return graphAll<AdAccount>(token, "me/adaccounts", {
    fields: "id,name,currency,timezone_name,account_status,amount_spent",
    limit: "100",
  });
}

async function selectedAccount(env: Env, token: string): Promise<{ account: AdAccount | null; accounts: AdAccount[] }> {
  const accounts = await listAccounts(token);
  const saved = await env.PROFILE_CACHE.get(ACCOUNT_KEY);
  // Default to the active account that has spent the most — a user often also
  // sees personal / old empty ad accounts alongside the store's real one.
  const bySpend = [...accounts].sort((a, b) => num(b.amount_spent) - num(a.amount_spent));
  const account =
    accounts.find((a) => a.id === saved) ||
    bySpend.find((a) => a.account_status === 1) || // 1 = ACTIVE
    bySpend[0] ||
    null;
  return { account, accounts };
}

// ── Dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseYmd = (s: string) => Date.parse(`${s}T00:00:00Z`);

function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  for (let t = parseYmd(since); t <= parseYmd(until); t += DAY_MS) out.push(ymd(t));
  return out;
}

// ── Shopify sales per AEST day (for MER) ─────────────────────────────────────

interface ShopDay {
  revenue: number;
  orders: number;
}

const ORDERS_QUERY = `query($q: String!, $after: String) {
  orders(first: 250, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt test cancelledAt currentTotalPriceSet { shopMoney { amount } } }
  }
}`;

/** Sales (current totals: incl. shipping/tax, net of refunds; test + cancelled
 *  excluded) per AEST day. Completed days are cached in KV so a range only
 *  pulls the days it hasn't seen this week; today is always live. */
async function shopifyDaily(env: Env, days: string[]): Promise<Record<string, ShopDay>> {
  const today = aestDate();
  const out: Record<string, ShopDay> = {};
  const cached = await Promise.all(
    days.map((d) => (d < today ? env.PROFILE_CACHE.get<ShopDay>(SHOP_DAY_PREFIX + d, "json") : Promise.resolve(null)))
  );
  const missing: string[] = [];
  days.forEach((d, i) => {
    if (cached[i]) out[d] = cached[i]!;
    else missing.push(d);
  });
  if (!missing.length) return out;

  // One window spanning every missing day (already-cached days inside it are
  // just re-bucketed — cheaper than several windowed pulls).
  const from = missing[0];
  const to = missing[missing.length - 1];
  const fromISO = new Date(parseYmd(from) - 10 * 3600_000).toISOString();
  const toISO = new Date(parseYmd(to) + DAY_MS - 10 * 3600_000).toISOString();
  const q = `created_at:>='${fromISO}' created_at:<'${toISO}'`;

  const fresh: Record<string, ShopDay> = {};
  for (const d of daysBetween(from, to)) fresh[d] = { revenue: 0, orders: 0 };
  let after: string | null = null;
  for (let page = 0; page < 80; page++) {
    type R = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { createdAt: string; test: boolean; cancelledAt: string | null; currentTotalPriceSet: { shopMoney: { amount: string } } }[] } };
    const data: R = await adminGraphQL<R>(env, ORDERS_QUERY, { q, after });
    for (const o of data.orders.nodes) {
      if (o.test || o.cancelledAt) continue;
      const day = aestDate(new Date(o.createdAt));
      if (!fresh[day]) continue;
      fresh[day].revenue += num(o.currentTotalPriceSet.shopMoney.amount);
      fresh[day].orders += 1;
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  await Promise.all(
    missing.map((d) => {
      out[d] = fresh[d] || { revenue: 0, orders: 0 };
      return d < today
        ? env.PROFILE_CACHE.put(SHOP_DAY_PREFIX + d, JSON.stringify(out[d]), { expirationTtl: SHOP_DAY_TTL_SEC })
        : Promise.resolve();
    })
  );
  return out;
}

// ── Report ───────────────────────────────────────────────────────────────────

async function buildReport(env: Env, token: string, account: AdAccount, since: string, until: string) {
  const span = daysBetween(since, until).length;
  const prevUntil = ymd(parseYmd(since) - DAY_MS);
  const prevSince = ymd(parseYmd(since) - span * DAY_MS);
  const act = account.id;
  const range = (s: string, u: string) => JSON.stringify({ since: s, until: u });
  const fields = INSIGHT_FIELDS.join(",");

  const insights = (params: Record<string, string>) =>
    graphAll<InsightRow>(token, `${act}/insights`, { fields, limit: "500", ...params });

  const [curRows, prevRows, dailyRows, campRows, adsetRows, adRows, campaigns, adsets, shop] = await Promise.all([
    insights({ time_range: range(since, until) }),
    insights({ time_range: range(prevSince, prevUntil) }),
    insights({ time_range: range(since, until), time_increment: "1" }),
    insights({ time_range: range(since, until), level: "campaign", fields: `${fields},campaign_id,campaign_name,objective` }),
    insights({ time_range: range(since, until), level: "adset", fields: `${fields},adset_id,adset_name,campaign_id` }),
    insights({
      time_range: range(since, until),
      level: "ad",
      fields: `${fields},ad_id,ad_name,adset_name,campaign_name`,
      sort: "spend_descending",
    }),
    graphAll<{ id: string; effective_status: string; daily_budget?: string; lifetime_budget?: string }>(token, `${act}/campaigns`, {
      fields: "id,effective_status,daily_budget,lifetime_budget",
      limit: "500",
    }),
    graphAll<{ id: string; effective_status: string; daily_budget?: string; lifetime_budget?: string }>(token, `${act}/adsets`, {
      fields: "id,effective_status,daily_budget,lifetime_budget",
      limit: "500",
    }),
    shopifyConfigured(env)
      ? shopifyDaily(env, daysBetween(prevSince, until)).catch((e: Error) => ({ error: e.message }))
      : Promise.resolve({ error: "Shopify not configured" }),
  ]);

  const shopErr = "error" in shop ? String(shop.error) : null;
  const shopDays = shopErr ? {} : (shop as Record<string, ShopDay>);
  const shopSum = (days: string[]) =>
    days.reduce(
      (a, d) => ({ revenue: a.revenue + (shopDays[d]?.revenue || 0), orders: a.orders + (shopDays[d]?.orders || 0) }),
      { revenue: 0, orders: 0 }
    );

  // Meta budgets are in the account currency's minor unit (cents).
  const budget = (o?: { daily_budget?: string; lifetime_budget?: string }) =>
    o?.daily_budget ? { daily: num(o.daily_budget) / 100 } : o?.lifetime_budget ? { lifetime: num(o.lifetime_budget) / 100 } : null;
  const campMeta = new Map(campaigns.map((c) => [c.id, c]));
  const adsetMeta = new Map(adsets.map((a) => [a.id, a]));

  const adsetsByCampaign = new Map<string, unknown[]>();
  for (const r of adsetRows) {
    const cid = String(r.campaign_id);
    const meta = adsetMeta.get(String(r.adset_id));
    const list = adsetsByCampaign.get(cid) || [];
    list.push({
      id: r.adset_id,
      name: r.adset_name,
      status: meta?.effective_status || "UNKNOWN",
      budget: budget(meta),
      ...toMetrics(r),
    });
    adsetsByCampaign.set(cid, list);
  }

  const campaignOut = campRows
    .map((r) => {
      const meta = campMeta.get(String(r.campaign_id));
      return {
        id: r.campaign_id,
        name: r.campaign_name,
        objective: r.objective,
        status: meta?.effective_status || "UNKNOWN",
        budget: budget(meta),
        ...toMetrics(r),
        adsets: adsetsByCampaign.get(String(r.campaign_id)) || [],
      };
    })
    .sort((a, b) => b.spend - a.spend);

  // Thumbnails + status for the top ads by spend (ids batch: 50 per call).
  const topIds = adRows.slice(0, THUMB_ADS).map((r) => String(r.ad_id));
  const adInfo: Record<string, { effective_status?: string; creative?: { thumbnail_url?: string } }> = {};
  for (let i = 0; i < topIds.length; i += 50) {
    const qs = new URLSearchParams({
      ids: topIds.slice(i, i + 50).join(","),
      fields: "effective_status,creative.thumbnail_width(160).thumbnail_height(160){thumbnail_url}",
      access_token: token,
    });
    Object.assign(adInfo, await graphGet<typeof adInfo>(`${ADS_API}/?${qs}`).catch(() => ({})));
  }

  const ads = adRows.map((r) => {
    const info = adInfo[String(r.ad_id)];
    return {
      id: r.ad_id,
      name: r.ad_name,
      campaign: r.campaign_name,
      adset: r.adset_name,
      status: info?.effective_status || null,
      thumb: info?.creative?.thumbnail_url || null,
      ...toMetrics(r),
    };
  });

  const byDay = new Map(dailyRows.map((r) => [String(r.date_start), toMetrics(r)]));
  const daily = daysBetween(since, until).map((d) => {
    const m = byDay.get(d);
    return {
      date: d,
      spend: m?.spend || 0,
      revenue: m?.revenue || 0,
      purchases: m?.purchases || 0,
      shopifyRevenue: shopErr ? null : shopDays[d]?.revenue || 0,
    };
  });

  const curShop = shopSum(daysBetween(since, until));
  const prevShop = shopSum(daysBetween(prevSince, prevUntil));

  return {
    account: { id: account.id, name: account.name, currency: account.currency, timezone: account.timezone_name },
    range: { since, until },
    prev: { since: prevSince, until: prevUntil },
    totals: {
      cur: { ...toMetrics(curRows[0]), shopifyRevenue: curShop.revenue, shopifyOrders: curShop.orders },
      prev: { ...toMetrics(prevRows[0]), shopifyRevenue: prevShop.revenue, shopifyOrders: prevShop.orders },
    },
    daily,
    campaigns: campaignOut,
    ads,
    shopifyError: shopErr,
    fetchedAt: new Date().toISOString(),
  };
}

function errorResponse(e: unknown): Response {
  if (e instanceof NeedsReconnect) return jsonResponse({ needsReconnect: true, error: e.message }, 409);
  return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 502);
}

// ── API handlers ─────────────────────────────────────────────────────────────

/** GET /api/meta-ads?since=YYYY-MM-DD&until=YYYY-MM-DD[&refresh=1] */
export async function handleGetMetaAds(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const params = new URL(request.url).searchParams;
  const today = aestDate();
  const until = params.get("until") || today;
  const since = params.get("since") || ymd(parseYmd(until) - 6 * DAY_MS);
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(since) || !valid.test(until) || since > until) {
    return jsonResponse({ error: "Invalid date range" }, 400);
  }
  if (daysBetween(since, until).length > MAX_RANGE_DAYS) {
    return jsonResponse({ error: `Range too long — max ${MAX_RANGE_DAYS} days` }, 400);
  }

  try {
    const token = await userToken(env);
    const { account, accounts } = await selectedAccount(env, token);
    if (!account) return jsonResponse({ error: "No ad accounts found for the connected Meta user." }, 404);

    const cacheKey = `${CACHE_PREFIX}${account.id}:${since}:${until}`;
    if (params.get("refresh") !== "1") {
      const hit = await env.PROFILE_CACHE.get(cacheKey, "json");
      if (hit) return jsonResponse({ ...(hit as object), accounts, cached: true });
    }
    const report = await buildReport(env, token, account, since, until);
    await env.PROFILE_CACHE.put(cacheKey, JSON.stringify(report), { expirationTtl: CACHE_TTL_SEC });
    return jsonResponse({ ...report, accounts, cached: false });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/meta-ads/account { id } — choose which ad account the page shows. */
export async function handleSetMetaAdsAccount(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id || !/^act_\d+$/.test(id)) return jsonResponse({ error: "Invalid ad account id" }, 400);
  await env.PROFILE_CACHE.put(ACCOUNT_KEY, id);
  return jsonResponse({ ok: true });
}

/** GET /api/meta-ads/debug — what Meta returns for this connection, for
 *  diagnosing empty reports. No tokens in the output. */
export async function handleMetaAdsDebug(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const out: Record<string, unknown> = {};
  try {
    const conn = await getConnection(env);
    out.connectedAt = conn?.connected_at;
    out.hasUserToken = !!conn?.user_access_token;
    if (!conn?.user_access_token) return jsonResponse(out);
    const token = conn.user_access_token;
    const q = (p: string) => `${ADS_API}/${p}${p.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
    const safe = (p: string) => graphGet<unknown>(q(p)).catch((e: Error) => ({ error: e.message }));
    out.me = await safe("me?fields=id,name");
    out.permissions = await safe("me/permissions");
    const accounts = await listAccounts(token).catch((e: Error) => ({ error: e.message }));
    out.selectedSaved = await env.PROFILE_CACHE.get(ACCOUNT_KEY);
    out.accounts = Array.isArray(accounts)
      ? await Promise.all(
          accounts.map(async (a) => ({
            ...a,
            last30d: await safe(`${a.id}/insights?fields=spend,impressions,actions,action_values&date_preset=last_30d`),
          }))
        )
      : accounts;
    out.businesses = await safe("me/businesses?fields=id,name");
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return jsonResponse(out);
}
