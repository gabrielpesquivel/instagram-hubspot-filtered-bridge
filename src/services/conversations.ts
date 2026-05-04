import type { Env, Conversation, ConversationMessage, ConversationSummary } from "../types";

const INDEX_KEY = "conversations_index";

function convKey(senderId: string): string {
  return `conv:${senderId}`;
}

export async function getConversation(
  senderId: string,
  env: Env
): Promise<Conversation | null> {
  const raw = await env.PROFILE_CACHE.get(convKey(senderId));
  if (!raw) return null;
  const conv = JSON.parse(raw) as Conversation;
  if (conv.autoReply === undefined) conv.autoReply = false;
  return conv;
}

export async function getOrCreateConversation(
  senderId: string,
  senderUsername: string,
  env: Env
): Promise<Conversation> {
  const existing = await getConversation(senderId, env);
  if (existing) return existing;

  const now = new Date().toISOString();
  const conv: Conversation = {
    senderId,
    senderUsername,
    messages: [],
    autoReply: false,
    createdAt: now,
    updatedAt: now,
  };
  await env.PROFILE_CACHE.put(convKey(senderId), JSON.stringify(conv));
  return conv;
}

export async function deleteMessage(
  senderId: string,
  messageId: string,
  env: Env
): Promise<boolean> {
  const conv = await getConversation(senderId, env);
  if (!conv) return false;

  const idx = conv.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return false;

  conv.messages.splice(idx, 1);
  await env.PROFILE_CACHE.put(convKey(senderId), JSON.stringify(conv));
  return true;
}

export async function addMessageToConversation(
  senderId: string,
  senderUsername: string,
  text: string,
  sender: "user" | "agent",
  env: Env,
  translation?: string
): Promise<ConversationMessage> {
  const conv = await getOrCreateConversation(senderId, senderUsername, env);

  const msg: ConversationMessage = {
    id: crypto.randomUUID(),
    sender,
    text,
    ...(translation ? { translation } : {}),
    timestamp: new Date().toISOString(),
  };

  conv.messages.push(msg);
  conv.updatedAt = msg.timestamp;
  await env.PROFILE_CACHE.put(convKey(senderId), JSON.stringify(conv));

  // Update index
  await updateIndex(senderId, senderUsername, text, sender === "user", env);

  return msg;
}

export async function getConversationIndex(
  env: Env
): Promise<ConversationSummary[]> {
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  return index
    .filter((s) => s.status === "active")
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}

export async function archiveConversation(
  senderId: string,
  env: Env
): Promise<boolean> {
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  const entry = index.find((s) => s.senderId === senderId);
  if (!entry) return false;

  entry.status = "archived";
  await env.PROFILE_CACHE.put(INDEX_KEY, JSON.stringify(index));
  return true;
}

export async function markConversationRead(
  senderId: string,
  env: Env
): Promise<void> {
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  const entry = index.find((s) => s.senderId === senderId);
  if (entry) {
    entry.unread = false;
    await env.PROFILE_CACHE.put(INDEX_KEY, JSON.stringify(index));
  }
}

export async function setAutoReply(
  senderId: string,
  enabled: boolean,
  env: Env
): Promise<boolean> {
  // Update conversation object
  const conv = await getConversation(senderId, env);
  if (!conv) return false;
  conv.autoReply = enabled;
  await env.PROFILE_CACHE.put(convKey(senderId), JSON.stringify(conv));

  // Update index
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  const entry = index.find((s) => s.senderId === senderId);
  if (entry) {
    entry.autoReply = enabled;
    await env.PROFILE_CACHE.put(INDEX_KEY, JSON.stringify(index));
  }
  return true;
}

export async function clearAllConversations(env: Env): Promise<number> {
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  const active = index.filter((s) => s.status === "active");

  // Delete each conversation object
  for (const entry of active) {
    await env.PROFILE_CACHE.delete(convKey(entry.senderId));
  }

  // Remove active entries from index
  const remaining = index.filter((s) => s.status !== "active");
  await env.PROFILE_CACHE.put(INDEX_KEY, JSON.stringify(remaining));

  return active.length;
}

export async function setConversationLanguage(
  senderId: string,
  language: string,
  env: Env
): Promise<void> {
  const conv = await getConversation(senderId, env);
  if (!conv) return;
  conv.language = language;
  await env.PROFILE_CACHE.put(convKey(senderId), JSON.stringify(conv));

  // Update index
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  const entry = index.find((s) => s.senderId === senderId);
  if (entry) {
    entry.language = language;
    await env.PROFILE_CACHE.put(INDEX_KEY, JSON.stringify(index));
  }
}

async function updateIndex(
  senderId: string,
  senderUsername: string,
  lastMessage: string,
  unread: boolean,
  env: Env
): Promise<void> {
  const raw = await env.PROFILE_CACHE.get(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];

  const existing = index.find((s) => s.senderId === senderId);
  const now = new Date().toISOString();

  if (existing) {
    existing.lastMessageSnippet = lastMessage.slice(0, 80);
    existing.lastMessageAt = now;
    existing.senderUsername = senderUsername;
    if (unread) existing.unread = true;
    if (existing.status === "archived") existing.status = "active";
  } else {
    index.push({
      senderId,
      senderUsername,
      lastMessageSnippet: lastMessage.slice(0, 80),
      lastMessageAt: now,
      unread,
      autoReply: false,
      status: "active",
    });
  }

  await env.PROFILE_CACHE.put(INDEX_KEY, JSON.stringify(index));
}
