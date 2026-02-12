import type { Env } from "../types";
import { sendMessage } from "../services/instagram-api";

/**
 * Handle outbound messages from HubSpot
 * When an agent replies in HubSpot, forward to Instagram
 */
export async function handleHubSpotWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  let payload: HubSpotOutboundPayload;

  try {
    payload = await request.json();
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
