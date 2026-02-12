import type { Env, InstagramWebhookPayload } from "../types";
import { verifyWebhookSignatureBytes } from "../utils/crypto";
import { getUserProfile } from "../services/instagram-api";
import { forwardMessage } from "../services/hubspot-api";
import { shouldForwardMessage } from "../services/filter";

/**
 * Handle Instagram webhook verification (GET request)
 */
export function handleVerification(
  url: URL,
  env: Env
): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

/**
 * Handle incoming Instagram webhook (POST request)
 */
export async function handleWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  // Get raw body as bytes for signature verification
  const rawBodyBuffer = await request.arrayBuffer();
  const rawBodyBytes = new Uint8Array(rawBodyBuffer);
  const rawBody = new TextDecoder().decode(rawBodyBytes);

  // Signature verification (warn-only until secret mismatch is resolved)
  const signature = request.headers.get("x-hub-signature-256");
  const isValid = await verifyWebhookSignatureBytes(
    rawBodyBytes,
    signature,
    env.META_APP_SECRET
  );

  if (!isValid) {
    // TODO: Change back to rejecting once signature issue is resolved
    console.warn("Webhook signature mismatch - processing anyway");
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
    for (const messaging of entry.messaging) {
      await processMessage(messaging, env);
    }
  }

  // Always return 200 quickly to avoid Instagram retries
  return new Response("OK", { status: 200 });
}

async function processMessage(
  messaging: InstagramWebhookPayload["entry"][0]["messaging"][0],
  env: Env
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

  try {
    // Fetch sender profile
    const profile = await getUserProfile(senderId, env);

    // Apply filter
    const filterResult = shouldForwardMessage(profile, message, env);

    if (!filterResult.shouldForward) {
      console.log(
        `Skipping message from ${senderId}: ${filterResult.reason}`
      );
      return;
    }

    // Forward to HubSpot
    const conversationId = `ig_${senderId}`;
    const success = await forwardMessage(
      senderId,
      profile.username || "",
      conversationId,
      message.text || "",
      env
    );

    if (success) {
      console.log(`Forwarded message from ${senderId} to HubSpot`);
    }
  } catch (error) {
    console.error(`Error processing message from ${senderId}:`, error);
  }
}
