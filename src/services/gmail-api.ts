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

export interface EmailImage {
  id: string;              // stable per-message id (attachmentId or inline-N) — label key
  messageId: string;       // Gmail message id the attachment belongs to
  mimeType: string;        // image/png, image/jpeg, …
  filename: string;
  attachmentId?: string;   // fetch via getAttachment (large/normal attachments)
  dataUrl?: string;        // inline base64 (tiny embedded images)
  label?: string;          // agent-supplied description, fed to the AI on draft
}

export interface EmailMessage {
  from: string;
  fromUs: boolean;
  text: string;
  date: string;
  images: EmailImage[];
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
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
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

// Quoted history always sits at the bottom of an email, so truncating the HTML
// at the first quote/forward container drops the whole reply chain (and any
// nested quotes) without fragile end-tag matching.
function cutHtmlAtQuote(html: string): string {
  const markers = [
    /<blockquote/i,
    /<div[^>]+class="?gmail_quote/i,           // Gmail
    /<div[^>]+id="?(?:divRplyFwdMsg|appendonsend)/i, // Outlook reply/forward
    /<hr[^>]+id="?stopSpelling/i,              // Outlook separator
  ];
  let cut = html.length;
  for (const re of markers) {
    const m = html.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return html.slice(0, cut);
}

// Drop quoted history AND signature blocks so the thread view and the AI only
// see the actual new message. Cuts at the first line that begins the reply
// chain, the standard "-- " signature delimiter, or a mobile/footer trailer.
function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next3 = lines.slice(i + 1, i + 4).join("\n");
    // Quoted reply chain.
    if (/^\s*>/.test(line)) break;
    if (/^\s*On\b.*\bwrote:\s*$/.test(line)) break;             // Gmail one-line attribution
    if (/^\s*On\b.+@.+$/.test(line) && /wrote:\s*$/.test(lines[i + 1] || "")) break; // wrapped attribution
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*_{5,}\s*$/.test(line)) break;
    if (/^\s*From:\s.+$/.test(line) && /^\s*(Sent|To|Subject|Date):/m.test(next3)) break; // Outlook header block
    // Signatures & footers.
    if (/^--\s*$/.test(line)) break;                            // RFC 3676 signature delimiter
    if (/^\s*Sent from my \w+/i.test(line)) break;
    if (/^\s*Get Outlook for /i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractBody(payload: GmailPayloadPart | undefined, snippet: string): string {
  const parts = flatten(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain?.body?.data) return stripQuoted(decodeB64Url(plain.body.data));
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html?.body?.data) return stripQuoted(stripHtml(cutHtmlAtQuote(decodeB64Url(html.body.data))));
  return snippet;
}

// Collect image attachments (and tiny inline images) on a message so the thread
// view can show photos customers send. Normal attachments expose an
// attachmentId fetched lazily; small embedded ones carry their bytes inline.
function collectImages(payload: GmailPayloadPart | undefined, messageId: string): EmailImage[] {
  const out: EmailImage[] = [];
  let n = 0;
  for (const p of flatten(payload)) {
    if (!p.mimeType?.startsWith("image/")) continue;
    n++;
    const filename = p.filename || `image-${n}`;
    if (p.body?.attachmentId) {
      out.push({ id: p.body.attachmentId, messageId, mimeType: p.mimeType, filename, attachmentId: p.body.attachmentId });
    } else if (p.body?.data) {
      const b64 = p.body.data.replace(/-/g, "+").replace(/_/g, "/");
      out.push({ id: `inline-${n}`, messageId, mimeType: p.mimeType, filename, dataUrl: `data:${p.mimeType};base64,${b64}` });
    }
  }
  return out;
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
      images: collectImages(m.payload, m.id),
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
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `=?UTF-8?B?${btoa(bin)}?=`;
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

/** Fetch one attachment's raw bytes, or null if it can't be read. */
export async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string
): Promise<Uint8Array | null> {
  const data = await gmailGet<{ data?: string }>(
    `/messages/${messageId}/attachments/${attachmentId}`,
    token
  );
  if (!data?.data) return null;
  try {
    const bin = atob(data.data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
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
