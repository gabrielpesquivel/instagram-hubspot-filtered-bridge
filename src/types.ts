// Environment bindings for Cloudflare Worker
export interface Env {
  // KV namespace
  PROFILE_CACHE: KVNamespace;

  // Meta/Instagram secrets
  META_APP_ID: string;
  META_APP_SECRET: string;
  INSTAGRAM_APP_SECRET: string;
  META_PAGE_ACCESS_TOKEN: string;
  INSTAGRAM_PAGE_ID: string;
  WEBHOOK_VERIFY_TOKEN: string;

  // HubSpot OAuth (Public App)
  HUBSPOT_CLIENT_ID: string;
  HUBSPOT_CLIENT_SECRET: string;
  HUBSPOT_CUSTOM_CHANNEL_ID: string;

  // Configuration
  FILTER_MIN_FOLLOWERS: string;
  CACHE_TTL_SECONDS: string;

  // Dashboard
  ASSETS: Fetcher;
  DASHBOARD_PASSWORD: string;
}

// Instagram Webhook Payload
export interface InstagramWebhookPayload {
  object: "instagram";
  entry: InstagramEntry[];
}

export interface InstagramEntry {
  id: string;
  time: number;
  messaging?: InstagramMessaging[];
}

export interface InstagramMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: InstagramMessage;
}

export interface InstagramMessage {
  mid: string;
  text?: string;
  is_echo?: boolean;
  attachments?: InstagramAttachment[];
}

export interface InstagramAttachment {
  type: "image" | "video" | "audio" | "file";
  payload: {
    url: string;
  };
}

// Instagram User Profile (from Graph API)
export interface InstagramUserProfile {
  id: string;
  username?: string;
  follower_count?: number;
  is_verified?: boolean;
}

// Cached profile with metadata
export interface CachedProfile {
  profile: InstagramUserProfile;
  cached_at: number;
}

// Filter decision
export interface FilterResult {
  shouldForward: boolean;
  reason: "verified" | "high_followers" | "blocklisted" | "forward";
}

// HubSpot Custom Channel Message
export interface HubSpotIncomingMessage {
  messageDirection: "INCOMING";
  text: string;
  richText?: string;
  integrationThreadId: string;
  channelAccountId: string;
  senders: HubSpotSender[];
}

export interface HubSpotSender {
  deliveryIdentifier: {
    type: "CHANNEL_SPECIFIC_OPAQUE_ID";
    value: string;
  };
  name: string;
}
