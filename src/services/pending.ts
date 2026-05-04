import type { Env } from "../types";

const KV_KEY = "pending_messages";

export interface PendingMessage {
  id: string;
  senderId: string;
  senderUsername: string;
  followerCount?: number;
  isVerified?: boolean;
  messageText: string;
  hasMedia: boolean;
  timestamp: string;
  language?: string;
}

export async function addPendingMessage(
  msg: Omit<PendingMessage, "id" | "timestamp">,
  env: Env
): Promise<PendingMessage> {
  const entry: PendingMessage = {
    ...msg,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const raw = await env.PROFILE_CACHE.get(KV_KEY);
  const messages: PendingMessage[] = raw ? JSON.parse(raw) : [];
  messages.push(entry);
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(messages));
  return entry;
}

export async function getPendingMessages(env: Env): Promise<PendingMessage[]> {
  const raw = await env.PROFILE_CACHE.get(KV_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function removePendingMessage(
  id: string,
  env: Env
): Promise<PendingMessage | null> {
  const raw = await env.PROFILE_CACHE.get(KV_KEY);
  const messages: PendingMessage[] = raw ? JSON.parse(raw) : [];
  const index = messages.findIndex((m) => m.id === id);
  if (index === -1) return null;
  const [removed] = messages.splice(index, 1);
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(messages));
  return removed;
}

export async function removePendingBySender(
  senderId: string,
  env: Env
): Promise<PendingMessage[]> {
  const raw = await env.PROFILE_CACHE.get(KV_KEY);
  const messages: PendingMessage[] = raw ? JSON.parse(raw) : [];
  const kept = messages.filter((m) => m.senderId !== senderId);
  const removed = messages.filter((m) => m.senderId === senderId);
  if (removed.length > 0) {
    await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(kept));
  }
  return removed;
}
