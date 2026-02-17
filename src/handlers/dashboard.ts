import type { Env } from "../types";
import { getAllStats } from "../services/stats";

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = getCookie(request, "session");
  if (!token) return false;
  const session = await env.PROFILE_CACHE.get(`session:${token}`);
  return session === "valid";
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

export async function handleHealth(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const [oauthTokens, channelId] = await Promise.all([
    env.PROFILE_CACHE.get("hubspot_oauth_tokens"),
    Promise.resolve(env.HUBSPOT_CUSTOM_CHANNEL_ID),
  ]);

  const hasToken = !!oauthTokens;
  const pipelineActive = hasToken && !!channelId;

  return jsonResponse({
    pipeline_active: pipelineActive,
    has_hubspot_token: hasToken,
    has_channel_id: !!channelId,
  });
}
