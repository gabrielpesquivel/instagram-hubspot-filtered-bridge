import type { Env, InstagramUserProfile, InstagramMessage, FilterResult } from "../types";

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
 * Determine if a message should be forwarded to HubSpot
 */
export async function shouldForwardMessage(
  profile: InstagramUserProfile,
  message: InstagramMessage,
  env: Env
): Promise<FilterResult> {
  // Check for media attachments first
  if (hasMediaAttachment(message)) {
    return { shouldForward: false, reason: "media_message" };
  }

  const settings = await getFilterSettings(env);

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

  // Forward to HubSpot
  return { shouldForward: true, reason: "forward" };
}

/**
 * Check if message contains media (image, video, audio)
 */
function hasMediaAttachment(message: InstagramMessage): boolean {
  if (!message.attachments || message.attachments.length === 0) {
    return false;
  }

  const mediaTypes = ["image", "video", "audio"];
  return message.attachments.some((att) => mediaTypes.includes(att.type));
}
