import type { Env } from "../types";
import { getAllStats, getRecentLogs, incrementStat, appendLog } from "../services/stats";
import { getConsoleLogs } from "../services/logger";
import { getConnection } from "../services/facebook-oauth";
import { getCookie, isAuthenticated, jsonResponse } from "../utils/auth";
import { getPendingMessages, removePendingMessage, removePendingBySender } from "../services/pending";
import { getBlocklist, addToBlocklist, removeFromBlocklist } from "../services/blocklist";
import { addToAllowlist } from "../services/allowlist";
import { forwardMessage } from "../services/hubspot-api";

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const username = body.username?.trim().toLowerCase() ?? "admin";
  const validCredentials =
    (username === "admin" && body.password === env.DASHBOARD_PASSWORD) ||
    (username === "metaadmin" && body.password === "meta2026");

  if (!body.password || !validCredentials) {
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

export async function handleGetPending(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const messages = await getPendingMessages(env);
  return jsonResponse(messages);
}

export async function handleApprovePending(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.id) {
    return jsonResponse({ error: "Missing id" }, 400);
  }

  const removed = await removePendingMessage(body.id, env);
  if (!removed) {
    return jsonResponse({ error: "Message not found" }, 404);
  }

  // Add sender to allowlist so future messages auto-forward
  await addToAllowlist({
    senderId: removed.senderId,
    username: removed.senderUsername,
  }, env);

  // Collect this message + all other pending messages from same sender
  const otherPending = await removePendingBySender(removed.senderId, env);
  const allMessages = [removed, ...otherPending];

  const senderLabel = removed.senderUsername.startsWith("@")
    ? removed.senderUsername
    : `@${removed.senderUsername}`;
  const conversationId = `ig_${removed.senderId}`;
  let errorCount = 0;

  for (const msg of allMessages) {
    const success = await forwardMessage(
      msg.senderId,
      msg.senderUsername,
      conversationId,
      msg.messageText,
      env
    );
    if (success) {
      await incrementStat("forwarded", env);
      await appendLog({
        type: "forwarded",
        message: `${senderLabel} — "${msg.messageText.slice(0, 80)}"`,
      }, env);
    } else {
      errorCount++;
      await incrementStat("errors", env);
      await appendLog({
        type: "error",
        message: `Failed to forward approved message from ${senderLabel}`,
      }, env);
    }
  }

  if (errorCount > 0) {
    return jsonResponse({ error: `Failed to forward ${errorCount}/${allMessages.length} messages` }, 500);
  }
  return jsonResponse({ ok: true, forwarded: allMessages.length });
}

export async function handleRejectPending(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.id) {
    return jsonResponse({ error: "Missing id" }, 400);
  }

  const removed = await removePendingMessage(body.id, env);
  if (!removed) {
    return jsonResponse({ error: "Message not found" }, 404);
  }

  // Remove all other pending messages from same sender
  const otherRemoved = await removePendingBySender(removed.senderId, env);

  await addToBlocklist({
    senderId: removed.senderId,
    username: removed.senderUsername,
  }, env);

  return jsonResponse({ ok: true, removed: 1 + otherRemoved.length });
}

export async function handleGetBlocklist(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const list = await getBlocklist(env);
  return jsonResponse(list);
}

export async function handleUnblock(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { senderId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.senderId) {
    return jsonResponse({ error: "Missing senderId" }, 400);
  }

  await removeFromBlocklist(body.senderId, env);
  return jsonResponse({ ok: true });
}
