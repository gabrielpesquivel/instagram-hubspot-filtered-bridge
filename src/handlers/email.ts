import type { Env, ConversationMessage } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr } from "../services/logger";
import { generateReply, recordCorrection } from "../services/gemini-api";
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
import {
  listUnreadThreads,
  getThreadDetail,
  sendThreadReply,
  markThreadRead,
  getSendAsSignature,
  getAttachment,
} from "../services/gmail-api";

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

    const labels = await getImageLabels(env, threadId);

    // Map the thread to the conversation shape generateReply expects: the
    // customer is "user", we are "agent". Subject rides on the first message.
    const messages: ConversationMessage[] = [];
    let first = true;
    for (const m of detail.messages) {
      // Note attached photos so the AI acknowledges them (it can't see them) and
      // doesn't reply as if a photo-only message were blank. Prefer the agent's
      // own description of each image when one has been added.
      const imgNote = m.images.length
        ? m.images
            .map((img, i) => {
              const label = labels[`${img.messageId}:${img.id}`];
              return label
                ? `[Customer attached an image — described by our team as: ${label}]`
                : `[Customer attached an image${m.images.length > 1 ? ` (${i + 1} of ${m.images.length})` : ""}]`;
            })
            .join("\n")
        : "";
      const bodyText = [m.text, imgNote].filter(Boolean).join("\n\n");
      const text = first ? `Subject: ${detail.subject}\n\n${bodyText}` : bodyText;
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

    // Give the AI the customer's email so it can pull their live Shopify orders
    // (Feature 3) instead of deflecting order questions to info@bootink.com.
    const customerEmail = emailFromHeader(detail.replyTo || firstCustomer?.from || "");
    const suggestion = await generateReply(messages, env, emailInstruction, {
      shopify: { customerEmail },
    });
    return jsonResponse({ suggestion, subject: detail.subject });
  } catch (error) {
    await cerr(env, "Suggest email reply error:", error);
    return jsonResponse({ error: "Failed to generate suggestion" }, 500);
  }
}

const SIGNATURE_KEY = "email_signature";
const USE_GMAIL_SIG_KEY = "email_use_gmail_sig";

/** Get the saved manual signature + whether to use the Gmail signature instead. */
export async function handleGetEmailSignature(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const signature = (await env.PROFILE_CACHE.get(SIGNATURE_KEY)) || "";
  const useGmail = (await env.PROFILE_CACHE.get(USE_GMAIL_SIG_KEY)) === "true";
  return jsonResponse({ signature, useGmail });
}

/** Save the manual signature and/or the "use my Gmail signature" preference. */
export async function handleSetEmailSignature(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as { signature?: string; useGmail?: boolean };
  if (body.signature !== undefined) await env.PROFILE_CACHE.put(SIGNATURE_KEY, body.signature);
  if (body.useGmail !== undefined) await env.PROFILE_CACHE.put(USE_GMAIL_SIG_KEY, body.useGmail ? "true" : "false");
  return jsonResponse({ ok: true });
}

// Escape text and turn newlines into <br> so a plain-text draft renders in an
// HTML email (used when appending the HTML Gmail signature).
function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// Agent-supplied image descriptions, stored per thread as a single map
// (`${messageId}:${imageId}` -> label) so a thread load is one KV read.
const imgLabelsKey = (threadId: string) => `email_img_labels:${threadId}`;

async function getImageLabels(env: Env, threadId: string): Promise<Record<string, string>> {
  return ((await env.PROFILE_CACHE.get(imgLabelsKey(threadId), "json")) as Record<string, string>) || {};
}

/** Save (or clear) the agent's description for one image in a thread. */
export async function handleSetImageLabel(
  request: Request,
  env: Env,
  threadId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as {
    messageId?: string;
    imageId?: string;
    label?: string;
  };
  if (!body.messageId || !body.imageId) return jsonResponse({ error: "Missing image reference" }, 400);

  const labels = await getImageLabels(env, threadId);
  const key = `${body.messageId}:${body.imageId}`;
  const label = (body.label || "").trim();
  if (label) labels[key] = label;
  else delete labels[key];
  await env.PROFILE_CACHE.put(imgLabelsKey(threadId), JSON.stringify(labels));
  return jsonResponse({ ok: true });
}

