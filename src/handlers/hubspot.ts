import type { Env } from "../types";
import { sendMessage } from "../services/instagram-api";
import { verifyHubSpotSignature, verifyHubSpotSignatureV3 } from "../utils/crypto";
import { incrementStat, appendLog } from "../services/stats";
import { clog, cerr } from "../services/logger";

/**
 * Handle outbound messages from HubSpot
 * When an agent replies in HubSpot, forward to Instagram
 */
export async function handleHubSpotWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const rawBody = await request.text();

  // Verify HubSpot signature (try v3 first, fall back to v2)
  const sigV2 = request.headers.get("x-hubspot-signature-v2");
  const sigV3 = request.headers.get("x-hubspot-signature-v3");
  const timestamp = request.headers.get("x-hubspot-request-timestamp");
  const requestUrl = request.url;

  let isValid = false;

  if (sigV3 && timestamp) {
    isValid = await verifyHubSpotSignatureV3(
      request.method,
      requestUrl,
      rawBody,
      sigV3,
      timestamp,
      env.HUBSPOT_CLIENT_SECRET
    );
  }

  if (!isValid && sigV2) {
    isValid = await verifyHubSpotSignature(
      request.method,
      requestUrl,
      rawBody,
      sigV2,
      env.HUBSPOT_CLIENT_SECRET
    );
  }

  if (!isValid) {
    await cerr(env, "HubSpot webhook signature not verified (proceeding)", {
      hasV2: !!sigV2,
      hasV3: !!sigV3,
    });
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
    await cerr(env, "No recipient delivery identifier found");
    return new Response("OK", { status: 200 });
  }

  const success = await sendMessage(recipientId, message.text, env);

  if (success) {
    await clog(env, `Sent reply to Instagram user ${recipientId}`);
    await incrementStat("replied", env);
    await appendLog({
      type: "replied",
      message: `Reply sent to ${recipientId} — "${(message.text || "").slice(0, 80)}"`,
    }, env);
  } else {
    await cerr(env, `Failed to send reply to Instagram user ${recipientId}`);
    await appendLog({
      type: "error",
      message: `Failed to send reply to ${recipientId}`,
    }, env);
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
