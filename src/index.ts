import type { Env } from "./types";
import { DMState, getDMState } from "./dm-state";
import { isAuthenticated } from "./utils/auth";
import { refreshMetaTokenIfNeeded } from "./services/facebook-oauth";
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
  handleApproveAndReply,
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
  handleSuggestConversationReply,
  handleGenerateAndSendReply,
  handleRetryMessage,
  handleArchiveConversation,
  handleSetAutoReply,
  handleDeleteMessage,
  handleClearAllConversations,
  handleGetAgentSettings,
  handleUpdateAgentSettings,
} from "./handlers/conversations";

export { DMState };
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
  handleListFiles,
  handleUploadFile,
  handleGetFile,
  handleDeleteFile,
} from "./handlers/files";
import {
  handleListInstagramUnread,
  handleGetInstagramThread,
  handleMarkInstagramDone,
  handleSuggestInstagramThreadReply,
} from "./handlers/instagram-inbox";
import { handleGetAmendments, handleAmendmentAction } from "./handlers/ai";
import { handleRemoveBackground } from "./handlers/remove-bg";
import { handleShopifyOrderLookup, handleShopifyOrdersByEmail } from "./handlers/shopify";
import {
  handleUpdateAddress,
  handleUpdateEmail,
  handleCancelRefund,
  handleDuplicateOrder,
  handleAddToOrder,
  handleParseAddress,
  handleGetOrderItems,
  handleSearchVariants,
} from "./handlers/shopify-actions";
import {
  handleGoogleAuthInit,
  handleGoogleCallback,
  handleGetEmailConnection,
  handleDisconnectEmail,
  handleGetEmailThreads,
  handleSuggestEmailReply,
  handleSendEmailReply,
  handleGetEmailThread,
  handleGetEmailSignature,
  handleSetEmailSignature,
  handleMarkEmailDone,
  handleGetEmailAttachment,
  handleSetImageLabel,
} from "./handlers/email";

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
    if (path === "/api/pending/approve-reply" && request.method === "POST") {
      return handleApproveAndReply(request, env);
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

    // Message routes: /api/conversations/:senderId/messages/:messageId[/retry]
    const msgMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+?)(\/retry)?$/);
    if (msgMatch) {
      const senderId = decodeURIComponent(msgMatch[1]);
      const messageId = decodeURIComponent(msgMatch[2]);
      if (msgMatch[3] && request.method === "POST") {
        return handleRetryMessage(request, env, senderId, messageId);
      }
      if (!msgMatch[3] && request.method === "DELETE") {
        return handleDeleteMessage(request, env, senderId, messageId);
      }
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
      if (action === "suggest" && request.method === "POST") {
        return handleSuggestConversationReply(request, env, senderId);
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

    // Email Manager (Gmail) — Google OAuth
    if (path === "/auth/google" && request.method === "GET") {
      return handleGoogleAuthInit(request, env);
    }
    if (path === "/auth/google/callback" && request.method === "GET") {
      return handleGoogleCallback(request, env);
    }
    if (path === "/api/email/connection" && request.method === "GET") {
      return handleGetEmailConnection(request, env);
    }
    if (path === "/api/email/disconnect" && request.method === "POST") {
      return handleDisconnectEmail(request, env);
    }
    if (path === "/api/email/threads" && request.method === "GET") {
      return handleGetEmailThreads(request, env);
    }
    if (path === "/api/email/signature" && request.method === "GET") {
      return handleGetEmailSignature(request, env);
    }
    if (path === "/api/email/signature" && request.method === "POST") {
      return handleSetEmailSignature(request, env);
    }
    const emailSuggestMatch = path.match(/^\/api\/email\/threads\/([^/]+)\/suggest$/);
    if (emailSuggestMatch && request.method === "POST") {
      return handleSuggestEmailReply(request, env, decodeURIComponent(emailSuggestMatch[1]));
    }
    const emailReplyMatch = path.match(/^\/api\/email\/threads\/([^/]+)\/reply$/);
    if (emailReplyMatch && request.method === "POST") {
      return handleSendEmailReply(request, env, decodeURIComponent(emailReplyMatch[1]));
    }
    const emailDoneMatch = path.match(/^\/api\/email\/threads\/([^/]+)\/done$/);
    if (emailDoneMatch && request.method === "POST") {
      return handleMarkEmailDone(request, env, decodeURIComponent(emailDoneMatch[1]));
    }
    const emailImgLabelMatch = path.match(/^\/api\/email\/threads\/([^/]+)\/image-label$/);
    if (emailImgLabelMatch && request.method === "POST") {
      return handleSetImageLabel(request, env, decodeURIComponent(emailImgLabelMatch[1]));
    }
    const emailAttachMatch = path.match(/^\/api\/email\/attachments\/([^/]+)\/([^/]+)$/);
    if (emailAttachMatch && request.method === "GET") {
      return handleGetEmailAttachment(
        request,
        env,
        decodeURIComponent(emailAttachMatch[1]),
        decodeURIComponent(emailAttachMatch[2])
      );
    }
    const emailThreadMatch = path.match(/^\/api\/email\/threads\/([^/]+)$/);
    if (emailThreadMatch && request.method === "GET") {
      return handleGetEmailThread(request, env, decodeURIComponent(emailThreadMatch[1]));
    }

    // Shopify order/tracking lookup (read-only)
    if (path === "/api/shopify/order" && request.method === "GET") {
      return handleShopifyOrderLookup(request, env);
    }
    if (path === "/api/shopify/orders" && request.method === "GET") {
      return handleShopifyOrdersByEmail(request, env);
    }

    // Shopify order WRITE actions (agent-confirmed; Shopify + StarShipit)
    if (path === "/api/shopify/actions/update-address" && request.method === "POST") {
      return handleUpdateAddress(request, env);
    }
    if (path === "/api/shopify/actions/update-email" && request.method === "POST") {
      return handleUpdateEmail(request, env);
    }
    if (path === "/api/shopify/actions/cancel-refund" && request.method === "POST") {
      return handleCancelRefund(request, env);
    }
    if (path === "/api/shopify/actions/duplicate-order" && request.method === "POST") {
      return handleDuplicateOrder(request, env);
    }
    if (path === "/api/shopify/actions/add-to-order" && request.method === "POST") {
      return handleAddToOrder(request, env);
    }
    if (path === "/api/shopify/actions/parse-address" && request.method === "POST") {
      return handleParseAddress(request, env);
    }
    if (path === "/api/shopify/actions/order-items" && request.method === "GET") {
      return handleGetOrderItems(request, env);
    }
    if (path === "/api/shopify/actions/search-variants" && request.method === "GET") {
      return handleSearchVariants(request, env);
    }

    // AI guideline amendments (the self-improving loop)
    if (path === "/api/ai/amendments" && request.method === "GET") {
      return handleGetAmendments(request, env);
    }
    if (path === "/api/ai/amendments/action" && request.method === "POST") {
      return handleAmendmentAction(request, env);
    }

    // Instagram pull (live unread DMs, like the email list)
    if (path === "/api/instagram/unread" && request.method === "GET") {
      return handleListInstagramUnread(request, env);
    }
    if (path === "/api/instagram/done" && request.method === "POST") {
      return handleMarkInstagramDone(request, env);
    }
    const igThreadSuggestMatch = path.match(/^\/api\/instagram\/threads\/([^/]+)\/suggest$/);
    if (igThreadSuggestMatch && request.method === "POST") {
      return handleSuggestInstagramThreadReply(request, env, decodeURIComponent(igThreadSuggestMatch[1]));
    }
    const igThreadMatch = path.match(/^\/api\/instagram\/threads\/([^/]+)$/);
    if (igThreadMatch && request.method === "GET") {
      return handleGetInstagramThread(request, env, decodeURIComponent(igThreadMatch[1]));
    }

    // Filter settings
    if (path === "/api/settings/filter" && request.method === "GET") {
      return handleGetFilterSettings(request, env);
    }
    if (path === "/api/settings/filter" && request.method === "POST") {
      return handleUpdateFilterSettings(request, env);
    }

    // SOTA background removal for the gangsheet tool (fal.ai / BRIA RMBG-2.0)
    if (path === "/api/remove-bg" && request.method === "POST") {
      return handleRemoveBackground(request, env);
    }

    // Daily gangsheet file uploads (R2)
    if (path === "/api/files/get" && request.method === "GET") {
      return handleGetFile(request, env);
    }
    if (path === "/api/files" && request.method === "GET") {
      return handleListFiles(request, env);
    }
    if (path === "/api/files" && request.method === "PUT") {
      return handleUploadFile(request, env);
    }
    if (path === "/api/files" && request.method === "DELETE") {
      return handleDeleteFile(request, env);
    }

    // Live updates: WebSocket to the DMState Durable Object
    if (path === "/api/ws") {
      if (!(await isAuthenticated(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }
      return getDMState(env).fetch(request);
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

  // Daily cron: renew the Meta long-lived token before it expires
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshMetaTokenIfNeeded(env));
  },
};
