import type { Env, InstagramUserProfile, CachedProfile } from "../types";
import { cerr, clog } from "./logger";
import { getPageAccessToken, getInstagramPageId, getFacebookPageId } from "./facebook-oauth";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/**
 * Fetch Instagram user profile with caching
 */
export async function getUserProfile(
  userId: string,
  env: Env
): Promise<InstagramUserProfile> {
  // Check cache first
  const cached = await getCachedProfile(userId, env);
  if (cached) {
    return cached;
  }

  // Fetch from API
  const profile = await fetchProfileFromApi(userId, env);

  // Cache the result
  await cacheProfile(userId, profile, env);

  return profile;
}

async function getCachedProfile(
  userId: string,
  env: Env
): Promise<InstagramUserProfile | null> {
  const cacheKey = `ig_profile:${userId}`;
  const cached = await env.PROFILE_CACHE.get(cacheKey, "json");

  if (!cached) {
    return null;
  }

  const { profile, cached_at } = cached as CachedProfile;
  const ttl = parseInt(env.CACHE_TTL_SECONDS, 10) * 1000;

  // Check if cache is still valid
  if (Date.now() - cached_at > ttl) {
    return null;
  }

  return profile;
}

async function cacheProfile(
  userId: string,
  profile: InstagramUserProfile,
  env: Env
): Promise<void> {
  const cacheKey = `ig_profile:${userId}`;
  const ttlSeconds = parseInt(env.CACHE_TTL_SECONDS, 10);

  const cached: CachedProfile = {
    profile,
    cached_at: Date.now(),
  };

  await env.PROFILE_CACHE.put(cacheKey, JSON.stringify(cached), {
    expirationTtl: ttlSeconds,
  });
}

async function fetchProfileFromApi(
  userId: string,
  env: Env
): Promise<InstagramUserProfile> {
  const accessToken = await getPageAccessToken(env);

  // Try Instagram Business/Creator profile fields first
  const fields = "name,username,follower_count,is_verified_user";
  const url = `${GRAPH_API_BASE}/${userId}?fields=${fields}&access_token=${accessToken}`;

  try {
    const response = await fetch(url);

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;

      await clog(env, `Graph API profile response for ${userId}:`, {
        fields_returned: Object.keys(data),
        has_is_verified_user: "is_verified_user" in data,
        is_verified_user_value: data.is_verified_user,
        has_follower_count: "follower_count" in data,
        follower_count_value: data.follower_count,
      });

      if (data.username || data.name) {
        const isVerified = (data.is_verified_user ?? data.is_verified) as boolean | undefined;

        if (isVerified === undefined) {
          await cerr(env, `WARNING: is_verified_user not returned by Graph API for ${userId}. Verified filter will not work for this user. Check App Review / Advanced Access for instagram_manage_messages.`);
        }

        return {
          id: data.id as string,
          username: (data.username ?? data.name) as string | undefined,
          follower_count: data.follower_count as number | undefined,
          is_verified: isVerified,
        };
      }

      await cerr(env, `Graph API returned OK but no username/name for ${userId}. Response keys: ${Object.keys(data).join(", ")}`);
    } else {
      const errorBody = await response.text();
      await cerr(env, `Graph API profile fetch failed for ${userId}: HTTP ${response.status}`, errorBody);
    }
  } catch (error) {
    await cerr(env, `Error fetching profile for ${userId}:`, error);
  }

  // Fallback: try to get name from the user node (works for personal IG accounts)
  await clog(env, `Falling back to name-only fetch for ${userId} (is_verified and follower_count will be unavailable)`);
  try {
    const fallbackUrl = `${GRAPH_API_BASE}/${userId}?fields=name&access_token=${accessToken}`;
    const fallbackRes = await fetch(fallbackUrl);
    if (fallbackRes.ok) {
      const data = (await fallbackRes.json()) as Record<string, unknown>;
      if (data.name) {
        return {
          id: data.id as string,
          username: data.name as string,
        };
      }
    } else {
      const errorBody = await fallbackRes.text();
      await cerr(env, `Fallback profile fetch also failed for ${userId}: HTTP ${fallbackRes.status}`, errorBody);
    }
  } catch (error) {
    await cerr(env, `Fallback profile fetch error for ${userId}:`, error);
  }

  await cerr(env, `All profile fetch attempts failed for ${userId}, returning bare ID`);
  return { id: userId };
}

/**
 * Send a message via Instagram
 */
export async function sendMessage(
  recipientId: string,
  text: string,
  env: Env,
  options?: { humanAgent?: boolean }
): Promise<boolean> {
  const [pageId, accessToken] = await Promise.all([
    getFacebookPageId(env),
    getPageAccessToken(env),
  ]);
  const url = `${GRAPH_API_BASE}/${pageId}/messages`;

  const body: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };

  if (options?.humanAgent) {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "HUMAN_AGENT";
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      await cerr(env, `Failed to send message: ${response.status}`, errorBody);
      return false;
    }

    return true;
  } catch (error) {
    await cerr(env, "Error sending message:", error);
    return false;
  }
}
