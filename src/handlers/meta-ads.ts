import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { getConnection } from "../services/facebook-oauth";
import { adminGraphQL, shopifyConfigured } from "../services/shopify-api";
import { aestDate } from "./gangsheet-orders";
import { getGoogleConnection, getValidGoogleToken } from "../services/google-oauth";
import { sendNewEmail } from "../services/gmail-api";
import { cerr } from "../services/logger";

// Meta Ads page (#/ads). Read-only reporting over the Marketing API using the
// long-lived USER token kept by the Meta connection (needs the ads_read scope —
// connections made before it was added must reconnect once in Settings).
//
// One GET returns everything the page shows for a date range: headline totals
// vs the previous equal-length period, a daily trend, campaigns → ad sets, and
// per-ad rows with thumbnails. Meta's own purchase value is blended with real
// Shopify sales for MER (Shopify revenue ÷ Meta spend), since Meta's attributed
// ROAS over-counts. Shopify's own last-click attribution (the UTM tags on the
// session that placed each order) is matched back to Meta campaigns / ads via
// the ads' url_tags, giving a third figure between Meta's claim and MER. Day
// boundaries are AEST (UTC+10, like the rest of the worker); Meta buckets by
// the ad account's timezone, so during daylight saving the two can be an hour
// apart at the day edges.

// Marketing API versions retire ~yearly (v24 expires 2026-10-06) — bump here.
const ADS_API = "https://graph.facebook.com/v25.0";
const ACCOUNT_KEY = "meta_ads_account";
const CACHE_PREFIX = "meta_ads_report:";
const CACHE_TTL_SEC = 600;
const SHOP_DAY_PREFIX = "meta_ads_shopday3:"; // v3: UTM attribution buckets + new-customer split
const SHOP_DAY_TTL_SEC = 7 * 86400; // completed days; re-pulled weekly to pick up refunds
const MAX_RANGE_DAYS = 92;
const DIGEST_KEY = "meta_ads_digest"; // { to, enabled }
// Fatigue is judged on a fixed trailing week so the verdict doesn't change
// with the date range picked: frequency over 30 days is naturally high.
const FATIGUE_DAYS = 7;
const FATIGUE_FREQ = 3;
const FATIGUE_CTR_DROP = 0.3; // CTR down 30%+ vs the week before
const FATIGUE_MIN_IMPR = 2000; // per week, before a CTR drop means anything
const THUMB_ADS = 80; // ads (by spend) that get a thumbnail + url_tags lookup

// Action types overlap (omni ⊇ pixel) — take the first present, never sum.
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const FUNNEL_TYPES = {
  landingPageViews: ["landing_page_view"],
  contentViews: ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"],
  addToCarts: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  checkouts: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"],
};

const INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "inline_link_clicks",
  "unique_inline_link_clicks",
  "video_thruplay_watched_actions",
  "actions",
  "action_values",
];
// Ad-level only: Meta's relative creative diagnostics.
const RANKING_FIELDS = "quality_ranking,engagement_rate_ranking,conversion_rate_ranking";

class NeedsReconnect extends Error {}

interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number; // link clicks
  uniqueClicks: number;
  videoPlays: number; // 3-second plays (actions: video_view)
  thruplays: number;
  landingPageViews: number;
  contentViews: number;
  addToCarts: number;
  checkouts: number;
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
  unique_inline_link_clicks?: string;
  video_thruplay_watched_actions?: { action_type: string; value: string }[];
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

function pickAction(list: InsightRow["actions"], types: string[] = PURCHASE_TYPES): number {
  if (!list) return 0;
  for (const t of types) {
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
    uniqueClicks: num(r?.unique_inline_link_clicks),
    videoPlays: pickAction(r?.actions, ["video_view"]),
    thruplays: pickAction(r?.video_thruplay_watched_actions, ["video_view"]),
    landingPageViews: pickAction(r?.actions, FUNNEL_TYPES.landingPageViews),
    contentViews: pickAction(r?.actions, FUNNEL_TYPES.contentViews),
    addToCarts: pickAction(r?.actions, FUNNEL_TYPES.addToCarts),
    checkouts: pickAction(r?.actions, FUNNEL_TYPES.checkouts),
    purchases: pickAction(r?.actions),
    revenue: pickAction(r?.action_values),
  };
}

