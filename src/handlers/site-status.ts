import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { REVIEWS_CACHE_KEY } from "./shop-reviews";

// Website status for the home-page card: is bootink.com up, how fast it
// responds, plus the Shop review stats (synced into KV by the local scraper,
// see shop-reviews.ts). Cached briefly so page loads don't each ping the
// storefront; response time is edge → origin, a steady like-for-like number.

const SITE_URL = "https://www.bootink.com/";
const CACHE_KEY = "site_status_cache";
const CACHE_TTL = 60; // seconds — KV minimum
const PING_TIMEOUT_MS = 10_000;

export async function handleSiteStatus(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const cached = await env.PROFILE_CACHE.get(CACHE_KEY);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json" } });
  }

  let live = false;
  let status = 0;
  let responseMs: number | null = null;
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
    responseMs = Date.now() - started;
    status = response.status;
    live = response.ok;
    await response.body?.cancel();
  } catch {
    // Unreachable/timeout — live stays false, responseMs stays null.
  }

  const reviewsRaw = await env.PROFILE_CACHE.get(REVIEWS_CACHE_KEY);
  const reviews = reviewsRaw ? JSON.parse(reviewsRaw) : null;

  const payload = JSON.stringify({
    live,
    status,          // HTTP status (0 = no response)
    responseMs,      // null = unreachable
    checkedAt: new Date().toISOString(),
    reviews,         // { count, avgRating, updatedAt } or null if never synced
  });
  await env.PROFILE_CACHE.put(CACHE_KEY, payload, { expirationTtl: CACHE_TTL });
  return new Response(payload, { headers: { "Content-Type": "application/json" } });
}
