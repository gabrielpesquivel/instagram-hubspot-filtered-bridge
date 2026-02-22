import type { Env } from "../types";
import { getAllStats, getRecentLogs } from "../services/stats";
import { getConsoleLogs } from "../services/logger";
import { getConnection } from "../services/facebook-oauth";
import { getCookie, isAuthenticated, jsonResponse } from "../utils/auth";

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.password || body.password !== env.DASHBOARD_PASSWORD) {
    return jsonResponse({ error: "Invalid password" }, 401);
  }

  const token = crypto.randomUUID();
  await env.PROFILE_CACHE.put(`session:${token}`, "valid", {
    expirationTtl: SESSION_TTL,
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`,
    },
  });
}

export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const token = getCookie(request, "session");
  if (token) {
    await env.PROFILE_CACHE.delete(`session:${token}`);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":
        "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    },
  });
}

export async function handleStats(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const stats = await getAllStats(env);
  return jsonResponse(stats);
}

export async function handleLogs(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const logs = await getRecentLogs(env);
  return jsonResponse(logs);
}

export async function handleConsoleLogs(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const logs = await getConsoleLogs(env);
  return jsonResponse(logs);
}

export async function handleHealth(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const [oauthTokens, channelId, metaConnection] = await Promise.all([
    env.PROFILE_CACHE.get("hubspot_oauth_tokens"),
    Promise.resolve(env.HUBSPOT_CUSTOM_CHANNEL_ID),
    getConnection(env),
  ]);

  const hasToken = !!oauthTokens;
  const pipelineActive = hasToken && !!channelId;

  return jsonResponse({
    pipeline_active: pipelineActive,
    has_hubspot_token: hasToken,
    has_channel_id: !!channelId,
    has_meta_connection: !!metaConnection,
  });
}
