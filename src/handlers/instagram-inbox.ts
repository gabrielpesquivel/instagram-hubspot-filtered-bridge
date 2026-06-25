import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr } from "../services/logger";
import {
  listInstagramConversations,
  getInstagramThreadMessages,
} from "../services/instagram-conversations";
import { isBlocklisted } from "../services/blocklist";
import { getFilterSettings } from "../services/filter";
import { getUserProfile } from "../services/instagram-api";

// "Done" markers: senderId -> epoch ms when the agent cleared the thread. The
// pull hides a thread while its last activity is at/older than this — so it
// drops off the to-do list but pops back when the customer sends something new.
const DONE_KEY = "ig_done_map";
const DONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

async function getDoneMap(env: Env): Promise<Record<string, number>> {
  return ((await env.PROFILE_CACHE.get(DONE_KEY, "json")) as Record<string, number>) || {};
}

function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

/** Recent Instagram conversations (read + unread) for the inbox, newest first.
 *  Keeps the filter intent: blocked senders are hidden; verified / high-follower
 *  senders are flagged (not gated by the approval queue). Unread ones carry an
 *  `unread` flag for highlighting. */
export async function handleListInstagramUnread(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const all = await listInstagramConversations(env);
    const settings = await getFilterSettings(env);
    const doneMap = await getDoneMap(env);

    const threads = [];
    for (const c of all) {
      if (await isBlocklisted(c.senderId, env, c.username)) continue; // hide blocked
      const doneAt = doneMap[c.senderId];
      if (doneAt && parseTime(c.updatedTime) <= doneAt) continue; // cleared, no new activity
      // Flags only — profile is cached, so this is cheap on repeat polls.
      let isVerified = false;
      let followerCount: number | undefined;
      try {
        const profile = await getUserProfile(c.senderId, env);
        isVerified = profile.is_verified === true;
        followerCount = profile.follower_count;
      } catch { /* flags are best-effort */ }
      const isVip =
        isVerified || (followerCount != null && followerCount >= settings.min_followers);
      threads.push({ ...c, isVerified, followerCount, isVip });
    }
    return jsonResponse({ threads });
  } catch (error) {
    await cerr(env, "List IG unread error:", error);
    return jsonResponse({ error: "Failed to fetch Instagram DMs" }, 500);
  }
}

/** Mark an Instagram thread "done" — hide it from the to-do list until the
 *  customer messages again. */
export async function handleMarkInstagramDone(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as { senderId?: string };
  if (!body.senderId) return jsonResponse({ error: "Missing senderId" }, 400);

  const map = await getDoneMap(env);
  const now = Date.now();
  map[body.senderId] = now;
  // Bound the map — drop markers older than the TTL (those threads resurface).
  for (const k of Object.keys(map)) {
    if (map[k] < now - DONE_TTL_MS) delete map[k];
  }
  await env.PROFILE_CACHE.put(DONE_KEY, JSON.stringify(map));
  return jsonResponse({ ok: true });
}

/** Full message history for one pulled conversation (inbox thread view). */
export async function handleGetInstagramThread(
  request: Request,
  env: Env,
  conversationId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  try {
    const detail = await getInstagramThreadMessages(env, conversationId);
    if (!detail) return jsonResponse({ error: "Thread not found" }, 404);
    return jsonResponse(detail);
  } catch (error) {
    await cerr(env, "Get IG thread error:", error);
    return jsonResponse({ error: "Failed to load thread" }, 500);
  }
}
