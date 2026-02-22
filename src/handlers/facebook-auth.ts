import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { clog, cerr } from "../services/logger";
import {
  generateAuthUrl,
  validateOAuthState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchPagesAndInstagramAccounts,
  storeConnection,
  getConnection,
  clearConnection,
} from "../services/facebook-oauth";

/**
 * Initiate Facebook OAuth — validate session, then redirect to FB login dialog
 */
export async function handleFacebookAuthInit(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const authUrl = await generateAuthUrl(url.origin, env);

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl },
  });
}

/**
 * Facebook OAuth callback — exchange code, fetch pages, store connection
 */
export async function handleFacebookCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    const errorDesc = url.searchParams.get("error_description") || errorParam;
    return htmlResponse(
      "Authorization Failed",
      `<p>Facebook denied the request: ${escapeHtml(errorDesc)}</p>
       <p><a href="/">Back to Dashboard</a></p>`,
      400
    );
  }

  if (!code || !state) {
    return htmlResponse(
      "Authorization Failed",
      `<p>Missing authorization code or state parameter.</p>
       <p><a href="/">Back to Dashboard</a></p>`,
      400
    );
  }

  // Validate CSRF state token
  const validState = await validateOAuthState(state, env);
  if (!validState) {
    return htmlResponse(
      "Authorization Failed",
      `<p>Invalid or expired state token. Please try again.</p>
       <p><a href="/">Back to Dashboard</a></p>`,
      400
    );
  }

  // Exchange code for short-lived token
  const redirectUri = `${url.origin}/auth/facebook/callback`;
  const shortTokenResult = await exchangeCodeForToken(code, redirectUri, env);
  if (!shortTokenResult || shortTokenResult.error || !shortTokenResult.access_token) {
    const detail = shortTokenResult?.error || "No response from Facebook";
    return htmlResponse(
      "Authorization Failed",
      `<p>Failed to exchange authorization code for token.</p>
       <pre style="background:#f5f5f5;padding:1rem;border-radius:4px;overflow:auto;font-size:0.8rem">${escapeHtml(detail)}</pre>
       <p><a href="/">Try Again</a></p>`,
      500
    );
  }

  // Exchange for long-lived token
  const longTokenResult = await exchangeForLongLivedToken(
    shortTokenResult.access_token,
    env
  );
  if (!longTokenResult) {
    return htmlResponse(
      "Authorization Failed",
      `<p>Failed to exchange for long-lived token.</p>
       <p><a href="/">Try Again</a></p>`,
      500
    );
  }

  const userTokenExpiresAt =
    Date.now() + longTokenResult.expires_in * 1000;

  // Fetch pages and find one with an Instagram Business Account
  const pages = await fetchPagesAndInstagramAccounts(
    longTokenResult.access_token,
    env
  );

  if (pages.length === 0) {
    // Debug: check what permissions were actually granted
    let permDebug = "";
    try {
      const permRes = await fetch(
        `https://graph.facebook.com/v21.0/me/permissions?access_token=${longTokenResult.access_token}`
      );
      permDebug = await permRes.text();
    } catch { /* ignore */ }

    return htmlResponse(
      "No Pages Found",
      `<p>No Facebook Pages were found for this account. Make sure you have admin access to a Page with an Instagram Business Account connected.</p>
       <details><summary>Debug: granted permissions</summary><pre style="background:#f5f5f5;padding:1rem;border-radius:4px;overflow:auto;font-size:0.8rem">${escapeHtml(permDebug)}</pre></details>
       <p><a href="/">Back to Dashboard</a></p>`,
      400
    );
  }

  const pageWithIG = pages.find((p) => p.instagram_business_account);
  if (!pageWithIG) {
    return htmlResponse(
      "No Instagram Account Found",
      `<p>None of your Facebook Pages have an Instagram Business Account connected. Found ${pages.length} page(s) but none with Instagram.</p>
       <p><a href="/">Back to Dashboard</a></p>`,
      400
    );
  }

  if (pages.length > 1) {
    await clog(
      env,
      `Multiple pages found (${pages.length}), using "${pageWithIG.name}" with IG @${pageWithIG.instagram_business_account!.username}`
    );
  }

  // Store connection
  await storeConnection(pageWithIG, userTokenExpiresAt, env);

  return htmlResponse(
    "Connected Successfully",
    `<p>Instagram account <strong>@${escapeHtml(pageWithIG.instagram_business_account!.username || "")}</strong> connected via Facebook Page <strong>${escapeHtml(pageWithIG.name)}</strong>.</p>
     <p>The bridge will now use this connection for messaging.</p>
     <p><a href="/">Back to Dashboard</a></p>`
  );
}

/**
 * Get current connection status
 */
export async function handleGetConnection(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const connection = await getConnection(env);
  if (!connection) {
    return jsonResponse({ connected: false });
  }

  return jsonResponse({
    connected: true,
    facebook_page_name: connection.facebook_page_name,
    instagram_username: connection.instagram_username,
    instagram_profile_picture_url: connection.instagram_profile_picture_url,
    connected_at: connection.connected_at,
    user_token_expires_at: connection.user_token_expires_at,
  });
}

/**
 * Disconnect — clear stored tokens
 */
export async function handleDisconnect(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  await clearConnection(env);
  return jsonResponse({ ok: true });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 500px; margin: 80px auto; padding: 0 1rem; color: #333; }
    h1 { font-size: 1.4rem; }
    a { color: #1877f2; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
