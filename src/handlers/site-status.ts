import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { REVIEWS_CACHE_KEY } from "./shop-reviews";

// Website status for the home-page hero card: is bootink.com up, how fast it
// responds (with a 24h history for the sparkline), plus the Shop review stats
// (synced into KV by the local scraper, see shop-reviews.ts). Pings come from
// the 10-min cron and from dashboard loads (rate-limited), so the history
// fills in even before a full cron day has passed.

const SITE_URL = "https://www.bootink.com/";
const CACHE_KEY = "site_status_cache";
const CACHE_TTL = 60; // seconds — KV minimum
const PING_TIMEOUT_MS = 10_000;

const HISTORY_KEY = "site_status_history";
const HISTORY_MAX = 144; // 24h at the 10-min cron cadence
const HISTORY_MIN_GAP_MS = 5 * 60_000; // dashboard loads don't spam points

interface Ping {
  ok: boolean;
  status: number;
  ms: number | null;
}

interface HistoryPoint {
  t: number; // epoch ms
  ms: number | null; // null = unreachable
  ok: boolean;
}

async function pingSite(): Promise<Ping> {
  const started = Date.now();
  try {
    // Shopify 403s bare worker fetches — needs a browser-looking UA.
    const response = await fetch(SITE_URL, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch {
    return { ok: false, status: 0, ms: null };
  }
}

async function appendHistory(env: Env, ping: Ping): Promise<HistoryPoint[]> {
  const raw = await env.PROFILE_CACHE.get(HISTORY_KEY);
  const history: HistoryPoint[] = raw ? JSON.parse(raw) : [];
  const last = history[history.length - 1];
  const now = Date.now();
  if (!last || now - last.t >= HISTORY_MIN_GAP_MS) {
    history.push({ t: now, ms: ping.ms, ok: ping.ok });
    while (history.length > HISTORY_MAX) history.shift();
    await env.PROFILE_CACHE.put(HISTORY_KEY, JSON.stringify(history));
  }
  return history;
}

/** Cron entry (every 10 min): keep the 24h response-time history ticking even
 *  when nobody has the dashboard open. Fail-soft by construction. */
export async function recordSitePing(env: Env): Promise<void> {
  await appendHistory(env, await pingSite());
}

export async function handleSiteStatus(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const cached = await env.PROFILE_CACHE.get(CACHE_KEY);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json" } });
  }

  const ping = await pingSite();
  const history = await appendHistory(env, ping);

  const reviewsRaw = await env.PROFILE_CACHE.get(REVIEWS_CACHE_KEY);
  const reviews = reviewsRaw ? JSON.parse(reviewsRaw) : null;

  const payload = JSON.stringify({
    live: ping.ok,
    status: ping.status,   // HTTP status (0 = no response)
    responseMs: ping.ms,   // null = unreachable
    checkedAt: new Date().toISOString(),
    reviews,               // { count, avgRating, updatedAt } or null if never synced
    history,               // [{ t, ms, ok }] — last 24h of pings for the sparkline
  });
  await env.PROFILE_CACHE.put(CACHE_KEY, payload, { expirationTtl: CACHE_TTL });
  return new Response(payload, { headers: { "Content-Type": "application/json" } });
}
