import type { Env } from "../types";
import { sendMessage } from "../services/instagram-api";
import { verifyHubSpotSignature } from "../utils/crypto";
import { incrementStat } from "../services/stats";

/**
 * Handle outbound messages from HubSpot
 * When an agent replies in HubSpot, forward to Instagram
 */
export async function handleHubSpotWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const rawBody = await request.text();

  // Verify HubSpot signature
  const signature = request.headers.get("x-hubspot-signature-v2");
  const isValid = await verifyHubSpotSignature(
    request.method,
    request.url,
    rawBody,
    signature,
    env.HUBSPOT_CLIENT_SECRET
  );

  if (!isValid) {
    console.error("HubSpot webhook signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: HubSpotOutboundPayload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (payload.type !== "OUTGOING_CHANNEL_MESSAGE_CREATED") {
    return new Response("OK", { status: 200 });
  }

  const message = payload.message;
  if (!message?.text || !message.recipients?.length) {
    return new Response("OK", { status: 200 });
  }

  // Extract recipient IGSID from delivery identifier
  const recipient = message.recipients[0];
  const recipientId = recipient.deliveryIdentifier?.value;

  if (!recipientId) {
    console.error("No recipient delivery identifier found");
    return new Response("OK", { status: 200 });
  }

  const success = await sendMessage(recipientId, message.text, env);

  if (success) {
    console.log(`Sent reply to Instagram user ${recipientId}`);
    await incrementStat("replied", env);
  } else {
    console.error(`Failed to send reply to Instagram user ${recipientId}`);
  }

  return new Response("OK", { status: 200 });
}

interface HubSpotOutboundPayload {
  type?: string;
  message?: {
    text?: string;
    recipients?: Array<{
      deliveryIdentifier?: {
        type: string;
        value: string;
      };
    }>;
  };
}
