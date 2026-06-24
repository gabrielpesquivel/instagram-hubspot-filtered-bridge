import type { Env } from "../types";
import { clog, cerr } from "./logger";

// Read-only Gmail access — the tool only reads unread support mail and suggests
// replies to copy/paste; it never sends. gmail.readonly also covers the profile
// lookup used to show which inbox is connected.
const OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const KV_KEY = "google_connection";
const STATE_PREFIX = "google_oauth_state:";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleConnection {
  email: string;
  refresh_token: string;
  access_token: string;
  access_token_expires_at: number;
  connected_at: string;
}

/** Build the Google consent URL with a CSRF state token. access_type=offline +
 *  prompt=consent so we always get a refresh token. */
export async function generateGoogleAuthUrl(origin: string, env: Env): Promise<string> {
  const state = crypto.randomUUID();
  await env.PROFILE_CACHE.put(`${STATE_PREFIX}${state}`, "valid", { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/auth/google/callback`,
    response_type: "code",
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function validateGoogleState(state: string, env: Env): Promise<boolean> {
  const key = `${STATE_PREFIX}${state}`;
  const value = await env.PROFILE_CACHE.get(key);
  if (value !== "valid") return false;
  await env.PROFILE_CACHE.delete(key);
  return true;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  env: Env
): Promise<{ access_token: string; refresh_token?: string; expires_in: number } | null> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      await cerr(env, "Google code exchange failed:", text);
      return null;
    }
    return JSON.parse(text);
  } catch (error) {
    await cerr(env, "Google code exchange error:", error);
    return null;
  }
}

async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<{ access_token: string; expires_in: number } | null> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      await cerr(env, "Google token refresh failed:", text);
      return null;
    }
    return JSON.parse(text);
  } catch (error) {
    await cerr(env, "Google token refresh error:", error);
    return null;
  }
}

/** Look up the connected mailbox address (Gmail profile — works with readonly). */
export async function fetchGmailAddress(accessToken: string): Promise<string | null> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { emailAddress?: string };
  return data.emailAddress || null;
}

export async function storeGoogleConnection(
  conn: GoogleConnection,
  env: Env
): Promise<void> {
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(conn));
  await clog(env, "Gmail connection stored:", { email: conn.email });
}

export async function getGoogleConnection(env: Env): Promise<GoogleConnection | null> {
  return ((await env.PROFILE_CACHE.get(KV_KEY, "json")) as GoogleConnection) || null;
}

export async function clearGoogleConnection(env: Env): Promise<void> {
  await env.PROFILE_CACHE.delete(KV_KEY);
  await clog(env, "Gmail connection cleared");
}

/** Return a valid access token, refreshing (and persisting) it if near expiry.
 *  Returns null if there is no connection or the refresh failed. */
export async function getValidGoogleToken(env: Env): Promise<string | null> {
  const conn = await getGoogleConnection(env);
  if (!conn) return null;

  if (Date.now() < conn.access_token_expires_at - 60_000) {
    return conn.access_token;
  }

  const refreshed = await refreshAccessToken(conn.refresh_token, env);
  if (!refreshed) return null;

  conn.access_token = refreshed.access_token;
  conn.access_token_expires_at = Date.now() + refreshed.expires_in * 1000;
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(conn));
  return conn.access_token;
}
