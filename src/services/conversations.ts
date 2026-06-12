import type { Env, Conversation, ConversationMessage, ConversationSummary } from "../types";
import { getDMState } from "../dm-state";

// All conversation state lives in the DMState Durable Object — mutations are
// serialized there, so message/index updates can't race.

export async function getConversation(
  senderId: string,
  env: Env
): Promise<Conversation | null> {
  return getDMState(env).getConversation(senderId);
}

export async function deleteMessage(
  senderId: string,
  messageId: string,
  env: Env
): Promise<boolean> {
  return getDMState(env).deleteMessage(senderId, messageId);
}

export async function addMessageToConversation(
  senderId: string,
  senderUsername: string,
  text: string,
  sender: "user" | "agent",
  env: Env,
  translation?: string,
  status?: "sent" | "failed"
): Promise<ConversationMessage> {
  return getDMState(env).addMessage(senderId, senderUsername, text, sender, translation, status);
}

export async function setMessageStatus(
  senderId: string,
  messageId: string,
  status: "sent" | "failed",
  env: Env
): Promise<boolean> {
  return getDMState(env).setMessageStatus(senderId, messageId, status);
}

export async function getConversationIndex(
  env: Env
): Promise<ConversationSummary[]> {
  return getDMState(env).listConversations();
}

export async function archiveConversation(
  senderId: string,
  env: Env
): Promise<boolean> {
  return getDMState(env).archiveConversation(senderId);
}

export async function markConversationRead(
  senderId: string,
  env: Env
): Promise<void> {
  return getDMState(env).markConversationRead(senderId);
}

export async function setAutoReply(
  senderId: string,
  enabled: boolean,
  env: Env
): Promise<boolean> {
  return getDMState(env).setAutoReply(senderId, enabled);
}

export async function clearAllConversations(env: Env): Promise<number> {
  return getDMState(env).clearAllConversations();
}

export async function setConversationLanguage(
  senderId: string,
  language: string,
  env: Env
): Promise<void> {
  return getDMState(env).setConversationLanguage(senderId, language);
}
