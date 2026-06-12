import type { Env } from "../types";
import { getDMState } from "../dm-state";

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

// All mutations go through the DMState Durable Object so concurrent webhooks
// can't clobber each other (the old KV read-modify-write lost messages).

export async function addPendingMessage(
  msg: Omit<PendingMessage, "id" | "timestamp">,
  env: Env
): Promise<PendingMessage> {
  return getDMState(env).addPending(msg);
}

export async function getPendingMessages(env: Env): Promise<PendingMessage[]> {
  return getDMState(env).listPending();
}

export async function removePendingMessage(
  id: string,
  env: Env
): Promise<PendingMessage | null> {
  return getDMState(env).removePending(id);
}

export async function removePendingBySender(
  senderId: string,
  env: Env
): Promise<PendingMessage[]> {
  return getDMState(env).removePendingBySender(senderId);
}

export async function clearPendingMessages(env: Env): Promise<number> {
  return getDMState(env).clearPending();
}
