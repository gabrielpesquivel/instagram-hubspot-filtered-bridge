import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr } from "../services/logger";
import {
  getPageAccessToken,
  getFacebookPageId,
  getConnection,
} from "../services/facebook-oauth";
import {
  getFilterSettings,
  saveFilterSettings,
  type FilterSettings,
} from "../services/filter";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/**
 * Send a test Instagram message
 */
export async function handleTestMessage(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { recipient_id?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.recipient_id || !body.message) {
    return jsonResponse(
      { error: "recipient_id and message are required" },
      400
    );
  }

  const [pageId, accessToken] = await Promise.all([
    getFacebookPageId(env),
    getPageAccessToken(env),
  ]);

  const url = `${GRAPH_API_BASE}/${pageId}/messages`;
  const payload = {
    recipient: { id: body.recipient_id },
    message: { text: body.message },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      return jsonResponse({ success: false, error: data }, res.status);
    }

    return jsonResponse({ success: true, data });
  } catch (error) {
    await cerr(env, "Test message error:", error);
    return jsonResponse(
      { success: false, error: "Failed to send message" },
      500
    );
  }
}

/**
 * Get webhook subscription status for the connected page
 */
export async function handleGetWebhooks(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const connection = await getConnection(env);
  if (!connection) {
    return jsonResponse({
      subscribed: false,
      message: "No Meta connection. Connect via Facebook Login first.",
    });
  }

  const url = `${GRAPH_API_BASE}/${connection.facebook_page_id}/subscribed_apps?access_token=${connection.page_access_token}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      return jsonResponse({ subscribed: false, error: data }, res.status);
    }

    return jsonResponse({ subscribed: true, data });
  } catch (error) {
    await cerr(env, "Get webhooks error:", error);
    return jsonResponse(
      { subscribed: false, error: "Failed to fetch webhook status" },
      500
    );
  }
}

/**
 * Subscribe the connected page to webhook fields
 */
export async function handleSubscribeWebhooks(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const connection = await getConnection(env);
  if (!connection) {
    return jsonResponse(
      { error: "No Meta connection. Connect via Facebook Login first." },
      400
    );
  }

  const params = new URLSearchParams({
    subscribed_fields: "messages",
    access_token: connection.page_access_token,
  });

  const url = `${GRAPH_API_BASE}/${connection.facebook_page_id}/subscribed_apps?${params.toString()}`;

  try {
    const res = await fetch(url, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      return jsonResponse({ success: false, error: data }, res.status);
    }

    return jsonResponse({ success: true, data });
  } catch (error) {
    await cerr(env, "Subscribe webhooks error:", error);
    return jsonResponse(
      { success: false, error: "Failed to subscribe to webhooks" },
      500
    );
  }
}

/**
 * Get current filter settings
 */
export async function handleGetFilterSettings(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const settings = await getFilterSettings(env);
  return jsonResponse(settings);
}

/**
 * Update filter settings
 */
export async function handleUpdateFilterSettings(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: Partial<FilterSettings>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const current = await getFilterSettings(env);
  const updated: FilterSettings = {
    min_followers:
      typeof body.min_followers === "number"
        ? body.min_followers
        : current.min_followers,
    skip_verified:
      typeof body.skip_verified === "boolean"
        ? body.skip_verified
        : current.skip_verified,
  };

  await saveFilterSettings(updated, env);
  return jsonResponse(updated);
}