// ── UTM ↔ Meta ad matching ───────────────────────────────────────────────────

/** Normalised "campaign\u0000content" key for a Shopify sales bucket. */
const utmKey = (campaign: string, content: string) => `${campaign.trim().toLowerCase()}\u0000${content.trim().toLowerCase()}`;

interface Visit {
  source?: string | null;
  referrerUrl?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null } | null;
}

/** The UTM campaign/content of a Shopify session if it came from a paid Meta
 *  ad. Organic Instagram/Facebook traffic (link in bio, page posts, plain
 *  referrals without tags) is deliberately NOT counted — only tagged paid
 *  sessions, so the figure stays a fair comparison with Meta's own claim. */
function metaPaidUtm(v: Visit | null | undefined): { campaign: string; content: string } | null {
  const u = v?.utmParameters;
  if (!u) return null;
  const src = (u.source || "").toLowerCase();
  const med = (u.medium || "").toLowerCase();
  const paidMedium = /^(f|fb|paid|paid[_-]?social|paidsocial|cpc|ppc|cpm)$/.test(med);
  const metaSource = /^(p|fb|ig|facebook|instagram|meta|fbig|facebook_ads|instagram_ads)$/.test(src);
  const organicMedium = /^(social|organic|bio|link_in_bio)$/.test(med);
  if (paidMedium || (metaSource && !organicMedium)) return { campaign: u.campaign || "", content: u.content || "" };
  return null;
}

/** Resolve Meta's url_tags ("utm_source=p&utm_campaign={{campaign.name}}…")
 *  for one ad into the UTM campaign/content a Shopify session would carry.
 *  Falls back to the campaign / ad names when there are no tags. */
