import type { Env } from "../types";
import { clog, cerr } from "../services/logger";
import { getGoogleConnection, getValidGoogleToken } from "../services/google-oauth";
import { listUnreadThreads } from "../services/gmail-api";
import { buildEmailSuggestion } from "./email";
import type { ActionProposal } from "../services/gemini-api";

// Pre-draft AI replies for unread emails so the agent opens a thread with the
// reply already sitting in the composer (approve/edit/send instead of waiting
// on generation). Runs from the */10 cron; drafts live in KV keyed by thread.

export interface StoredDraft {
  suggestion: string;
  actions: ActionProposal[];
  threadDate: string; // thread list `date` at draft time — regenerate when it moves
  draftedAt: string;
  skipped?: boolean;  // thread had nothing to reply to; don't retry every sweep
}

const draftKey = (threadId: string) => `email_draft:${threadId}`;
const DRAFT_TTL = 7 * 24 * 3600; // threads older than this are long out of the unread queue
const MAX_PER_RUN = 5;           // bound Gemini spend per sweep; backlog clears across sweeps

export async function getStoredDraft(env: Env, threadId: string): Promise<StoredDraft | null> {
  const raw = await env.PROFILE_CACHE.get(draftKey(threadId));
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as StoredDraft;
    return draft.skipped ? null : draft;
  } catch {
    return null;
  }
}

/** Drop a stored draft (called after the agent sends a reply so a reopened
 *  thread doesn't prefill a stale draft). */
export async function clearStoredDraft(env: Env, threadId: string): Promise<void> {
  await env.PROFILE_CACHE.delete(draftKey(threadId));
}

/** Cron sweep: draft replies for unread threads that have none yet, and
 *  re-draft when the thread has new messages (its list `date` moved). */
export async function autoDraftEmails(env: Env): Promise<void> {
  if (!env.GEMINI_API_KEY) return;
  const conn = await getGoogleConnection(env);
  const token = await getValidGoogleToken(env);
  if (!conn || !token) return;

  try {
    const threads = await listUnreadThreads(token);
    let drafted = 0;
    for (const t of threads) {
      if (drafted >= MAX_PER_RUN) break;
      const raw = await env.PROFILE_CACHE.get(draftKey(t.threadId));
      if (raw) {
        try {
          const existing = JSON.parse(raw) as StoredDraft;
          if (existing.threadDate === t.date) continue; // current — nothing to do
        } catch {
          // corrupt entry — fall through and regenerate
        }
      }
      try {
        const result = await buildEmailSuggestion(env, token, conn.email, t.threadId);
        const stored: StoredDraft = result
          ? {
              suggestion: result.suggestion,
              actions: result.actions,
              threadDate: t.date,
              draftedAt: new Date().toISOString(),
            }
          : { suggestion: "", actions: [], threadDate: t.date, draftedAt: new Date().toISOString(), skipped: true };
        await env.PROFILE_CACHE.put(draftKey(t.threadId), JSON.stringify(stored), {
          expirationTtl: DRAFT_TTL,
        });
        if (result) drafted++;
      } catch (error) {
        // One bad thread (Gemini hiccup, weird MIME) must not stall the sweep.
        await cerr(env, `Auto-draft failed for thread ${t.threadId}:`, error);
      }
    }
    if (drafted > 0) {
      await clog(env, `Auto-drafted ${drafted} email ${drafted === 1 ? "reply" : "replies"}`);
    }
  } catch (error) {
    await cerr(env, "Auto-draft sweep error:", error);
  }
}
