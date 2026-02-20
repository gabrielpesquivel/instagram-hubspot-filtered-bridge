import type { Env, HubSpotIncomingMessage } from "../types";
import { clog, cerr } from "./logger";

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const OAUTH_TOKEN_URL = `${HUBSPOT_API_BASE}/oauth/v1/token`;
const KV_TOKEN_KEY = "hubspot_oauth_tokens";
// Refresh 5 minutes before actual expiry to avoid race conditions
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
}

/**
 * Exchange an authorization code for access + refresh tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  env: Env
): Promise<StoredTokens | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
  });

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      await cerr(env, `HubSpot token exchange failed: ${response.status}`, errorBody);
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: StoredTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    await env.PROFILE_CACHE.put(KV_TOKEN_KEY, JSON.stringify(tokens));
    await clog(env, "HubSpot OAuth tokens stored successfully");
    return tokens;
  } catch (error) {
    await cerr(env, "Error exchanging HubSpot auth code:", error);
    return null;
  }
}

/**
 * Get a valid access token, refreshing if necessary
 */
async function getAccessToken(env: Env): Promise<string | null> {
  const stored = await env.PROFILE_CACHE.get(KV_TOKEN_KEY);

  if (!stored) {
    await cerr(env, "No HubSpot OAuth tokens found. Run /auth/hubspot to authorize.");
    return null;
  }

  const tokens: StoredTokens = JSON.parse(stored);

  // Token still valid (with buffer)
  if (Date.now() < tokens.expires_at - TOKEN_REFRESH_BUFFER_MS) {
    return tokens.access_token;
  }

  // Token expired or about to expire — refresh it
  return refreshAccessToken(tokens.refresh_token, env);
}

/**
 * Use refresh token to get a new access token
 */
async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
  });

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      await cerr(env, `HubSpot token refresh failed: ${response.status}`, errorBody);
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: StoredTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    await env.PROFILE_CACHE.put(KV_TOKEN_KEY, JSON.stringify(tokens));
    await clog(env, "HubSpot OAuth tokens refreshed successfully");
    return tokens.access_token;
  } catch (error) {
    await cerr(env, "Error refreshing HubSpot token:", error);
    return null;
  }
}

/**
 * Finalize channel account connection during HubSpot's connect flow.
 * PATCHes the staging token with our Instagram account details.
 */
export async function finalizeChannelConnection(
  channelId: string,
  accountToken: string,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken(env);

  if (!accessToken) {
    return { success: false, error: "No valid HubSpot access token. Re-authorize at /auth/hubspot" };
  }

  const url = `${HUBSPOT_API_BASE}/conversations/v3/custom-channels/${channelId}/channel-account-staging-tokens/${accountToken}`;

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        accountName: "Instagram DM Bridge",
        deliveryIdentifier: {
          type: "CHANNEL_SPECIFIC_OPAQUE_ID",
          value: env.INSTAGRAM_PAGE_ID,
        },
      }),
    });

    if (!response.ok && response.status !== 409) {
      const errorBody = await response.text();
      return { success: false, error: `HubSpot API ${response.status}: ${errorBody}` };
    }

    // 409 = already connected, treat as success
    return { success: true };
  } catch (error) {
    return { success: false, error: `Exception: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const KV_CHANNEL_ACCOUNT_ID_KEY = "hubspot_channel_account_id";

/**
 * Fetch the HubSpot channel account ID (assigned by HubSpot during connection).
 * Cached in KV after first lookup.
 */
async function getChannelAccountId(env: Env): Promise<string | null> {
  const cached = await env.PROFILE_CACHE.get(KV_CHANNEL_ACCOUNT_ID_KEY);
  if (cached) return cached;

  const accessToken = await getAccessToken(env);
  if (!accessToken) return null;

  try {
    const url = `${HUBSPOT_API_BASE}/conversations/v3/custom-channels/${env.HUBSPOT_CUSTOM_CHANNEL_ID}/channel-accounts`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      await cerr(env, `Failed to fetch channel accounts: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      results: Array<{ id: string; deliveryIdentifier?: { value: string } }>;
    };

    if (data.results.length === 0) {
      await cerr(env, "No channel accounts found");
      return null;
    }

    const accountId = data.results[0].id;
    await env.PROFILE_CACHE.put(KV_CHANNEL_ACCOUNT_ID_KEY, accountId);
    await clog(env, "Cached HubSpot channel account ID:", accountId);
    return accountId;
  } catch (error) {
    await cerr(env, "Error fetching channel accounts:", error);
    return null;
  }
}

/**
 * Forward a message to HubSpot Conversations
 */
export async function forwardMessage(
  senderId: string,
  senderUsername: string,
  conversationId: string,
  text: string,
  env: Env
): Promise<boolean> {
  const accessToken = await getAccessToken(env);

  if (!accessToken) {
    await cerr(env, "Cannot forward message: no valid HubSpot access token");
    return false;
  }

  const channelAccountId = await getChannelAccountId(env);

  if (!channelAccountId) {
    await cerr(env, "Cannot forward message: no channel account ID");
    return false;
  }

  const url = `${HUBSPOT_API_BASE}/conversations/v3/custom-channels/${env.HUBSPOT_CUSTOM_CHANNEL_ID}/messages`;

  const message: HubSpotIncomingMessage = {
    messageDirection: "INCOMING",
    text: text,
    richText: `<p>${escapeHtml(text)}</p>`,
    integrationThreadId: conversationId,
    channelAccountId: channelAccountId,
    senders: [
      {
        deliveryIdentifier: {
          type: "CHANNEL_SPECIFIC_OPAQUE_ID",
          value: senderId,
        },
        name: senderUsername ? `@${senderUsername}` : senderId,
      },
    ],
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      await cerr(env, `Failed to forward message to HubSpot: ${response.status}`, errorBody);
      return false;
    }

    return true;
  } catch (error) {
    await cerr(env, "Error forwarding message to HubSpot:", error);
    return false;
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
