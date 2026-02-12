import type { Env, InstagramUserProfile, InstagramMessage, FilterResult } from "../types";

/**
 * Determine if a message should be forwarded to HubSpot
 */
export function shouldForwardMessage(
  profile: InstagramUserProfile,
  message: InstagramMessage,
  env: Env
): FilterResult {
  // Check for media attachments first
  if (hasMediaAttachment(message)) {
    return { shouldForward: false, reason: "media_message" };
  }

  // Check if verified
  if (profile.is_verified === true) {
    return { shouldForward: false, reason: "verified" };
  }

  // Check follower count
  const minFollowers = parseInt(env.FILTER_MIN_FOLLOWERS, 10);
  if (
    typeof profile.follower_count === "number" &&
    profile.follower_count >= minFollowers
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
