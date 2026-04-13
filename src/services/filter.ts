import type { Env, InstagramUserProfile, FilterResult } from "../types";
import { isBlocklisted } from "./blocklist";
import { clog } from "./logger";

const KV_KEY = "filter_settings";

export interface FilterSettings {
  min_followers: number;
  skip_verified: boolean;
}

/**
 * Get filter settings from KV, falling back to env/defaults
 */
export async function getFilterSettings(env: Env): Promise<FilterSettings> {
  const stored = await env.PROFILE_CACHE.get(KV_KEY, "json");
  if (stored) return stored as FilterSettings;
  return {
    min_followers: parseInt(env.FILTER_MIN_FOLLOWERS, 10) || 5000,
    skip_verified: true,
  };
}

/**
 * Save filter settings to KV
 */
export async function saveFilterSettings(
  settings: FilterSettings,
  env: Env
): Promise<void> {
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(settings));
}

/**
 * Determine if a message should be forwarded.
 * Returns shouldForward: true for messages that go to the pending queue.
 *
 * senderId is the raw webhook sender.id — used for blocklist checks
 * to avoid mismatches if the Graph API returns a different profile.id.
 */
export async function shouldForwardMessage(
  senderId: string,
  profile: InstagramUserProfile,
  env: Env
): Promise<FilterResult> {
  await clog(env, `Filter: senderId=${senderId}, profile.id=${profile.id}, username=${profile.username ?? "unknown"}`);

  // Check blocklist first (match by senderId or username for manual entries)
  if (await isBlocklisted(senderId, env, profile.username)) {
    return { shouldForward: false, reason: "blocklisted" };
  }

  const settings = await getFilterSettings(env);

  await clog(env, `Filter check for ${profile.username ?? profile.id}: is_verified=${profile.is_verified} (type: ${typeof profile.is_verified}), follower_count=${profile.follower_count}, skip_verified=${settings.skip_verified}, min_followers=${settings.min_followers}`);

  // Check if verified
  if (settings.skip_verified && profile.is_verified === true) {
    return { shouldForward: false, reason: "verified" };
  }

  // Check follower count
  if (
    typeof profile.follower_count === "number" &&
    profile.follower_count >= settings.min_followers
  ) {
    return { shouldForward: false, reason: "high_followers" };
  }

  // Goes to pending queue
  return { shouldForward: true, reason: "forward" };
}
