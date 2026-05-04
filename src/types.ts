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

  // Gemini AI
  GEMINI_API_KEY: string;

  // Configuration
  FILTER_MIN_FOLLOWERS: string;
  CACHE_TTL_SECONDS: string;

  // Dashboard
  ASSETS: Fetcher;
  DASHBOARD_PASSWORD: string;
  META_ADMIN_PASSWORD: string;
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

// Conversation types
export interface ConversationMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  translation?: string;
  timestamp: string;
}

export interface Conversation {
  senderId: string;
  senderUsername: string;
  messages: ConversationMessage[];
  autoReply: boolean;
  language?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  senderId: string;
  senderUsername: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  unread: boolean;
  autoReply: boolean;
  language?: string;
  status: "active" | "archived";
}
