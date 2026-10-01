import type { Env, ConversationMessage } from "../types";
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
  setMessageStatus,
  seedConversation,
} from "../services/conversations";
import { sendMessage } from "../services/instagram-api";
import { getInstagramThreadMessages } from "../services/instagram-conversations";
import {
  generateReply,
  getGeminiSettings,
  saveGeminiSettings,
  maybeProposeAmendment,
  discountFromRequest,
  discountInstruction,
} from "../services/gemini-api";
import type { ActionProposal } from "../services/gemini-api";
import { incrementStat, appendLog } from "../services/stats";

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function isWindowExpired(messages: { sender: string; timestamp: string }[]): boolean {
  const lastUserMsg = [...messages].reverse().find((m) => m.sender === "user");
  if (!lastUserMsg) return true;
  return Date.now() - new Date(lastUserMsg.timestamp).getTime() > WINDOW_MS;
}

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
  return jsonResponse({ ...conv, windowExpired: isWindowExpired(conv.messages) });
}

export async function handleReplyConversation(
  request: Request,
  env: Env,
  senderId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // `conversationId` is sent for live-pulled threads (no stored conversation
  // yet) so the first reply can seed history from the Graph thread.
  let body: { text?: string; aiSuggestion?: string; conversationId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.text?.trim()) {
    return jsonResponse({ error: "Missing text" }, 400);
  }

  const text = body.text.trim();

  const conv0 = await getConversation(senderId, env);
  let history: ConversationMessage[] = conv0?.messages || [];
  let username = conv0?.senderUsername || senderId;
  // Pull thread replied to for the first time: store its Graph history (real
  // timestamps) so the 24h window, username and AI context are right — before,
  // the conv was created with the numeric id, no history and expired=false.
  let seeded = false;
  if (!conv0 && body.conversationId) {
    const detail = await getInstagramThreadMessages(env, body.conversationId).catch(() => null);
    if (detail && (!detail.senderId || detail.senderId === senderId)) {
      history = detail.messages
        .filter((m) => m.text.trim())
        .map((m) => ({
          id: crypto.randomUUID(),
          sender: m.fromUs ? "agent" : "user",
          text: m.text,
          timestamp: m.date || new Date().toISOString(),
        }));
      username = detail.username || username;
      await seedConversation(senderId, username, history, env);
      seeded = true;
    }
  }

  // Check if 24h window expired — use HUMAN_AGENT tag if so. A brand-new
  // conversation we couldn't fetch history for keeps the old default (open).
  const expired = conv0 || seeded ? isWindowExpired(history) : false;

  // Send via Instagram
  const sent = await sendMessage(senderId, text, env, { humanAgent: expired });

  // Store either way — failed sends stay visible with a retry button
  await addMessageToConversation(
    senderId, username, text, "agent", env, undefined,
    sent ? "sent" : "failed"
  );

  if (!sent) {
    await appendLog({
      type: "error",
      message: `Reply to @${username} failed to send — retry available`,
    }, env);
    return jsonResponse({ error: "Failed to send via Instagram — saved as failed, use retry", failed: true }, 502);
  }

  await incrementStat("replied", env);
  await appendLog({
    type: "replied",
    message: `Reply to @${username} — "${text.slice(0, 80)}"`,
  }, env);

  // Self-improving loop: if this reply was an edited Auto Draft, turn the delta
  // into a proposed guideline rule for the agent to approve. Only after a
  // confirmed send, so we never learn from a reply that failed to deliver.
  let amendment = null;
  if (body.aiSuggestion) {
    const lastCustomer = [...history].reverse().find((m) => m.sender === "user");
    amendment = await maybeProposeAmendment(env, lastCustomer?.text || "", body.aiSuggestion, text);
  }

  return jsonResponse({ ok: true, amendment });
}

/**
 * Retry a previously failed outbound message.
 */
export async function handleRetryMessage(
  request: Request,
  env: Env,
  senderId: string,
  messageId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const conv = await getConversation(senderId, env);
  const msg = conv?.messages.find((m) => m.id === messageId);
  if (!conv || !msg) {
    return jsonResponse({ error: "Message not found" }, 404);
  }
  if (msg.sender !== "agent" || msg.status !== "failed") {
    return jsonResponse({ error: "Only failed outbound messages can be retried" }, 400);
  }

  const expired = isWindowExpired(conv.messages);
  const sent = await sendMessage(senderId, msg.text, env, { humanAgent: expired });
  if (!sent) {
    return jsonResponse({ error: "Send failed again" }, 502);
  }

  await setMessageStatus(senderId, messageId, "sent", env);
  await incrementStat("replied", env);
  await appendLog({
    type: "replied",
    message: `Retry to @${conv.senderUsername} succeeded — "${msg.text.slice(0, 80)}"`,
  }, env);

  return jsonResponse({ ok: true });
}

/** Generate an AI reply for a conversation WITHOUT sending it — the agent edits
 *  it in the composer and sends manually. Mirrors the email suggest flow so the
 *  unified inbox composer behaves the same on both channels. */
export async function handleSuggestConversationReply(
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
    const discount = await discountFromRequest(request);
    const actions: ActionProposal[] = [];
    const suggestion = await generateReply(
      conv.messages, env,
      discount ? discountInstruction(discount) : undefined,
      { collectActions: actions, channel: "instagram", shopify: {} }
    );
    return jsonResponse({ suggestion, actions });
  } catch (error) {
    return jsonResponse({
      error: `Generation failed: ${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
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

  if (isWindowExpired(conv.messages)) {
    return jsonResponse({ error: "24h window expired — AI replies not allowed, use manual reply (Human Agent tag)" }, 403);
  }

  try {
    const suggestion = await generateReply(conv.messages, env, undefined, { channel: "instagram" });

    // Send immediately via Instagram
    const sent = await sendMessage(senderId, suggestion, env);

    // Store either way — failed sends stay visible with a retry button
    await addMessageToConversation(
      senderId, conv.senderUsername, suggestion, "agent", env, undefined,
      sent ? "sent" : "failed"
    );

    if (!sent) {
      await appendLog({
        type: "error",
        message: `AI reply to @${conv.senderUsername} failed to send — retry available`,
      }, env);
      return jsonResponse({ error: "Generated reply but send failed — saved as failed, use retry", suggestion, failed: true }, 502);
    }

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
