import type { Env } from "./types";
import { handleVerification, handleWebhook } from "./handlers/instagram";
import { handleHubSpotWebhook } from "./handlers/hubspot";
import {
  handleLogin,
  handleLogout,
  handleStats,
  handleHealth,
} from "./handlers/dashboard";
import {
  exchangeCodeForTokens,
  finalizeChannelConnection,
} from "./services/hubspot-api";

const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_SCOPES = [
  "conversations.custom_channels.read",
  "conversations.custom_channels.write",
  "conversations.read",
  "conversations.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Dashboard API
    if (path === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (path === "/api/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }
    if (path === "/api/stats" && request.method === "GET") {
      return handleStats(request, env);
    }
    if (path === "/api/health" && request.method === "GET") {
      return handleHealth(request, env);
    }

    // Instagram webhook
    if (path === "/webhook/instagram") {
      if (request.method === "GET") {
        // Webhook verification
        return handleVerification(url, env);
      }

      if (request.method === "POST") {
        // Incoming message
        return handleWebhook(request, env);
      }
    }

    // HubSpot outbound webhook
    if (path === "/webhook/hubspot" && request.method === "POST") {
      return handleHubSpotWebhook(request, env);
    }

    // HubSpot OAuth: initiate authorization
    if (path === "/auth/hubspot" && request.method === "GET") {
      const redirectUri = `${url.origin}/auth/hubspot/callback`;
      const params = new URLSearchParams({
        client_id: env.HUBSPOT_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: HUBSPOT_SCOPES.join(" "),
      });

      return Response.redirect(
        `${HUBSPOT_AUTHORIZE_URL}?${params.toString()}`,
        302
      );
    }

    // HubSpot OAuth: callback
    if (path === "/auth/hubspot/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");

      if (!code) {
        const error = url.searchParams.get("error");
        return new Response(
          `Authorization failed: ${error || "no code received"}`,
          { status: 400 }
        );
      }

      const redirectUri = `${url.origin}/auth/hubspot/callback`;
      const tokens = await exchangeCodeForTokens(code, redirectUri, env);

      if (!tokens) {
        return new Response("Failed to exchange authorization code for tokens", {
          status: 500,
        });
      }

      return new Response(
        "HubSpot OAuth authorized successfully. Tokens stored. You can close this tab.",
        { status: 200 }
      );
    }

    // HubSpot channel account connection flow
    if (path === "/connect/hubspot" && request.method === "GET") {
      try {
        const accountToken = url.searchParams.get("accountToken");
        const channelId = url.searchParams.get("channelId");
        const redirectUrl = url.searchParams.get("redirectUrl");

        console.log("Connect flow params:", {
          accountToken: accountToken ? "present" : "missing",
          channelId,
          redirectUrl: redirectUrl ? "present" : "missing",
        });

        if (!accountToken || !channelId || !redirectUrl) {
          return new Response(
            `Missing required parameters. Got: accountToken=${!!accountToken}, channelId=${!!channelId}, redirectUrl=${!!redirectUrl}`,
            { status: 400 }
          );
        }

        const result = await finalizeChannelConnection(
          channelId,
          accountToken,
          env
        );

        if (!result.success) {
          return new Response(
            `Failed to connect channel account: ${result.error}`,
            { status: 500 }
          );
        }

        return new Response(null, {
          status: 302,
          headers: { Location: redirectUrl },
        });
      } catch (error) {
        console.error("Connect flow error:", error);
        return new Response(
          `Connection error: ${error instanceof Error ? error.message : String(error)}`,
          { status: 500 }
        );
      }
    }

    // Serve static assets / SPA fallback
    return env.ASSETS.fetch(request);
  },
};
