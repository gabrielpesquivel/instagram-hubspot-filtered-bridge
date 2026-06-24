import type { Env, ConversationMessage } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr } from "../services/logger";
import { generateReply } from "../services/gemini-api";
import {
  generateGoogleAuthUrl,
  validateGoogleState,
  exchangeGoogleCode,
  fetchGmailAddress,
  storeGoogleConnection,
  getGoogleConnection,
  clearGoogleConnection,
  getValidGoogleToken,
} from "../services/google-oauth";
import { listUnreadThreads, getThreadDetail } from "../services/gmail-api";

/** Initiate Google OAuth — validate session, then redirect to Google consent. */
export async function handleGoogleAuthInit(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const authUrl = await generateGoogleAuthUrl(url.origin, env);
  return new Response(null, { status: 302, headers: { Location: authUrl } });
}

/** Google OAuth callback — exchange code, store tokens + connected address. */
export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return htmlResponse("Authorization Failed", `<p>Google denied the request: ${escapeHtml(errorParam)}</p><p><a href="/#/email">Back</a></p>`, 400);
  }
  if (!code || !state) {
    return htmlResponse("Authorization Failed", `<p>Missing code or state.</p><p><a href="/#/email">Back</a></p>`, 400);
  }
  if (!(await validateGoogleState(state, env))) {
    return htmlResponse("Authorization Failed", `<p>Invalid or expired state token. Please try again.</p><p><a href="/#/email">Back</a></p>`, 400);
  }

  const redirectUri = `${url.origin}/auth/google/callback`;
  const tokens = await exchangeGoogleCode(code, redirectUri, env);
  if (!tokens?.access_token) {
    return htmlResponse("Authorization Failed", `<p>Failed to exchange the authorization code.</p><p><a href="/#/email">Try Again</a></p>`, 500);
  }

  const email = await fetchGmailAddress(tokens.access_token);
  if (!email) {
    return htmlResponse("Authorization Failed", `<p>Connected, but could not read the mailbox address.</p><p><a href="/#/email">Try Again</a></p>`, 500);
  }

  // Preserve an existing refresh token if Google didn't return a new one.
  let refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    const existing = await getGoogleConnection(env);
    refreshToken = existing?.refresh_token;
  }
  if (!refreshToken) {
    return htmlResponse("Authorization Failed", `<p>No refresh token returned. Remove this app's access at myaccount.google.com/permissions, then reconnect.</p><p><a href="/#/email">Try Again</a></p>`, 500);
  }

  await storeGoogleConnection(
    {
      email,
      refresh_token: refreshToken,
      access_token: tokens.access_token,
      access_token_expires_at: Date.now() + tokens.expires_in * 1000,
      connected_at: new Date().toISOString(),
    },
    env
  );

  return new Response(null, { status: 302, headers: { Location: "/#/email" } });
}

export async function handleGetEmailConnection(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const conn = await getGoogleConnection(env);
  if (!conn) return jsonResponse({ connected: false });
  return jsonResponse({ connected: true, email: conn.email, connected_at: conn.connected_at });
}

export async function handleDisconnectEmail(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  await clearGoogleConnection(env);
  return jsonResponse({ ok: true });
}

export async function handleGetEmailThreads(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const token = await getValidGoogleToken(env);
  if (!token) return jsonResponse({ error: "Gmail not connected" }, 409);
  try {
    const threads = await listUnreadThreads(token);
    return jsonResponse({ threads });
  } catch (error) {
    await cerr(env, "List email threads error:", error);
    return jsonResponse({ error: "Failed to fetch emails" }, 500);
  }
}

/** Fetch one thread and return an AI-suggested reply (same engine as DMs). */
export async function handleSuggestEmailReply(
  request: Request,
  env: Env,
  threadId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const conn = await getGoogleConnection(env);
  const token = await getValidGoogleToken(env);
  if (!conn || !token) return jsonResponse({ error: "Gmail not connected" }, 409);

  try {
    const detail = await getThreadDetail(token, threadId, conn.email);
    if (!detail) return jsonResponse({ error: "Thread not found" }, 404);

    // Map the thread to the conversation shape generateReply expects: the
    // customer is "user", we are "agent". Subject rides on the first message.
    const messages: ConversationMessage[] = [];
    let first = true;
    for (const m of detail.messages) {
      const text = first ? `Subject: ${detail.subject}\n\n${m.text}` : m.text;
      first = false;
      if (!text.trim()) continue;
      messages.push({
        id: crypto.randomUUID(),
        sender: m.fromUs ? "agent" : "user",
        text,
        timestamp: m.date || new Date().toISOString(),
      });
    }
    if (!messages.some((m) => m.sender === "user")) {
      return jsonResponse({ error: "No customer message to reply to" }, 400);
    }

    const firstCustomer = detail.messages.find((m) => !m.fromUs);
    const customerName = firstNameFrom(firstCustomer?.from || "");

    const emailInstruction = `This message is a customer-support EMAIL, not an Instagram DM. For this reply ONLY, override the brevity and pure-greeting rules above. Format the response EXACTLY like this, including the blank lines:

Hi, ${customerName}.

<your reply body here — clear sentences, with a line break between distinct points so it reads well>

Kind regards,

Still reply in the customer's language. Do not add a name or signature after "Kind regards,". Do not include a subject line or any text outside this format.`;

    const suggestion = await generateReply(messages, env, emailInstruction);
    return jsonResponse({ suggestion, subject: detail.subject });
  } catch (error) {
    await cerr(env, "Suggest email reply error:", error);
    return jsonResponse({ error: "Failed to generate suggestion" }, 500);
  }
}

// "Jane Doe <jane@x.com>" -> "Jane"; falls back to "there" for bare/blank addresses.
function firstNameFrom(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = (m ? m[1] : from).trim();
  if (!name || name.includes("@")) return "there";
  return name.split(/\s+/)[0];
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlResponse(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:500px;margin:80px auto;padding:0 1rem;color:#333}h1{font-size:1.4rem}a{color:#1877f2}</style></head><body><h1>${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
