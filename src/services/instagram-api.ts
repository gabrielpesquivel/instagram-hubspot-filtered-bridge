import type { Env, InstagramUserProfile, CachedProfile } from "../types";
import { cerr } from "./logger";

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
  const fields = "name,username,follower_count,is_verified_user";
  const url = `${GRAPH_API_BASE}/${userId}?fields=${fields}&access_token=${env.META_PAGE_ACCESS_TOKEN}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorBody = await response.text();
      await cerr(env, `Failed to fetch profile for ${userId}: ${response.status}`, errorBody);
      return { id: userId };
    }

    const data = (await response.json()) as Record<string, unknown>;

    return {
      id: data.id as string,
      username: (data.username ?? data.name) as string | undefined,
      follower_count: data.follower_count as number | undefined,
      is_verified: (data.is_verified_user ?? data.is_verified) as boolean | undefined,
    };
  } catch (error) {
    await cerr(env, `Error fetching profile for ${userId}:`, error);
    return { id: userId };
  }
}

/**
 * Send a message via Instagram
 */
export async function sendMessage(
  recipientId: string,
  text: string,
  env: Env
): Promise<boolean> {
  const url = `${GRAPH_API_BASE}/${env.INSTAGRAM_PAGE_ID}/messages`;

  const body = {
    recipient: { id: recipientId },
    message: { text },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}`,
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
