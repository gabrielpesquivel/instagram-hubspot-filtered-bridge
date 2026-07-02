import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { getDMState } from "../dm-state";
import { getValidGoogleToken } from "../services/google-oauth";
import { listUnreadThreads } from "../services/gmail-api";
import { listInstagramConversations } from "../services/instagram-conversations";

// Daily digest for the dashboard widget: one call aggregating what needs
// attention this morning. Every section is fail-soft (null = source
// unavailable) so one broken integration doesn't blank the whole card.

function aestDate(now = new Date()): string {
  return new Date(now.getTime() + 10 * 3600_000).toISOString().slice(0, 10);
}

// The digest fans out to Gmail + Instagram Graph + R2 — a couple of seconds
// cold. Cache the built payload briefly so page loads (home + dashboard, plus
// the 5-min widget refresh) don't each pay that.
const CACHE_KEY = "digest_cache";
const CACHE_TTL = 60; // seconds — KV minimum

export async function handleDigest(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const cached = await env.PROFILE_CACHE.get(CACHE_KEY);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json" } });
  }
  const date = aestDate();
  const state = getDMState(env);

  const [stats, pending, emailUnread, igUnread, dailyOrders, sheetsToday] = await Promise.all([
    state.getAllStats().catch(() => null),
    state.listPending().then((l) => l.length).catch(() => null),
    (async () => {
      const token = await getValidGoogleToken(env);
      if (!token) return null;
      return (await listUnreadThreads(token)).length;
    })().catch(() => null),
    (async () => {
      const all = await listInstagramConversations(env);
      if (all === null) return null;
      return all.filter((c) => c.unread).length;
    })().catch(() => null),
    (async () => {
      const head = await env.GANGSHEET_FILES.head(`orders-csv/${date}.csv`);
      if (!head) return null;
      const meta = head.customMetadata || {};
      return {
        orders: Number(meta.orders || 0),
        items: Number(meta.items || 0),
        pulledAt: meta.pulledAt || head.uploaded.toISOString(),
      };
    })().catch(() => null),
    env.GANGSHEET_FILES.list({ prefix: `gangsheets/${date}/` })
      .then((l) => l.objects.length)
      .catch(() => null),
  ]);

  const payload = JSON.stringify({
    date,
    // Message flow today (DO daily counters)
    stats: stats
      ? {
          forwarded: stats.forwarded.today,
          replied: stats.replied.today,
          pending: stats.pending.today,
          errors: stats.errors.today,
        }
      : null,
    pendingQueue: pending,   // messages awaiting approval right now
    emailUnread,             // unread Gmail threads (null = not connected)
    igUnread,                // unread IG threads (null = Graph unavailable)
    dailyOrders,             // this morning's Shopify pull (null = not run)
    sheetsUploaded: sheetsToday, // files stored for today in the File Calendar
  });
  await env.PROFILE_CACHE.put(CACHE_KEY, payload, { expirationTtl: CACHE_TTL });
  return new Response(payload, { headers: { "Content-Type": "application/json" } });
}
