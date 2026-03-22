import type { Env } from "./types";
import { handleVerification, handleWebhook } from "./handlers/instagram";
import { handleHubSpotWebhook } from "./handlers/hubspot";
import {
  handleLogin,
  handleLogout,
  handleStats,
  handleLogs,
  handleConsoleLogs,
  handleHealth,
  handleGetPending,
  handleApprovePending,
  handleRejectPending,
  handleDismissPending,
  handleAddBlock,
  handleGetBlocklist,
  handleUnblock,
} from "./handlers/dashboard";
import {
  handleFacebookAuthInit,
  handleFacebookCallback,
  handleGetConnection,
  handleDisconnect,
} from "./handlers/facebook-auth";
import {
  handleTestMessage,
  handleGetWebhooks,
  handleSubscribeWebhooks,
  handleGetFilterSettings,
  handleUpdateFilterSettings,
} from "./handlers/meta-api";
import {
  exchangeCodeForTokens,
  finalizeChannelConnection,
} from "./services/hubspot-api";
import { clog, cerr } from "./services/logger";

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    if (path === "/api/logs" && request.method === "GET") {
      return handleLogs(request, env);
    }
    if (path === "/api/console-logs" && request.method === "GET") {
      return handleConsoleLogs(request, env);
    }
    if (path === "/api/health" && request.method === "GET") {
      return handleHealth(request, env);
    }

    // Pending queue
    if (path === "/api/pending" && request.method === "GET") {
      return handleGetPending(request, env);
    }
    if (path === "/api/pending/approve" && request.method === "POST") {
      return handleApprovePending(request, env);
    }
    if (path === "/api/pending/reject" && request.method === "POST") {
      return handleRejectPending(request, env);
    }
    if (path === "/api/pending/dismiss" && request.method === "POST") {
      return handleDismissPending(request, env);
    }

    // Blocklist
    if (path === "/api/blocklist" && request.method === "GET") {
      return handleGetBlocklist(request, env);
    }
    if (path === "/api/blocklist" && request.method === "POST") {
      return handleAddBlock(request, env);
    }
    if (path === "/api/blocklist/unblock" && request.method === "POST") {
      return handleUnblock(request, env);
    }

    // Facebook OAuth
    if (path === "/auth/facebook" && request.method === "GET") {
      return handleFacebookAuthInit(request, env);
    }
    if (path === "/auth/facebook/callback" && request.method === "GET") {
      return handleFacebookCallback(request, env);
    }

    // Meta connection & API
    if (path === "/api/meta/connection" && request.method === "GET") {
      return handleGetConnection(request, env);
    }
    if (path === "/api/meta/disconnect" && request.method === "POST") {
      return handleDisconnect(request, env);
    }
    if (path === "/api/meta/test-message" && request.method === "POST") {
      return handleTestMessage(request, env);
    }
    if (path === "/api/meta/webhooks" && request.method === "GET") {
      return handleGetWebhooks(request, env);
    }
    if (path === "/api/meta/webhooks" && request.method === "POST") {
      return handleSubscribeWebhooks(request, env);
    }

    // Filter settings
    if (path === "/api/settings/filter" && request.method === "GET") {
      return handleGetFilterSettings(request, env);
    }
    if (path === "/api/settings/filter" && request.method === "POST") {
      return handleUpdateFilterSettings(request, env);
    }

    // Instagram webhook
    if (path === "/webhook/instagram") {
      if (request.method === "GET") {
        // Webhook verification
        return handleVerification(url, env);
      }

      if (request.method === "POST") {
        // Incoming message
        return handleWebhook(request, env, ctx);
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

        await clog(env, "Connect flow params:", {
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
        await cerr(env, "Connect flow error:", error);
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
