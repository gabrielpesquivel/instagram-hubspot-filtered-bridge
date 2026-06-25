// Thin Gmail REST client. Lists unread inbox threads, parses their plain-text
// bodies for AI reply suggestions, sends threaded replies, and updates labels
// (mark read / archive).
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface EmailThreadSummary {
  threadId: string;
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface EmailMessage {
  from: string;
  fromUs: boolean;
  text: string;
  date: string;
}

export interface EmailThreadDetail {
  threadId: string;
  subject: string;
  messages: EmailMessage[];
  // Reply addressing, derived from the latest message in the thread.
  replyTo: string;        // raw "Name <addr>" of the customer to reply to
  inReplyTo: string;      // Message-ID header of the latest message
  references: string;     // space-joined Message-ID chain for threading
}

interface GmailPayloadPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPayloadPart;
}

async function gmailGet<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

function getHeader(payload: GmailPayloadPart | undefined, name: string): string {
  if (!payload?.headers) return "";
  const h = payload.headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function decodeB64Url(data: string): string {
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function flatten(part: GmailPayloadPart | undefined, acc: GmailPayloadPart[] = []): GmailPayloadPart[] {
  if (!part) return acc;
  acc.push(part);
  for (const p of part.parts || []) flatten(p, acc);
  return acc;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Drop quoted history so the AI only sees the new message text.
function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractBody(payload: GmailPayloadPart | undefined, snippet: string): string {
  const parts = flatten(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain?.body?.data) return stripQuoted(decodeB64Url(plain.body.data));
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html?.body?.data) return stripQuoted(stripHtml(decodeB64Url(html.body.data)));
  return snippet;
}

// "Jane Doe <jane@x.com>" -> "Jane Doe"; bare address -> the address
function parseFromName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  return (m ? m[1] : from).trim();
}

function emailAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** Unread inbox threads, newest first, deduped to one entry per thread. */
export async function listUnreadThreads(
  token: string,
  max = 25
): Promise<EmailThreadSummary[]> {
  const list = await gmailGet<{ messages?: { id: string; threadId: string }[] }>(
    `/messages?q=${encodeURIComponent("is:unread in:inbox")}&maxResults=${max}`,
    token
  );
  if (!list?.messages?.length) return [];

  const seen = new Set<string>();
  const summaries: EmailThreadSummary[] = [];
  for (const { id } of list.messages) {
    const msg = await gmailGet<GmailMessage>(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      token
    );
    if (!msg) continue;
    if (seen.has(msg.threadId)) continue;
    seen.add(msg.threadId);
    const from = getHeader(msg.payload, "From");
    summaries.push({
      threadId: msg.threadId,
      messageId: msg.id,
      from,
      fromName: parseFromName(from),
      subject: getHeader(msg.payload, "Subject") || "(no subject)",
      date: getHeader(msg.payload, "Date"),
      snippet: msg.snippet || "",
    });
  }
  return summaries;
}

/** Full thread, oldest message first, with each message tagged as ours or the
 *  customer's (by comparing the From address to the connected inbox). */
export async function getThreadDetail(
  token: string,
  threadId: string,
  connectedEmail: string
): Promise<EmailThreadDetail | null> {
  const thread = await gmailGet<{ messages?: GmailMessage[] }>(
    `/threads/${threadId}?format=full`,
    token
  );
  if (!thread?.messages?.length) return null;

  const us = connectedEmail.toLowerCase();
  const messages: EmailMessage[] = thread.messages.map((m) => {
    const from = getHeader(m.payload, "From");
    return {
      from,
      fromUs: emailAddress(from) === us,
      text: extractBody(m.payload, m.snippet || ""),
      date: getHeader(m.payload, "Date"),
    };
  });

  // Reply addressing: thread to the most recent message, address the most
  // recent message that wasn't from us (fall back to the latest message's From).
  const raw = thread.messages;
  const latest = raw[raw.length - 1];
  const lastCustomer = [...raw].reverse().find((m) => emailAddress(getHeader(m.payload, "From")) !== us);
  const replyTo =
    getHeader(lastCustomer?.payload, "Reply-To") ||
    getHeader(lastCustomer?.payload, "From") ||
    getHeader(latest.payload, "From");
  const inReplyTo = getHeader(latest.payload, "Message-ID") || getHeader(latest.payload, "Message-Id");
  const references = raw
    .map((m) => getHeader(m.payload, "Message-ID") || getHeader(m.payload, "Message-Id"))
    .filter(Boolean)
    .join(" ");

  return {
    threadId,
    subject: getHeader(thread.messages[0].payload, "Subject") || "(no subject)",
    messages,
    replyTo,
    inReplyTo,
    references,
  };
}

/** Base64url-encode raw bytes (RFC 4648 §5, no padding) for the Gmail `raw` field. */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 2047 encode a header value if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?UTF-8?B?${b64url(bytes).replace(/-/g, "+").replace(/_/g, "/")}=?=`;
}

export interface SendReplyArgs {
  threadId: string;
  to: string;
  fromEmail: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
  html?: boolean; // send as text/html (e.g. to keep an HTML Gmail signature)
}

/** The account's send-as signature (HTML) for the connected address, or "" if
 *  none. Requires the gmail.settings.basic scope. */
export async function getSendAsSignature(token: string, email: string): Promise<string> {
  const data = await gmailGet<{ sendAs?: { sendAsEmail: string; isDefault?: boolean; signature?: string }[] }>(
    "/settings/sendAs",
    token
  );
  const list = data?.sendAs || [];
  const match =
    list.find((s) => s.sendAsEmail.toLowerCase() === email.toLowerCase()) ||
    list.find((s) => s.isDefault) ||
    list[0];
  return match?.signature || "";
}

/** Send a plain-text reply into an existing thread. Returns the new message id
 *  on success, or null on failure. */
export async function sendThreadReply(token: string, args: SendReplyArgs): Promise<string | null> {
  const subject = /^re:/i.test(args.subject.trim()) ? args.subject : `Re: ${args.subject}`;
  const headers = [
    `From: ${args.fromEmail}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: text/${args.html ? "html" : "plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: 8bit",
  ];
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);
  const mime = headers.join("\r\n") + "\r\n\r\n" + args.body;
  const raw = b64url(new TextEncoder().encode(mime));

  const res = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, threadId: args.threadId }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: string };
  return data.id || null;
}

/** Mark a thread read (remove the UNREAD label). Best-effort. */
export async function markThreadRead(token: string, threadId: string): Promise<boolean> {
  return modifyThread(token, threadId, { removeLabelIds: ["UNREAD"] });
}

/** Archive a thread (remove it from the inbox). Best-effort. */
export async function archiveThread(token: string, threadId: string): Promise<boolean> {
  return modifyThread(token, threadId, { removeLabelIds: ["INBOX"] });
}

async function modifyThread(
  token: string,
  threadId: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<boolean> {
  const res = await fetch(`${GMAIL_BASE}/threads/${threadId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
