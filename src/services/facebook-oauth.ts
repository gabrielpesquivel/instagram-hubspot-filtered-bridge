import type { Env } from "../types";
import { clog, cerr } from "./logger";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
const KV_KEY = "meta_connection";
const STATE_PREFIX = "oauth_state:";

const OAUTH_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_messaging",
  "business_management",
  "instagram_basic",
  "instagram_manage_messages",
].join(",");

export interface MetaConnection {
  facebook_page_id: string;
  facebook_page_name: string;
  page_access_token: string;
  instagram_business_account_id: string;
  instagram_username: string;
  instagram_profile_picture_url: string;
  connected_at: string;
  user_token_expires_at: number;
}

/**
 * Generate Facebook OAuth URL with CSRF state token
 */
export async function generateAuthUrl(
  origin: string,
  env: Env
): Promise<string> {
  const state = crypto.randomUUID();
  await env.PROFILE_CACHE.put(`${STATE_PREFIX}${state}`, "valid", {
    expirationTtl: 600, // 10 minutes
  });

  const redirectUri = `${origin}/auth/facebook/callback`;
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    response_type: "code",
    state,
  });

  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

/**
 * Validate and consume OAuth state token (one-time use)
 */
export async function validateOAuthState(
  state: string,
  env: Env
): Promise<boolean> {
  const key = `${STATE_PREFIX}${state}`;
  const value = await env.PROFILE_CACHE.get(key);
  if (value !== "valid") return false;
  await env.PROFILE_CACHE.delete(key);
  return true;
}

/**
 * Exchange authorization code for short-lived user token
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  env: Env
): Promise<{ access_token: string; expires_in?: number; error?: string } | null> {
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });

  const url = `${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`;

  try {
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok) {
      await cerr(env, "Facebook code exchange failed:", body);
      return { access_token: "", error: body };
    }
    const data = JSON.parse(body) as { access_token: string; expires_in?: number };
    return data;
  } catch (error) {
    await cerr(env, "Facebook code exchange error:", error);
    return { access_token: "", error: String(error) };
  }
}

/**
 * Exchange short-lived token for long-lived token (~60 days)
 */
export async function exchangeForLongLivedToken(
  shortToken: string,
  env: Env
): Promise<{ access_token: string; expires_in: number } | null> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: shortToken,
  });

  const url = `${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      await cerr(env, "Long-lived token exchange failed:", err);
      return null;
    }
    return (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
  } catch (error) {
    await cerr(env, "Long-lived token exchange error:", error);
    return null;
  }
}

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    profile_picture_url?: string;
  };
}

/**
 * Fetch Facebook Pages and their linked Instagram Business Accounts
 */
export async function fetchPagesAndInstagramAccounts(
  userToken: string,
  env: Env
): Promise<FacebookPage[]> {
  const fields =
    "id,name,access_token,instagram_business_account{id,username,profile_picture_url}";

  // Try /me/accounts first (personal pages)
  const url = `${GRAPH_API_BASE}/me/accounts?fields=${fields}&access_token=${userToken}`;
  try {
    const res = await fetch(url);
    const body = await res.text();
    await clog(env, "Fetch /me/accounts response:", body);
    if (res.ok) {
      const data = JSON.parse(body) as { data: FacebookPage[] };
      if (data.data && data.data.length > 0) {
        return data.data;
      }
    }
  } catch (error) {
    await cerr(env, "Error fetching /me/accounts:", error);
  }

  // Fallback: try via Business Manager
  try {
    const bizRes = await fetch(
      `${GRAPH_API_BASE}/me/businesses?access_token=${userToken}`
    );
    const bizBody = await bizRes.text();
    await clog(env, "Fetch /me/businesses response:", bizBody);
    if (bizRes.ok) {
      const bizData = JSON.parse(bizBody) as {
        data: Array<{ id: string; name: string }>;
      };
      for (const biz of bizData.data || []) {
        const pagesRes = await fetch(
          `${GRAPH_API_BASE}/${biz.id}/owned_pages?fields=${fields}&access_token=${userToken}`
        );
        const pagesBody = await pagesRes.text();
        await clog(env, `Fetch ${biz.name} owned_pages:`, pagesBody);
        if (pagesRes.ok) {
          const pagesData = JSON.parse(pagesBody) as { data: FacebookPage[] };
          if (pagesData.data && pagesData.data.length > 0) {
            return pagesData.data;
          }
        }
      }
    }
  } catch (error) {
    await cerr(env, "Error fetching business pages:", error);
  }

  return [];
}

/**
 * Store the Meta connection in KV
 */
export async function storeConnection(
  page: FacebookPage,
  userTokenExpiresAt: number,
  env: Env
): Promise<void> {
  const connection: MetaConnection = {
    facebook_page_id: page.id,
    facebook_page_name: page.name,
    page_access_token: page.access_token,
    instagram_business_account_id: page.instagram_business_account!.id,
    instagram_username: page.instagram_business_account!.username || "",
    instagram_profile_picture_url:
      page.instagram_business_account!.profile_picture_url || "",
    connected_at: new Date().toISOString(),
    user_token_expires_at: userTokenExpiresAt,
  };

  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(connection));
  await clog(env, "Meta connection stored:", {
    page: page.name,
    ig: page.instagram_business_account!.username,
  });
}

/**
 * Get the stored Meta connection from KV
 */
export async function getConnection(
  env: Env
): Promise<MetaConnection | null> {
  const data = await env.PROFILE_CACHE.get(KV_KEY, "json");
  return (data as MetaConnection) || null;
}

/**
 * Clear the stored Meta connection from KV
 */
export async function clearConnection(env: Env): Promise<void> {
  await env.PROFILE_CACHE.delete(KV_KEY);
  await clog(env, "Meta connection cleared");
}

/**
 * Get page access token: KV-first, env var fallback
 */
export async function getPageAccessToken(env: Env): Promise<string> {
  const connection = await getConnection(env);
  if (connection) return connection.page_access_token;
  return env.META_PAGE_ACCESS_TOKEN;
}

/**
 * Get Instagram Business Account ID: KV-first, env var fallback
 */
export async function getInstagramPageId(env: Env): Promise<string> {
  const connection = await getConnection(env);
  if (connection) return connection.instagram_business_account_id;
  return env.INSTAGRAM_PAGE_ID;
}

/**
 * Get Facebook Page ID for sending messages: KV-first, env var fallback
 * The Instagram Send API uses the Facebook Page ID, not the IG Business Account ID.
 */
export async function getFacebookPageId(env: Env): Promise<string> {
  const connection = await getConnection(env);
  if (connection) return connection.facebook_page_id;
  return env.INSTAGRAM_PAGE_ID;
}
