import type { Env } from "../types";

const SESSION_TIMEOUT_MS = 60_000; // 1 minute inactivity → new thread
const SESSION_TTL = 86_400; // 24 hours KV expiry

interface ThreadSession {
  threadId: string;
  lastMessageAt: number;
}

/**
 * Returns the current session's threadId for a sender, or creates a new one
 * if the session has expired (>1 min since last message).
 * New threads get a timestamp suffix so HubSpot treats them as fresh conversations.
 */
export async function getOrCreateThreadId(senderId: string, env: Env): Promise<string> {
  const key = `thread_session:${senderId}`;
  const now = Date.now();

  const raw = await env.PROFILE_CACHE.get(key);
  if (raw) {
    const session: ThreadSession = JSON.parse(raw);
    if (now - session.lastMessageAt < SESSION_TIMEOUT_MS) {
      // Session still active — reuse thread, bump timestamp
      session.lastMessageAt = now;
      await env.PROFILE_CACHE.put(key, JSON.stringify(session), { expirationTtl: SESSION_TTL });
      return session.threadId;
    }
  }

  // No session or expired — create new thread
  const session: ThreadSession = {
    threadId: `ig_${senderId}_${now}`,
    lastMessageAt: now,
  };
  await env.PROFILE_CACHE.put(key, JSON.stringify(session), { expirationTtl: SESSION_TTL });
  return session.threadId;
}
