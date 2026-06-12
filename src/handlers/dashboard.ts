import type { Env } from "../types";
import { getAllStats, getRecentLogs, incrementStat, appendLog } from "../services/stats";
import { getConsoleLogs } from "../services/logger";
import { getConnection } from "../services/facebook-oauth";
import { getCookie, isAuthenticated, jsonResponse } from "../utils/auth";
import { getPendingMessages, removePendingMessage, removePendingBySender, clearPendingMessages } from "../services/pending";
import { sendMessage } from "../services/instagram-api";
import { getBlocklist, addToBlocklist, removeFromBlocklist } from "../services/blocklist";
import { addMessageToConversation, setConversationLanguage } from "../services/conversations";
import { translateMessage } from "../services/gemini-api";

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

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

  // Per-IP rate limit: 10 failed attempts per 15 minutes
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `login_fail:${ip}`;
  const attempts = parseInt((await env.PROFILE_CACHE.get(rateKey)) || "0", 10);
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    return jsonResponse({ error: "Too many attempts — try again later" }, 429);
  }

  const username = body.username?.trim().toLowerCase() ?? "admin";
  const validCredentials =
    (username === "admin" && body.password === env.DASHBOARD_PASSWORD) ||
    (username === "metaadmin" && !!env.META_ADMIN_PASSWORD && body.password === env.META_ADMIN_PASSWORD);

  if (!body.password || !validCredentials) {
    await env.PROFILE_CACHE.put(rateKey, String(attempts + 1), {
      expirationTtl: LOGIN_WINDOW_SECONDS,
    });
    return jsonResponse({ error: "Invalid password" }, 401);
  }

  if (attempts > 0) {
    await env.PROFILE_CACHE.delete(rateKey);
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

  const metaConnection = await getConnection(env);

  return jsonResponse({
    pipeline_active: !!metaConnection,
    has_meta_connection: !!metaConnection,
    has_gemini_key: !!env.GEMINI_API_KEY,
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
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const enriched = messages.map((m) => ({
    ...m,
    windowExpired: Date.now() - new Date(m.timestamp).getTime() > WINDOW_MS,
  }));
  return jsonResponse(enriched);
}

/**
 * Core approve flow: remove the pending message (+ all others from the same
 * sender) and forward them into the conversation. Returns sender info, or
 * null if the pending id wasn't found.
 */
async function approvePendingCore(
  id: string,
  env: Env
): Promise<{ senderId: string; senderUsername: string; forwarded: number } | null> {
  const removed = await removePendingMessage(id, env);
  if (!removed) return null;

  // Collect this message + all other pending messages from same sender, sorted chronologically
  const otherPending = await removePendingBySender(removed.senderId, env);
  const allMessages = [removed, ...otherPending].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const senderLabel = removed.senderUsername.startsWith("@")
    ? removed.senderUsername
    : `@${removed.senderUsername}`;

  // Carry language from first pending message with a detected language
  const detectedLang = allMessages.find((m) => m.language)?.language;

  for (const msg of allMessages) {
    let translation: string | undefined;
    if (env.GEMINI_API_KEY) {
      translation = (await translateMessage(msg.messageText, env)) ?? undefined;
    }
    await addMessageToConversation(
      msg.senderId,
      msg.senderUsername,
      msg.messageText,
      "user",
      env,
      translation
    );
    await incrementStat("forwarded", env);
    await appendLog({
      type: "forwarded",
      message: `${senderLabel} — "${msg.messageText.slice(0, 80)}"`,
    }, env);
  }

  if (detectedLang) {
    await setConversationLanguage(removed.senderId, detectedLang, env);
  }

  return {
    senderId: removed.senderId,
    senderUsername: removed.senderUsername,
    forwarded: allMessages.length,
  };
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

  const result = await approvePendingCore(body.id, env);
  if (!result) {
    return jsonResponse({ error: "Message not found" }, 404);
  }

  return jsonResponse({ ok: true, forwarded: result.forwarded });
}

/**
 * Approve a pending message AND send a reply in one step (inline reply from
 * the pending queue card).
 */
export async function handleApproveAndReply(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { id?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.id || !body.text?.trim()) {
    return jsonResponse({ error: "Missing id or text" }, 400);
  }

  const result = await approvePendingCore(body.id, env);
  if (!result) {
    return jsonResponse({ error: "Message not found" }, 404);
  }

  const text = body.text.trim();
  const sent = await sendMessage(result.senderId, text, env);
  await addMessageToConversation(
    result.senderId,
    result.senderUsername,
    text,
    "agent",
    env,
    undefined,
    sent ? "sent" : "failed"
  );

  if (sent) {
    await incrementStat("replied", env);
    await appendLog({
      type: "replied",
      message: `Reply to @${result.senderUsername} — "${text.slice(0, 80)}"`,
    }, env);
  } else {
    await appendLog({
      type: "error",
      message: `Reply to @${result.senderUsername} failed to send — retry from conversation`,
    }, env);
  }

  return jsonResponse(
    { ok: sent, forwarded: result.forwarded, sent },
    sent ? 200 : 502
  );
}

export async function handleApproveAllPending(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const messages = await getPendingMessages(env);
  if (messages.length === 0) {
    return jsonResponse({ ok: true, forwarded: 0 });
  }

  // Group by sender, sorted chronologically within each group
  const bySender = new Map<string, typeof messages>();
  for (const msg of messages) {
    const list = bySender.get(msg.senderId) || [];
    list.push(msg);
    bySender.set(msg.senderId, list);
  }

  let totalForwarded = 0;
  for (const [senderId, senderMessages] of bySender) {
    const sorted = senderMessages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const senderLabel = sorted[0].senderUsername.startsWith("@")
      ? sorted[0].senderUsername
      : `@${sorted[0].senderUsername}`;

    const detectedLang = sorted.find((m) => m.language)?.language;

    for (const msg of sorted) {
      let translation: string | undefined;
      if (env.GEMINI_API_KEY) {
        translation = (await translateMessage(msg.messageText, env)) ?? undefined;
      }
      await addMessageToConversation(
        msg.senderId,
        msg.senderUsername,
        msg.messageText,
        "user",
        env,
        translation
      );
      await incrementStat("forwarded", env);
      await appendLog({
        type: "forwarded",
        message: `${senderLabel} — "${msg.messageText.slice(0, 80)}"`,
      }, env);
      totalForwarded++;
    }

    if (detectedLang) {
      await setConversationLanguage(senderId, detectedLang, env);
    }
  }

  // Clear pending queue
  await clearPendingMessages(env);

  return jsonResponse({ ok: true, forwarded: totalForwarded });
}

export async function handleDismissAllPending(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const dismissed = await clearPendingMessages(env);
  return jsonResponse({ ok: true, dismissed });
}

export async function handleDismissPending(
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

  return jsonResponse({ ok: true });
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

export async function handleAddBlock(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { username?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const username = body.username?.trim().replace(/^@/, "");
  if (!username) {
    return jsonResponse({ error: "Missing username" }, 400);
  }

  await addToBlocklist({
    senderId: `manual:${username}`,
    username,
  }, env);

  return jsonResponse({ ok: true });
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
