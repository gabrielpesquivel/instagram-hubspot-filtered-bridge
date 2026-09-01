import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { getDMState } from "../dm-state";
import { getValidGoogleToken } from "../services/google-oauth";
import { listUnreadThreads } from "../services/gmail-api";
import { listInstagramConversations } from "../services/instagram-conversations";
import { getDoneMap } from "./instagram-inbox";
import { isBlocklisted } from "../services/blocklist";
import { getStockAlerts } from "./stocktake";

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
  // Counts mirror the support inbox exactly (same 48h activity window and
  // done/blocklist filters, see dashboard/src/Inbox.tsx) so the digest never
  // disagrees with what the operator sees when they click through.
  const cutoff = Date.now() - 48 * 3600_000;

  const [emailUnread, igUnread, dailyOrders, sheetsToday, stockAlerts] = await Promise.all([
    (async () => {
      const token = await getValidGoogleToken(env);
      if (!token) return null;
      const threads = await listUnreadThreads(token);
      return threads.filter((t) => Date.parse(t.date) >= cutoff).length;
    })().catch(() => null),
    (async () => {
      // Store conversations + live Graph threads, deduped by sender — the
      // Graph unread_count alone is unreliable (resets on API reads).
      const [convos, live] = await Promise.all([
        state.listConversations().catch(() => []),
        listInstagramConversations(env),
      ]);
      if (live === null && !convos.length) return null;
      const storeIds = new Set(convos.map((c) => c.senderId));
      let count = convos.filter((c) => Date.parse(c.lastMessageAt) >= cutoff).length;
      if (live) {
        const doneMap = await getDoneMap(env);
        for (const c of live) {
          if (storeIds.has(c.senderId)) continue;
          const at = Date.parse(c.updatedTime) || 0;
          if (at < cutoff) continue;
          const doneAt = doneMap[c.senderId];
          if (doneAt && at <= doneAt) continue;
          if (await isBlocklisted(c.senderId, env, c.username)) continue;
          count++;
        }
      }
      return count;
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
    getStockAlerts(env),
  ]);

  const payload = JSON.stringify({
    date,
    emailUnread,             // unread Gmail threads, last 48h (null = not connected)
    igUnread,                // open IG threads the inbox shows (null = no data)
    dailyOrders,             // this morning's Shopify pull (null = not run)
    sheetsUploaded: sheetsToday, // files stored for today — >0 means gangsheet done
    stockAlerts,             // consumables needing an order (null = unavailable)
  });
  await env.PROFILE_CACHE.put(CACHE_KEY, payload, { expirationTtl: CACHE_TTL });
  return new Response(payload, { headers: { "Content-Type": "application/json" } });
}
