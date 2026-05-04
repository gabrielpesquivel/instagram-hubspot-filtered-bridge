import type { Env, InstagramWebhookPayload, InstagramMessaging, ConversationMessage } from "../types";
import { verifyWebhookSignatureBytes } from "../utils/crypto";
import { getUserProfile } from "../services/instagram-api";
import { getInstagramPageId } from "../services/facebook-oauth";
import { shouldForwardMessage } from "../services/filter";
import { addPendingMessage } from "../services/pending";
import { incrementStat, appendLog } from "../services/stats";
import { clog, cerr } from "../services/logger";
import { addMessageToConversation, getConversation, markConversationRead, setConversationLanguage } from "../services/conversations";
import { generateReply, translateMessage, detectLanguage } from "../services/gemini-api";
import { sendMessage } from "../services/instagram-api";

/**
 * Handle Instagram webhook verification (GET request)
 */
export async function handleVerification(
  url: URL,
  env: Env
): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.WEBHOOK_VERIFY_TOKEN) {
    await clog(env, "Webhook verified");
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

/**
 * Handle incoming Instagram webhook (POST request)
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Get raw body as bytes for signature verification
  const rawBodyBuffer = await request.arrayBuffer();
  const rawBodyBytes = new Uint8Array(rawBodyBuffer);
  const rawBody = new TextDecoder().decode(rawBodyBytes);

  const signature = request.headers.get("x-hub-signature-256");
  const isValid = await verifyWebhookSignatureBytes(
    rawBodyBytes,
    signature,
    env.INSTAGRAM_APP_SECRET
  );

  if (!isValid) {
    await cerr(env, "Instagram webhook signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse payload
  let payload: InstagramWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Must be Instagram object
  if (payload.object !== "instagram") {
    return new Response("OK", { status: 200 });
  }

  // Process each entry
  for (const entry of payload.entry) {
    if (!entry.messaging) {
      continue;
    }
    for (const messaging of entry.messaging) {
      await processMessage(messaging, env, ctx);
    }
  }

  // Always return 200 quickly to avoid Instagram retries
  return new Response("OK", { status: 200 });
}

async function processMessage(
  messaging: InstagramMessaging,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const { sender, message } = messaging;

  // Skip if no message (e.g., read receipts)
  if (!message) {
    return;
  }

  // Skip if no text and no attachments
  if (!message.text && !message.attachments) {
    return;
  }

  const senderId = sender.id;

  // Deduplicate by Instagram message ID to prevent webhook retry duplicates
  if (message.mid) {
    const dedupKey = `msg_seen:${message.mid}`;
    const alreadySeen = await env.PROFILE_CACHE.get(dedupKey);
    if (alreadySeen) {
      await clog(env, `Duplicate message ${message.mid} — skipping`);
      return;
    }
    // Mark as seen with 1-hour TTL (webhook retries happen within minutes)
    await env.PROFILE_CACHE.put(dedupKey, "1", { expirationTtl: 3600 });
  }

  // Detect echo messages (sent BY the business account)
  // Only store if not already captured by our reply handler (avoids duplicates)
  if (message.is_echo) {
    const recipientId = messaging.recipient.id;
    const text = message.text || "";
    await clog(env, `Echo message detected (sent by business account to ${recipientId})`);

    const existingConv = await getConversation(recipientId, env);
    if (existingConv && text) {
      const lastMsg = existingConv.messages[existingConv.messages.length - 1];
      const isDuplicate = lastMsg && lastMsg.sender === "agent" && lastMsg.text === text;
      if (!isDuplicate) {
        // Sent from Instagram app directly — capture it
        await addMessageToConversation(recipientId, existingConv.senderUsername, text, "agent", env);
        await incrementStat("replied", env);
        await appendLog({
          type: "replied",
          message: `Sent to ${recipientId} — "${text.slice(0, 80)}"`,
        }, env);
      }
    }
    return;
  }

  // Also check sender ID against our own page ID as a fallback
  const ownPageId = await getInstagramPageId(env);
  if (senderId === ownPageId) {
    const recipientIdFallback = messaging.recipient.id;
    const text = message.text || "";
    await clog(env, `Outgoing message detected from own page ID ${senderId}`);

    // Store in conversation so AI has full context
    if (text) {
      const existingConvFallback = await getConversation(recipientIdFallback, env);
      if (existingConvFallback) {
        const lastMsg = existingConvFallback.messages[existingConvFallback.messages.length - 1];
        const isDuplicate = lastMsg && lastMsg.sender === "agent" && lastMsg.text === text;
        if (!isDuplicate) {
          await addMessageToConversation(recipientIdFallback, existingConvFallback.senderUsername, text, "agent", env);
        }
      }
    }

    await incrementStat("replied", env);
    await appendLog({
      type: "replied",
      message: `Sent to ${recipientIdFallback} — "${(message.text || "").slice(0, 80)}"`,
    }, env);
    return;
  }

  try {
    // Fetch sender profile
    const profile = await getUserProfile(senderId, env);

    // Apply filter (pass raw senderId for blocklist matching)
    const filterResult = await shouldForwardMessage(senderId, profile, env);

    const senderLabel = profile.username ? `@${profile.username}` : senderId;

    if (!filterResult.shouldForward) {
      await clog(env, `Skipping message from ${senderId}: ${filterResult.reason}`);
      const reasonMap: Record<string, string> = {
        verified: "skipped:verified",
        high_followers: "skipped:high_followers",
        blocklisted: "skipped:blocklisted",
      };
      const reasonLabels: Record<string, string> = {
        verified: "verified account",
        high_followers: `${profile.follower_count?.toLocaleString()} followers`,
        blocklisted: "blocklisted",
      };
      const statKey = reasonMap[filterResult.reason];
      if (statKey) await incrementStat(statKey, env);
      await appendLog({
        type: "skipped",
        message: `${senderLabel} — ${reasonLabels[filterResult.reason] || filterResult.reason}`,
      }, env);
      return;
    }

    const hasMedia = !!(message.attachments && message.attachments.length > 0);
    const messageText = message.text || (hasMedia ? "[media]" : "");
    const senderUsername = profile.username || senderId;

    // Check if sender has existing active conversation + auto-approve toggle
    const existingConv = await getConversation(senderId, env);
    const filterRaw = await env.PROFILE_CACHE.get("filter_settings");
    const filterSettings = filterRaw ? JSON.parse(filterRaw) : {};
    const autoApprove = filterSettings.auto_approve_known === true;

    if (existingConv && autoApprove) {
      // Auto-approve: add directly to conversation, skip pending queue
      let translation: string | undefined;
      if (env.GEMINI_API_KEY) {
        translation = (await translateMessage(messageText, env)) ?? undefined;
      }
      await addMessageToConversation(senderId, senderUsername, messageText, "user", env, translation);

      // Detect and store language if not already set
      if (!existingConv.language && env.GEMINI_API_KEY && messageText && messageText !== "[media]") {
        const lang = await detectLanguage(messageText, env);
        if (lang) await setConversationLanguage(senderId, lang, env);
      }

      await clog(env, `Auto-approved message from ${senderId} (existing conversation)`);
      await incrementStat("forwarded", env);
      await appendLog({
        type: "forwarded",
        message: `${senderLabel} — "${messageText.slice(0, 80)}" (auto)`,
      }, env);

      // Auto-reply if enabled for this conversation
      if (existingConv.autoReply && env.GEMINI_API_KEY) {
        try {
          // Build messages from existing conv + new message (avoid KV re-fetch race)
          const newMsg: ConversationMessage = {
            id: crypto.randomUUID(),
            sender: "user",
            text: messageText,
            ...(translation ? { translation } : {}),
            timestamp: new Date().toISOString(),
          };
          const messagesForReply = [...existingConv.messages, newMsg];
          const reply = await generateReply(messagesForReply, env);
          const sent = await sendMessage(senderId, reply, env);
          if (sent) {
            await addMessageToConversation(senderId, senderUsername, reply, "agent", env);
            await markConversationRead(senderId, env);
            await incrementStat("replied", env);
            await appendLog({
              type: "replied",
              message: `AI auto-reply to ${senderLabel} — "${reply.slice(0, 80)}"`,
            }, env);
          }
        } catch (error) {
          await cerr(env, `Auto-reply failed for ${senderId}:`, error);
        }
      }
      return;
    }

    // Detect language for display
    let language: string | undefined;
    if (env.GEMINI_API_KEY && messageText && messageText !== "[media]") {
      language = (await detectLanguage(messageText, env)) ?? undefined;
    }

    // Add to pending queue for manual approval
    await addPendingMessage({
      senderId,
      senderUsername,
      followerCount: profile.follower_count,
      isVerified: profile.is_verified,
      messageText,
      hasMedia,
      language,
    }, env);
    await clog(env, `Added message from ${senderId} to pending queue`);
    await incrementStat("pending", env);
    await appendLog({
      type: "pending",
      message: `${senderLabel} — "${messageText.slice(0, 80)}"`,
    }, env);
  } catch (error) {
    await cerr(env, `Error processing message from ${senderId}:`, error);
    await incrementStat("errors", env);
    await appendLog({
      type: "error",
      message: `Error processing message from ${senderId}: ${error instanceof Error ? error.message : String(error)}`,
    }, env);
  }
}