function adUtm(
  urlTags: string | undefined,
  names: { campaign: string; adset: string; ad: string; campaignId: string; adsetId: string; adId: string }
): { campaign: string; content: string } {
  const fill = (v: string) =>
    v.replace(/\{\{\s*([a-z]+)\.(name|id)\s*\}\}/gi, (_, obj: string, prop: string) => {
      const o = obj.toLowerCase();
      if (prop === "id") return o === "campaign" ? names.campaignId : o === "adset" ? names.adsetId : names.adId;
      return o === "campaign" ? names.campaign : o === "adset" ? names.adset : names.ad;
    });
  if (urlTags) {
    const tags = new URLSearchParams(urlTags.replace(/^\?/, ""));
    const campaign = tags.get("utm_campaign");
    const content = tags.get("utm_content");
    if (campaign != null || content != null) return { campaign: fill(campaign || ""), content: fill(content || "") };
  }
  return { campaign: names.campaign, content: names.ad };
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

interface Bucket {
  revenue: number;
  orders: number;
  newOrders: number; // customer's first order
  newRevenue: number;
}

interface ShopDay extends Bucket {
  meta: Bucket; // last-click from a tagged paid Meta session (any campaign)
  utm: Record<string, Bucket>; // utmKey(campaign, content) → Meta last-click sales
}

const emptyBucket = (): Bucket => ({ revenue: 0, orders: 0, newOrders: 0, newRevenue: 0 });
const emptyDay = (): ShopDay => ({ ...emptyBucket(), meta: emptyBucket(), utm: {} });
const addTo = (b: Bucket, revenue: number, isNew: boolean) => {
  b.revenue += revenue;
  b.orders += 1;
  if (isNew) {
    b.newOrders += 1;
    b.newRevenue += revenue;
  }
};
const addBucket = (into: Bucket, b: Bucket) => {
  into.revenue += b.revenue;
  into.orders += b.orders;
  into.newOrders += b.newOrders;
  into.newRevenue += b.newRevenue;
};

// 100 per page: customerJourneySummary adds nested cost per order and a
// 250-row page would exceed Shopify's single-query cost ceiling.
const ORDERS_QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt test cancelledAt currentTotalPriceSet { shopMoney { amount } }
      customerJourneySummary {
        ready customerOrderIndex
        lastVisit { source referrerUrl utmParameters { source medium campaign content } }
      }
    }
  }
}`;

/** Sales (current totals: incl. shipping/tax, net of refunds; test + cancelled
 *  excluded) per AEST day, with Shopify's last-click attribution split out
 *  for paid Meta sessions. Completed days are cached in KV so a range only
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
  for (const d of daysBetween(from, to)) fresh[d] = emptyDay();
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    type Node = {
      createdAt: string;
      test: boolean;
      cancelledAt: string | null;
      currentTotalPriceSet: { shopMoney: { amount: string } };
      customerJourneySummary: { ready: boolean; customerOrderIndex: number | null; lastVisit: Visit | null } | null;
    };
    type R = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } };
    const data: R = await adminGraphQL<R>(env, ORDERS_QUERY, { q, after });
    for (const o of data.orders.nodes) {
      if (o.test || o.cancelledAt) continue;
      const day = aestDate(new Date(o.createdAt));
      const bucket = fresh[day];
      if (!bucket) continue;
      const revenue = num(o.currentTotalPriceSet.shopMoney.amount);
      const journey = o.customerJourneySummary;
      const isNew = journey?.customerOrderIndex === 1;
      addTo(bucket, revenue, isNew);
      const utm = journey?.ready ? metaPaidUtm(journey.lastVisit) : null;
      if (utm) {
        addTo(bucket.meta, revenue, isNew);
        const key = utmKey(utm.campaign, utm.content);
        addTo((bucket.utm[key] ??= emptyBucket()), revenue, isNew);
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  await Promise.all(
    missing.map((d) => {
      out[d] = fresh[d] || emptyDay();
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

  // Fatigue windows: the last FATIGUE_DAYS ending at `until`, and the week before.
  const fatUntil = until;
  const fatSince = ymd(parseYmd(until) - (FATIGUE_DAYS - 1) * DAY_MS);
  const fatPrevUntil = ymd(parseYmd(fatSince) - DAY_MS);
  const fatPrevSince = ymd(parseYmd(fatSince) - FATIGUE_DAYS * DAY_MS);
  const recentFields = "ad_id,spend,impressions,frequency,inline_link_clicks";

  const [curRows, prevRows, dailyRows, campRows, adsetRows, adRows, campaigns, adsets, shop, byCountry, byPlacement, byAgeGender, recentAds, prevRecentAds] = await Promise.all([
    insights({ time_range: range(since, until) }),
    insights({ time_range: range(prevSince, prevUntil) }),
    insights({ time_range: range(since, until), time_increment: "1" }),
    insights({ time_range: range(since, until), level: "campaign", fields: `${fields},campaign_id,campaign_name,objective` }),
    insights({ time_range: range(since, until), level: "adset", fields: `${fields},adset_id,adset_name,campaign_id` }),
    insights({
      time_range: range(since, until),
      level: "ad",
      fields: `${fields},${RANKING_FIELDS},ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name`,
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
    insights({ time_range: range(since, until), breakdowns: "country" }),
    insights({ time_range: range(since, until), breakdowns: "publisher_platform,platform_position" }),
    insights({ time_range: range(since, until), breakdowns: "age,gender" }),
    graphAll<InsightRow>(token, `${act}/insights`, { fields: recentFields, level: "ad", limit: "500", time_range: range(fatSince, fatUntil) }),
    graphAll<InsightRow>(token, `${act}/insights`, { fields: recentFields, level: "ad", limit: "500", time_range: range(fatPrevSince, fatPrevUntil) }),
  ]);

  const breakdownRows = (rows: InsightRow[], name: (r: InsightRow) => string) =>
    rows.map((r) => ({ name: name(r), ...toMetrics(r) })).sort((a, b) => b.spend - a.spend);
  const breakdowns = {
    country: breakdownRows(byCountry, (r) => String(r.country ?? "")),
    placement: breakdownRows(byPlacement, (r) => `${r.publisher_platform ?? ""}/${r.platform_position ?? ""}`),
    ageGender: breakdownRows(byAgeGender, (r) => `${r.age ?? ""} ${r.gender ?? ""}`),
  };

  type Recent = { spend: number; impressions: number; frequency: number; ctr: number };
  const recentOf = (r: InsightRow | undefined): Recent => ({
    spend: num(r?.spend),
    impressions: num(r?.impressions),
    frequency: num(r?.frequency),
    ctr: num(r?.impressions) > 0 ? num(r?.inline_link_clicks) / num(r?.impressions) : 0,
  });
  const recentMap = new Map(recentAds.map((r) => [String(r.ad_id), recentOf(r)]));
  const prevRecentMap = new Map(prevRecentAds.map((r) => [String(r.ad_id), recentOf(r)]));

  const shopErr = "error" in shop ? String(shop.error) : null;
  const shopDays = shopErr ? {} : (shop as Record<string, ShopDay>);
  const shopSum = (days: string[]) => {
    const all = emptyBucket();
    const meta = emptyBucket();
    for (const d of days) {
      const day = shopDays[d];
      if (!day) continue;
      addBucket(all, day);
      addBucket(meta, day.meta);
    }
    return { all, meta };
  };
  // Shopify last-click sales for the current range by UTM key, plus a
  // campaign-only index (any content) for campaign rows.
  const curDays = daysBetween(since, until);
  const utmSales = new Map<string, Bucket>();
  const campaignSales = new Map<string, Bucket>();
  for (const d of curDays) {
    for (const [key, b] of Object.entries(shopDays[d]?.utm || {})) {
      const sum = utmSales.get(key) || emptyBucket();
      addBucket(sum, b);
      utmSales.set(key, sum);
      const camp = key.slice(0, key.indexOf("\u0000"));
      const csum = campaignSales.get(camp) || emptyBucket();
      addBucket(csum, b);
      campaignSales.set(camp, csum);
    }
  }
  const shopOf = (b: Bucket | undefined) =>
    shopErr
      ? { shopRevenue: null, shopOrders: null, shopNewOrders: null }
      : { shopRevenue: b?.revenue || 0, shopOrders: b?.orders || 0, shopNewOrders: b?.newOrders || 0 };

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
        utmCampaign: "",
        shopRevenue: null as number | null,
        shopOrders: null as number | null,
        shopNewOrders: null as number | null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  // Thumbnails, status and url_tags for the top ads by spend (ids batch: 50 per call).
  const topIds = adRows.slice(0, THUMB_ADS).map((r) => String(r.ad_id));
  const adInfo: Record<string, { effective_status?: string; creative?: { thumbnail_url?: string; url_tags?: string } }> = {};
  for (let i = 0; i < topIds.length; i += 50) {
    const qs = new URLSearchParams({
      ids: topIds.slice(i, i + 50).join(","),
      fields: "effective_status,creative.thumbnail_width(160).thumbnail_height(160){thumbnail_url,url_tags}",
      access_token: token,
    });
    Object.assign(adInfo, await graphGet<typeof adInfo>(`${ADS_API}/?${qs}`).catch(() => ({})));
  }

  // Which UTM campaign code each Meta campaign's ads carry (most common wins)
  // so campaign rows can total every tagged order, not just the top ads'.
  const campaignCodeVotes = new Map<string, Map<string, number>>();
  const ads = adRows.map((r) => {
    const info = adInfo[String(r.ad_id)];
    const utm = adUtm(info?.creative?.url_tags, {
      campaign: String(r.campaign_name ?? ""),
      adset: String(r.adset_name ?? ""),
      ad: String(r.ad_name ?? ""),
      campaignId: String(r.campaign_id ?? ""),
      adsetId: String(r.adset_id ?? ""),
      adId: String(r.ad_id ?? ""),
    });
    const code = utm.campaign.trim().toLowerCase();
    const votes = campaignCodeVotes.get(String(r.campaign_id)) || new Map<string, number>();
    votes.set(code, (votes.get(code) || 0) + 1);
    campaignCodeVotes.set(String(r.campaign_id), votes);
    const status = info?.effective_status || null;
    const recent = recentMap.get(String(r.ad_id)) || recentOf(undefined);
    const before = prevRecentMap.get(String(r.ad_id)) || recentOf(undefined);
    const ctrDrop =
      before.impressions >= FATIGUE_MIN_IMPR && recent.impressions >= FATIGUE_MIN_IMPR && before.ctr > 0 ? 1 - recent.ctr / before.ctr : 0;
    const fatigued =
      recent.spend > 0 && (!status || status === "ACTIVE") && (recent.frequency >= FATIGUE_FREQ || ctrDrop >= FATIGUE_CTR_DROP);
    return {
      id: r.ad_id,
      name: r.ad_name,
      campaign: r.campaign_name,
      adset: r.adset_name,
      status,
      thumb: info?.creative?.thumbnail_url || null,
      utm: { campaign: utm.campaign, content: utm.content },
      rankings: {
        quality: (r.quality_ranking as string) || null,
        engagement: (r.engagement_rate_ranking as string) || null,
        conversion: (r.conversion_rate_ranking as string) || null,
      },
      recent: { ...recent, prevCtr: before.ctr, ctrDrop },
      fatigued,
      ...toMetrics(r),
      ...shopOf(utmSales.get(utmKey(utm.campaign, utm.content))),
    };
  });
  const campaignCode = (id: string, name: string) => {
    const votes = campaignCodeVotes.get(id);
    if (!votes?.size) return name.trim().toLowerCase();
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  for (const c of campaignOut) {
    const code = campaignCode(String(c.id), String(c.name ?? ""));
    Object.assign(c, { utmCampaign: code, ...shopOf(campaignSales.get(code)) });
  }
  // Tagged Meta sales whose campaign code matches no campaign that spent in
  // this range (old tags, renamed campaigns, hand-typed codes).
  const matchedCodes = new Set(campaignOut.map((c) => (c as { utmCampaign?: string }).utmCampaign));
  const unmatched = emptyBucket();
  for (const [code, b] of campaignSales) {
    if (matchedCodes.has(code)) continue;
    addBucket(unmatched, b);
  }

  const byDay = new Map(dailyRows.map((r) => [String(r.date_start), toMetrics(r)]));
  const daily = daysBetween(since, until).map((d) => {
    const m = byDay.get(d);
    return {
      date: d,
      spend: m?.spend || 0,
      revenue: m?.revenue || 0,
      purchases: m?.purchases || 0,
      shopifyRevenue: shopErr ? null : shopDays[d]?.revenue || 0,
      shopifyMetaRevenue: shopErr ? null : shopDays[d]?.meta.revenue || 0,
    };
  });

  const curShop = shopSum(curDays);
  const prevShop = shopSum(daysBetween(prevSince, prevUntil));
  const shopTotals = (s: ReturnType<typeof shopSum>) => ({
    shopifyRevenue: s.all.revenue,
    shopifyOrders: s.all.orders,
    shopifyNewOrders: s.all.newOrders,
    shopifyNewRevenue: s.all.newRevenue,
    shopifyMetaRevenue: s.meta.revenue,
    shopifyMetaOrders: s.meta.orders,
    shopifyMetaNewOrders: s.meta.newOrders,
    shopifyMetaNewRevenue: s.meta.newRevenue,
  });

  return {
    account: { id: account.id, name: account.name, currency: account.currency, timezone: account.timezone_name },
    range: { since, until },
    prev: { since: prevSince, until: prevUntil },
    totals: {
      cur: { ...toMetrics(curRows[0]), ...shopTotals(curShop) },
      prev: { ...toMetrics(prevRows[0]), ...shopTotals(prevShop) },
    },
    shopifyUnmatched: shopErr ? null : { revenue: unmatched.revenue, orders: unmatched.orders },
    daily,
    campaigns: campaignOut,
    ads,
    breakdowns,
    fatigue: { since: fatSince, until: fatUntil, freq: FATIGUE_FREQ, ctrDrop: FATIGUE_CTR_DROP },
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

// ── Weekly digest ────────────────────────────────────────────────────────────

interface DigestSettings {
  to: string;
  enabled: boolean;
}

async function digestSettings(env: Env): Promise<DigestSettings> {
  return (await env.PROFILE_CACHE.get<DigestSettings>(DIGEST_KEY, "json")) || { to: "", enabled: false };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** GET /api/meta-ads/digest — current digest settings. */
export async function handleGetMetaAdsDigest(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  return jsonResponse(await digestSettings(env));
}

/** POST /api/meta-ads/digest { to, enabled } — save; { send: true, to? } — send one now. */
export async function handleSetMetaAdsDigest(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const b = (await request.json().catch(() => ({}))) as { to?: string; enabled?: boolean; send?: boolean };
  if (b.send) {
    const cur = await digestSettings(env);
    const to = (b.to ?? cur.to).trim();
    if (!EMAIL_RE.test(to)) return jsonResponse({ error: "Enter a valid email first" }, 400);
    try {
      await sendMetaAdsDigest(env, to);
      return jsonResponse({ ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  }
  const to = (b.to || "").trim();
  if (to && !EMAIL_RE.test(to)) return jsonResponse({ error: "Invalid email" }, 400);
  const next: DigestSettings = { to, enabled: !!b.enabled && !!to };
  await env.PROFILE_CACHE.put(DIGEST_KEY, JSON.stringify(next));
  return jsonResponse(next);
}

/** Monday-morning cron: last 7 full days vs the week before. */
export async function sendWeeklyMetaAdsDigest(env: Env): Promise<void> {
  const settings = await digestSettings(env);
  if (!settings.enabled || !settings.to) return;
  try {
    await sendMetaAdsDigest(env, settings.to);
  } catch (e) {
    await cerr(env, "Meta Ads digest failed:", e);
  }
}

async function sendMetaAdsDigest(env: Env, to: string): Promise<void> {
  const conn = await getGoogleConnection(env);
  const gmail = await getValidGoogleToken(env);
  if (!conn || !gmail) throw new Error("Gmail not connected — connect Google in Settings first.");
  const token = await userToken(env);
  const { account } = await selectedAccount(env, token);
  if (!account) throw new Error("No ad account.");
  const until = ymd(parseYmd(aestDate()) - DAY_MS); // yesterday: last complete day
  const since = ymd(parseYmd(until) - 6 * DAY_MS);
  const report = await buildReport(env, token, account, since, until);
  const html = digestHtml(report, account.currency);
  const subject = `Meta Ads week ${fmtDate(since)} – ${fmtDate(until)}: MER ${ratio(div(report.totals.cur.shopifyRevenue, report.totals.cur.spend))}, spend ${fmtMoney(report.totals.cur.spend, account.currency)}`;
  const threadId = await sendNewEmail(gmail, { to, fromEmail: conn.email, subject, body: html, html: true });
  if (!threadId) throw new Error("Gmail rejected the digest.");
}

const div = (a: number, b: number) => (b > 0 ? a / b : 0);
const ratio = (n: number) => `${n.toFixed(2)}×`;
const pctStr = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtMoney = (n: number, cur: string, dp = 0) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: cur, maximumFractionDigits: dp, minimumFractionDigits: dp }).format(n);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function digestHtml(report: Awaited<ReturnType<typeof buildReport>>, currency: string): string {
  const { cur, prev } = report.totals;
  const money = (n: number, dp = 0) => fmtMoney(n, currency, dp);
  const delta = (c: number, p: number, better: "up" | "down" | "neutral") => {
    if (!p) return "";
    const ch = (c - p) / p;
    if (Math.abs(ch) < 0.005) return `<span style="color:#6b7280">flat</span>`;
    const colour = better === "neutral" ? "#374151" : (ch > 0) === (better === "up") ? "#15803d" : "#c2410c";
    return `<span style="color:${colour}">${ch > 0 ? "▲" : "▼"} ${Math.abs(ch * 100).toFixed(0)}%</span>`;
  };
  const row = (label: string, value: string, d: string, note = "") =>
    `<tr><td style="padding:6px 10px;color:#374151">${label}</td><td style="padding:6px 10px;font-weight:700;text-align:right;white-space:nowrap">${value}</td><td style="padding:6px 10px;text-align:right;white-space:nowrap">${d}</td><td style="padding:6px 10px;color:#6b7280;font-size:12px">${note}</td></tr>`;
  const hasShop = !report.shopifyError;
  const mer = div(cur.shopifyRevenue, cur.spend);
  const lastClick = div(cur.shopifyMetaRevenue, cur.spend);
  const metaRoas = div(cur.revenue, cur.spend);
  const cac = div(cur.spend, cur.shopifyNewOrders);

  const headline = [
    row("Spend", money(cur.spend), delta(cur.spend, prev.spend, "neutral")),
    row("Meta ROAS", ratio(metaRoas), delta(metaRoas, div(prev.revenue, prev.spend), "up"), `${money(cur.revenue)} claimed by Meta`),
    hasShop ? row("Shopify last-click ROAS", ratio(lastClick), delta(lastClick, div(prev.shopifyMetaRevenue, prev.spend), "up"), `${money(cur.shopifyMetaRevenue)} · ${cur.shopifyMetaOrders} orders`) : "",
    hasShop ? row("MER (all sales ÷ spend)", ratio(mer), delta(mer, div(prev.shopifyRevenue, prev.spend), "up"), `${money(cur.shopifyRevenue)} · ${cur.shopifyOrders} orders`) : "",
    hasShop ? row("Blended CAC", money(cac, 2), delta(cac, div(prev.spend, prev.shopifyNewOrders), "down"), `${cur.shopifyNewOrders} new customers`) : "",
    row("Cost per purchase (Meta)", money(div(cur.spend, cur.purchases), 2), delta(div(cur.spend, cur.purchases), div(prev.spend, prev.purchases), "down"), `${cur.purchases} purchases`),
    row("Link CTR", pctStr(div(cur.clicks, cur.impressions)), delta(div(cur.clicks, cur.impressions), div(prev.clicks, prev.impressions), "up")),
    row("CPM", money(div(cur.spend, cur.impressions) * 1000, 2), delta(div(cur.spend, cur.impressions), div(prev.spend, prev.impressions), "down")),
  ].join("");

  // Funnel leak: lowest step-to-step rate.
  const allSteps: { label: string; key: keyof Metrics }[] = [
    { label: "Link clicks", key: "clicks" },
    { label: "Landing page views", key: "landingPageViews" },
    { label: "Product views", key: "contentViews" },
    { label: "Added to cart", key: "addToCarts" },
    { label: "Started checkout", key: "checkouts" },
    { label: "Purchases", key: "purchases" },
  ];
  const steps = allSteps.filter((st) => st.key === "clicks" || st.key === "purchases" || cur[st.key] > 0);
  const stepRate = (i: number) => div(cur[steps[i].key], cur[steps[i - 1].key]);
  let worst = -1;
  for (let i = 1; i < steps.length; i++) {
    if (cur[steps[i - 1].key] > 0 && (worst < 0 || stepRate(i) < stepRate(worst))) worst = i;
  }
  const leak =
    worst > 0
      ? `<p style="margin:14px 0 0"><strong>Biggest funnel leak:</strong> ${steps[worst - 1].label} → ${steps[worst].label}, only ${pctStr(stepRate(worst))} carry on.</p>`
      : "";

  const minSpend = Math.max(20, cur.spend * 0.02);
  const eligible = report.ads.filter((a) => a.spend >= minSpend);
  const byRoas = [...eligible].sort((a, b) => div(b.revenue, b.spend) - div(a.revenue, a.spend));
  const adLine = (a: (typeof report.ads)[number]) =>
    `<li><strong>${esc(a.name)}</strong> <span style="color:#6b7280">(${esc(a.campaign)})</span> — ROAS ${ratio(div(a.revenue, a.spend))}, spend ${money(a.spend)}${a.shopRevenue != null ? `, Shopify last-click ${money(a.shopRevenue)}` : ""}</li>`;
  const bestAds = byRoas.slice(0, 3);
  const best = bestAds.map(adLine).join("");
  const worstAds = byRoas.slice(-3).reverse().filter((a) => !bestAds.includes(a)).map(adLine).join("");
  const tired = report.ads
    .filter((a) => a.fatigued)
    .slice(0, 6)
    .map(
      (a) =>
        `<li><strong>${esc(a.name)}</strong> — seen ${a.recent.frequency.toFixed(1)}× per person this week${a.recent.ctrDrop >= FATIGUE_CTR_DROP ? `, CTR down ${Math.round(a.recent.ctrDrop * 100)}%` : ""}</li>`
    )
    .join("");

  const topCountries = report.breakdowns.country
    .slice(0, 5)
    .map((c) => `<li>${esc(c.name)} — spend ${money(c.spend)}, ROAS ${ratio(div(c.revenue, c.spend))}, ${c.purchases} purchases</li>`)
    .join("");

  const link = "https://bootink-internal-tools.soft-smoke-9baf.workers.dev/#/ads";
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111827;max-width:640px">
<h2 style="margin:0 0 4px">Meta Ads — week of ${fmtDate(report.range.since)} to ${fmtDate(report.range.until)}</h2>
<p style="margin:0 0 14px;color:#6b7280">Compared with ${fmtDate(report.prev.since)} – ${fmtDate(report.prev.until)}. Account: ${esc(report.account.name)}.</p>
<table style="border-collapse:collapse;width:100%;background:#f9fafb;border-radius:8px">${headline}</table>
${leak}
<h3 style="margin:18px 0 6px">Best ads (by Meta ROAS, spend ≥ ${money(minSpend)})</h3><ul style="margin:0;padding-left:18px">${best || "<li>None spent enough to judge.</li>"}</ul>
<h3 style="margin:18px 0 6px">Worst ads</h3><ul style="margin:0;padding-left:18px">${worstAds || "<li>—</li>"}</ul>
<h3 style="margin:18px 0 6px">Wearing out (last 7 days)</h3><ul style="margin:0;padding-left:18px">${tired || "<li>Nothing flagged.</li>"}</ul>
<h3 style="margin:18px 0 6px">Top countries</h3><ul style="margin:0;padding-left:18px">${topCountries || "<li>—</li>"}</ul>
<p style="margin:18px 0 0;color:#6b7280;font-size:12px">Full breakdown, funnel and campaign table: <a href="${link}">${link}</a>. Shopify last-click counts only orders whose final visit carried paid Meta UTM tags. MER = all Shopify sales ÷ Meta spend.</p>
</div>`;
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