/** Full thread for the unified inbox thread view: messages + reply subject. */
export async function handleGetEmailThread(
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
    const labels = await getImageLabels(env, threadId);
    return jsonResponse({
      threadId,
      subject: detail.subject,
      replyTo: detail.replyTo,
      messages: detail.messages.map((m) => ({
        fromUs: m.fromUs,
        fromName: firstNameFrom(m.from),
        text: m.text,
        date: m.date,
        images: m.images.map((img) => ({ ...img, label: labels[`${img.messageId}:${img.id}`] || "" })),
      })),
    });
  } catch (error) {
    await cerr(env, "Get email thread error:", error);
    return jsonResponse({ error: "Failed to load thread" }, 500);
  }
}

/** Mark a Gmail thread read without replying — the "Done" action. Clears the
 *  UNREAD label so it drops out of the queue and stays gone after a refresh
 *  (previously it was only hidden client-side and came back on the next poll). */
export async function handleMarkEmailDone(
  request: Request,
  env: Env,
  threadId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const token = await getValidGoogleToken(env);
  if (!token) return jsonResponse({ error: "Gmail not connected" }, 409);
  const ok = await markThreadRead(token, threadId).catch(() => false);
  if (!ok) return jsonResponse({ error: "Failed to mark read" }, 502);
  return jsonResponse({ ok: true });
}

/** Stream an email image attachment so the thread view can render it inline.
 *  `mime` is passed by the client (from the thread detail) for the response
 *  Content-Type; only image/* is allowed. */
export async function handleGetEmailAttachment(
  request: Request,
  env: Env,
  messageId: string,
  attachmentId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const token = await getValidGoogleToken(env);
  if (!token) return jsonResponse({ error: "Gmail not connected" }, 409);

  const bytes = await getAttachment(token, messageId, attachmentId);
  if (!bytes) return jsonResponse({ error: "Attachment not found" }, 404);

  const reqMime = new URL(request.url).searchParams.get("mime") || "";
  const contentType = /^image\/[a-z0-9.+-]+$/i.test(reqMime) ? reqMime : "application/octet-stream";
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Send an agent's reply into a Gmail thread, then mark the thread read. */
export async function handleSendEmailReply(
  request: Request,
  env: Env,
  threadId: string
): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const conn = await getGoogleConnection(env);
  const token = await getValidGoogleToken(env);
  if (!conn || !token) return jsonResponse({ error: "Gmail not connected" }, 409);

  const body = (await request.json().catch(() => ({}))) as { text?: string; aiSuggestion?: string };
  const text = (body.text || "").trim();
  if (!text) return jsonResponse({ error: "Empty reply" }, 400);

  const useGmailSig = (await env.PROFILE_CACHE.get(USE_GMAIL_SIG_KEY)) === "true";

  // Build the body + signature. Gmail signatures are HTML, so when that mode is
  // on we send an HTML email; otherwise we append the manual plain-text one.
  let emailBody = text;
  let html = false;
  if (useGmailSig) {
    const sigHtml = (await getSendAsSignature(token, conn.email)).trim();
    emailBody = sigHtml ? `${textToHtml(text)}<br><br>${sigHtml}` : textToHtml(text);
    html = true;
  } else {
    const signature = ((await env.PROFILE_CACHE.get(SIGNATURE_KEY)) || "").trim();
    if (signature && !text.includes(signature)) emailBody = `${text}\n\n${signature}`;
  }

  try {
    const detail = await getThreadDetail(token, threadId, conn.email);
    if (!detail) return jsonResponse({ error: "Thread not found" }, 404);
    if (!detail.replyTo) return jsonResponse({ error: "No recipient to reply to" }, 400);

    const messageId = await sendThreadReply(token, {
      threadId,
      to: detail.replyTo,
      fromEmail: conn.email,
      subject: detail.subject,
      inReplyTo: detail.inReplyTo,
      references: detail.references,
      body: emailBody,
      html,
    });
    if (!messageId) {
      return jsonResponse({ error: "Gmail rejected the message" }, 502);
    }

    // Self-improving loop: learn from an edited Auto Draft (compare to raw text,
    // not the signature-appended body).
    if (body.aiSuggestion) {
      const lastCustomer = [...detail.messages].reverse().find((m) => !m.fromUs);
      await recordCorrection(env, lastCustomer?.text || detail.subject, body.aiSuggestion, text);
    }

    // Best-effort: clear the unread flag so it drops out of the queue.
    await markThreadRead(token, threadId).catch(() => {});
    return jsonResponse({ ok: true, messageId });
  } catch (error) {
    await cerr(env, "Send email reply error:", error);
    return jsonResponse({ error: "Failed to send reply" }, 500);
  }
}

// "Jane Doe <jane@x.com>" -> "jane@x.com"; bare address -> itself; else "".
function emailFromHeader(from: string): string {
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : "";
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
