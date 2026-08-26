import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { clog } from "../services/logger";

// Shop (shop.app) review stats for the home-page card. shop.app blocks
// datacenter IPs outright (challenge page regardless of UA spoofing —
// verified against both plain fetch and Browser Rendering), so the worker
// can't scrape it. Instead a local machine runs scripts/update_review_count.py
// on a schedule: it scrapes shop.app with real Chrome from a residential IP
// and POSTs the numbers here. Last good value persists in KV with no TTL.

export const REVIEWS_CACHE_KEY = "shop_reviews";
const CACHE_KEY = REVIEWS_CACHE_KEY;

// A parsed count below this is a bad scrape, not reality — refuse to store.
// The store had 1055 ratings on 2026-08-26; counts only grow.
const MIN_PLAUSIBLE_COUNT = 1000;

interface ShopReviews {
  count: number;
  avgRating: number | null;
  updatedAt: string;
}

/** GET /api/reviews — last synced stats (null fields = never synced). */
export async function handleGetShopReviews(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const cached = await env.PROFILE_CACHE.get(CACHE_KEY);
  if (!cached) {
    return jsonResponse({ count: null, avgRating: null, updatedAt: null });
  }
  return new Response(cached, { headers: { "Content-Type": "application/json" } });
}

/** POST /api/reviews — sync endpoint for the local scraper. */
export async function handlePostShopReviews(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { count?: unknown; avgRating?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < MIN_PLAUSIBLE_COUNT) {
    return jsonResponse(
      { error: `count must be an integer >= ${MIN_PLAUSIBLE_COUNT}` },
      400
    );
  }
  const avgRaw = Number(body.avgRating);
  const avgRating = Number.isFinite(avgRaw) && avgRaw > 0 && avgRaw <= 5 ? avgRaw : null;

  const data: ShopReviews = { count, avgRating, updatedAt: new Date().toISOString() };
  await env.PROFILE_CACHE.put(CACHE_KEY, JSON.stringify(data));
  await clog(env, `Shop reviews synced: ${count} reviews, avg ${avgRating ?? "?"}`);
  return jsonResponse(data);
}
