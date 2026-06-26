import type { Env } from "../types";
import { cerr } from "./logger";
import { getConnection, getPageAccessToken } from "./facebook-oauth";

// Pull-based access to Instagram DMs via the Graph Conversations API — the
// counterpart to the webhook push. Lets the inbox poll the live unread state
// (immune to webhook-delivery gaps) the same way the email side polls Gmail.
const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

export interface IgConversationSummary {
  conversationId: string;
  senderId: string;
  username: string;
  snippet: string;
  updatedTime: string;
  unread: boolean;
}

export interface IgThreadMessage {
  fromUs: boolean;
  text: string;
  date: string;
}

export interface IgThreadDetail {
  conversationId: string;
  senderId: string;
  username: string;
  messages: IgThreadMessage[];
}

interface GraphParticipant {
  username?: string;
  id: string;
}
interface GraphMessage {
  id?: string;
  message?: string;
  created_time?: string;
  from?: GraphParticipant;
}
interface GraphConversation {
  id: string;
  updated_time?: string;
  unread_count?: number;
  participants?: { data?: GraphParticipant[] };
  messages?: { data?: GraphMessage[] };
}

/** Identify which participant id/username is us (the connected IG business). */
async function getSelf(env: Env): Promise<{ id: string; username: string }> {
  const conn = await getConnection(env);
  return {
    id: conn?.instagram_business_account_id || "",
    username: (conn?.instagram_username || "").toLowerCase(),
  };
}

function isUs(p: GraphParticipant | undefined, self: { id: string; username: string }): boolean {
  if (!p) return false;
  return p.id === self.id || (!!p.username && p.username.toLowerCase() === self.username);
}

/** List Instagram conversations (newest first) with their last-message snippet
 *  and unread flag. Returns `null` on a transient Graph failure (rate limit,
 *  5xx, network) so callers can keep the previous list instead of flashing it
 *  empty; returns `[]` only when the account genuinely has no conversations. */
export async function listInstagramConversations(env: Env): Promise<IgConversationSummary[] | null> {
  const conn = await getConnection(env);
  if (!conn) return [];
  const token = await getPageAccessToken(env);
  const self = await getSelf(env);

  // Keep the request cheap — Graph rejects ("code 1: reduce the amount of data")
  // when you expand the last message of an unbounded number of conversations.
  // Cap the page and request only the subfields we render.
  const fields =
    "unread_count,updated_time,participants{username,id},messages.limit(1){message,from}";
  const url = `${GRAPH_API_BASE}/${conn.facebook_page_id}/conversations?platform=instagram&fields=${encodeURIComponent(
    fields
  )}&limit=20&access_token=${token}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      await cerr(env, `IG conversations fetch failed: HTTP ${res.status}`, await res.text());
      return null;
    }
    const data = (await res.json()) as { data?: GraphConversation[] };
    const out: IgConversationSummary[] = [];
    for (const conv of data.data || []) {
      const participants = conv.participants?.data || [];
      const customer = participants.find((p) => !isUs(p, self)) || participants[0];
      if (!customer) continue;
      const last = conv.messages?.data?.[0];
      out.push({
        conversationId: conv.id,
        senderId: customer.id,
        username: customer.username || customer.id,
        snippet: last?.message || "",
        updatedTime: conv.updated_time || last?.created_time || "",
        unread: (conv.unread_count || 0) > 0,
      });
    }
    return out;
  } catch (error) {
    await cerr(env, "IG conversations fetch error:", error);
    return null;
  }
}

/** Full message history for one conversation, oldest message first. */
export async function getInstagramThreadMessages(
  env: Env,
  conversationId: string
): Promise<IgThreadDetail | null> {
  const token = await getPageAccessToken(env);
  const self = await getSelf(env);

  const url = `${GRAPH_API_BASE}/${conversationId}?fields=${encodeURIComponent(
    "messages{message,from,created_time}"
  )}&access_token=${token}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      await cerr(env, `IG thread fetch failed: HTTP ${res.status}`, await res.text());
      return null;
    }
    const data = (await res.json()) as { messages?: { data?: GraphMessage[] } };
    // Graph returns newest-first; reverse for chat display.
    const raw = [...(data.messages?.data || [])].reverse();
    const messages: IgThreadMessage[] = raw
      .filter((m) => m.message)
      .map((m) => ({
        fromUs: isUs(m.from, self),
        text: m.message || "",
        date: m.created_time || "",
      }));
    const customerMsg = raw.find((m) => !isUs(m.from, self));
    return {
      conversationId,
      senderId: customerMsg?.from?.id || "",
      username: customerMsg?.from?.username || "",
      messages,
    };
  } catch (error) {
    await cerr(env, "IG thread fetch error:", error);
    return null;
  }
}
