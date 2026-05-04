import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import {
  getConversationIndex,
  getConversation,
  addMessageToConversation,
  archiveConversation,
  markConversationRead,
  setAutoReply,
  deleteMessage,
  clearAllConversations,
} from "../services/conversations";
import { sendMessage } from "../services/instagram-api";
import {
  generateReply,
  getGeminiSettings,
  saveGeminiSettings,
} from "../services/gemini-api";
import { incrementStat, appendLog } from "../services/stats";

export async function handleGetConversations(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const conversations = await getConversationIndex(env);
  return jsonResponse(conversations);
}

export async function handleGetConversation(
  request: Request,
  env: Env,
  senderId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const conv = await getConversation(senderId, env);
  if (!conv) {
    return jsonResponse({ error: "Conversation not found" }, 404);
  }
  await markConversationRead(senderId, env);
  return jsonResponse(conv);
}

export async function handleReplyConversation(
  request: Request,
  env: Env,
  senderId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.text?.trim()) {
    return jsonResponse({ error: "Missing text" }, 400);
  }

  const text = body.text.trim();

  // Send via Instagram
  const sent = await sendMessage(senderId, text, env);
  if (!sent) {
    return jsonResponse({ error: "Failed to send message via Instagram" }, 500);
  }

  // Store in conversation
  const conv = await getConversation(senderId, env);
  const username = conv?.senderUsername || senderId;
  await addMessageToConversation(senderId, username, text, "agent", env);

  await incrementStat("replied", env);
  await appendLog({
    type: "replied",
    message: `Reply to @${username} — "${text.slice(0, 80)}"`,
  }, env);

  return jsonResponse({ ok: true });
}

export async function handleGenerateAndSendReply(
  request: Request,
  env: Env,
  senderId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "Gemini API key not configured" }, 400);
  }

  const conv = await getConversation(senderId, env);
  if (!conv || conv.messages.length === 0) {
    return jsonResponse({ error: "No messages to generate reply for" }, 400);
  }

  try {
    const suggestion = await generateReply(conv.messages, env);

    // Send immediately via Instagram
    const sent = await sendMessage(senderId, suggestion, env);
    if (!sent) {
      return jsonResponse({ error: "Generated reply but failed to send via Instagram", suggestion }, 500);
    }

    // Store in conversation
    await addMessageToConversation(senderId, conv.senderUsername, suggestion, "agent", env);

    await incrementStat("replied", env);
    await appendLog({
      type: "replied",
      message: `AI reply to @${conv.senderUsername} — "${suggestion.slice(0, 80)}"`,
    }, env);

    return jsonResponse({ ok: true, suggestion });
  } catch (error) {
    return jsonResponse({
      error: `Generation failed: ${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
}

export async function handleArchiveConversation(
  request: Request,
  env: Env,
  senderId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const archived = await archiveConversation(senderId, env);
  if (!archived) {
    return jsonResponse({ error: "Conversation not found" }, 404);
  }
  return jsonResponse({ ok: true });
}

export async function handleSetAutoReply(
  request: Request,
  env: Env,
  senderId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (body.enabled === undefined) {
    return jsonResponse({ error: "Missing enabled" }, 400);
  }

  const ok = await setAutoReply(senderId, body.enabled, env);
  if (!ok) {
    return jsonResponse({ error: "Conversation not found" }, 404);
  }
  return jsonResponse({ ok: true });
}

export async function handleDeleteMessage(
  request: Request,
  env: Env,
  senderId: string,
  messageId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const deleted = await deleteMessage(senderId, messageId, env);
  if (!deleted) {
    return jsonResponse({ error: "Message not found" }, 404);
  }
  return jsonResponse({ ok: true });
}

export async function handleClearAllConversations(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const count = await clearAllConversations(env);
  return jsonResponse({ ok: true, cleared: count });
}

export async function handleGetAgentSettings(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const geminiSettings = await getGeminiSettings(env);

  const filterRaw = await env.PROFILE_CACHE.get("filter_settings");
  const filterSettings = filterRaw ? JSON.parse(filterRaw) : {};

  return jsonResponse({
    gemini_model: geminiSettings.model,
    auto_approve_known: filterSettings.auto_approve_known ?? false,
    has_gemini_key: !!env.GEMINI_API_KEY,
  });
}

export async function handleUpdateAgentSettings(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { gemini_model?: string; auto_approve_known?: boolean };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (body.gemini_model) {
    await saveGeminiSettings({ model: body.gemini_model }, env);
  }

  if (body.auto_approve_known !== undefined) {
    const filterRaw = await env.PROFILE_CACHE.get("filter_settings");
    const filterSettings = filterRaw ? JSON.parse(filterRaw) : {};
    filterSettings.auto_approve_known = body.auto_approve_known;
    await env.PROFILE_CACHE.put("filter_settings", JSON.stringify(filterSettings));
  }

  return jsonResponse({ ok: true });
}
