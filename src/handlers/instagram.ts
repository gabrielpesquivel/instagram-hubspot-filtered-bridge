import type { Env, InstagramWebhookPayload, InstagramMessaging } from "../types";
import { verifyWebhookSignatureBytes } from "../utils/crypto";
import { getUserProfile } from "../services/instagram-api";
import { getInstagramPageId } from "../services/facebook-oauth";
import { shouldForwardMessage } from "../services/filter";
import { addPendingMessage } from "../services/pending";
import { forwardMessage } from "../services/hubspot-api";
import { incrementStat, appendLog } from "../services/stats";
import { clog, cerr } from "../services/logger";

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

const FORWARD_DELAY_MS = 30_000; // 30s delay so AI responses feel more natural

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

  // Detect echo messages (sent BY the business account, not from a customer)
  if (message.is_echo) {
    await clog(env, `Echo message detected (sent by business account to ${messaging.recipient.id})`);
    await incrementStat("replied", env);
    await appendLog({
      type: "replied",
      message: `Sent to ${messaging.recipient.id} — "${(message.text || "").slice(0, 80)}"`,
    }, env);
    return;
  }

  // Also check sender ID against our own page ID as a fallback
  const ownPageId = await getInstagramPageId(env);
  if (senderId === ownPageId) {
    await clog(env, `Outgoing message detected from own page ID ${senderId}`);
    await incrementStat("replied", env);
    await appendLog({
      type: "replied",
      message: `Sent to ${messaging.recipient.id} — "${(message.text || "").slice(0, 80)}"`,
    }, env);
    return;
  }

  try {
    // Fetch sender profile
    const profile = await getUserProfile(senderId, env);

    // Apply filter (pass raw senderId for allowlist/blocklist matching)
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

    // Allowlisted senders get auto-forwarded after a delay so responses feel natural
    if (filterResult.reason === "allowlisted") {
      const conversationId = `ig_${senderId}`;
      ctx.waitUntil(
        new Promise<void>((resolve) => setTimeout(resolve, FORWARD_DELAY_MS)).then(async () => {
          const success = await forwardMessage(
            senderId,
            profile.username || senderId,
            conversationId,
            messageText,
            env
          );
          if (success) {
            await incrementStat("forwarded", env);
            await appendLog({
              type: "forwarded",
              message: `${senderLabel} — "${messageText.slice(0, 80)}" (allowlisted, delayed)`,
            }, env);
          } else {
            await incrementStat("errors", env);
            await appendLog({
              type: "error",
              message: `Failed to auto-forward from allowlisted ${senderLabel}`,
            }, env);
          }
        })
      );
      return;
    }

    // Add to pending queue for manual approval
    await addPendingMessage({
      senderId,
      senderUsername: profile.username || senderId,
      followerCount: profile.follower_count,
      isVerified: profile.is_verified,
      messageText,
      hasMedia,
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
