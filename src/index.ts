import type { Env } from "./types";
import { handleVerification, handleWebhook } from "./handlers/instagram";
import {
  handleLogin,
  handleLogout,
  handleStats,
  handleLogs,
  handleConsoleLogs,
  handleHealth,
  handleGetPending,
  handleApprovePending,
  handleApproveAllPending,
  handleRejectPending,
  handleDismissPending,
  handleDismissAllPending,
  handleAddBlock,
  handleGetBlocklist,
  handleUnblock,
} from "./handlers/dashboard";
import {
  handleGetConversations,
  handleGetConversation,
  handleReplyConversation,
  handleGenerateAndSendReply,
  handleArchiveConversation,
  handleSetAutoReply,
  handleDeleteMessage,
  handleClearAllConversations,
  handleGetAgentSettings,
  handleUpdateAgentSettings,
} from "./handlers/conversations";
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
    if (path === "/api/pending/approve-all" && request.method === "POST") {
      return handleApproveAllPending(request, env);
    }
    if (path === "/api/pending/reject" && request.method === "POST") {
      return handleRejectPending(request, env);
    }
    if (path === "/api/pending/dismiss" && request.method === "POST") {
      return handleDismissPending(request, env);
    }
    if (path === "/api/pending/dismiss-all" && request.method === "POST") {
      return handleDismissAllPending(request, env);
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

    // Conversations API
    if (path === "/api/conversations" && request.method === "GET") {
      return handleGetConversations(request, env);
    }
    if (path === "/api/conversations/clear-all" && request.method === "POST") {
      return handleClearAllConversations(request, env);
    }

    // Delete message route: /api/conversations/:senderId/messages/:messageId
    const msgDeleteMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/);
    if (msgDeleteMatch && request.method === "DELETE") {
      const senderId = decodeURIComponent(msgDeleteMatch[1]);
      const messageId = decodeURIComponent(msgDeleteMatch[2]);
      return handleDeleteMessage(request, env, senderId, messageId);
    }

    // Conversation routes with senderId param
    const convMatch = path.match(/^\/api\/conversations\/([^/]+)(?:\/(.+))?$/);
    if (convMatch) {
      const senderId = decodeURIComponent(convMatch[1]);
      const action = convMatch[2];

      if (!action && request.method === "GET") {
        return handleGetConversation(request, env, senderId);
      }
      if (action === "reply" && request.method === "POST") {
        return handleReplyConversation(request, env, senderId);
      }
      if (action === "generate" && request.method === "POST") {
        return handleGenerateAndSendReply(request, env, senderId);
      }
      if (action === "archive" && request.method === "POST") {
        return handleArchiveConversation(request, env, senderId);
      }
      if (action === "auto-reply" && request.method === "POST") {
        return handleSetAutoReply(request, env, senderId);
      }
    }

    // Agent settings
    if (path === "/api/settings/agent" && request.method === "GET") {
      return handleGetAgentSettings(request, env);
    }
    if (path === "/api/settings/agent" && request.method === "POST") {
      return handleUpdateAgentSettings(request, env);
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
        return handleVerification(url, env);
      }

      if (request.method === "POST") {
        return handleWebhook(request, env, ctx);
      }
    }

    // Serve static assets / SPA fallback
    return env.ASSETS.fetch(request);
  },
};
