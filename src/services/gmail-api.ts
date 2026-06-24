// Thin Gmail REST client (read-only). Lists unread inbox threads and parses
// their plain-text bodies for AI reply suggestions.
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

  return {
    threadId,
    subject: getHeader(thread.messages[0].payload, "Subject") || "(no subject)",
    messages,
  };
}
