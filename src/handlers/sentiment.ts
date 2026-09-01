import type { Env, Conversation } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { getDMState } from "../dm-state";
import { getValidGoogleToken } from "../services/google-oauth";
import { listUnreadThreads } from "../services/gmail-api";
import { getGeminiSettings } from "../services/gemini-api";
import { clog } from "../services/logger";

// Customer sentiment: a continuously-built log of recurring customer problems.
// Every 10 minutes (same cron as the email auto-draft sweep) new IG DMs and
// support emails are scanned once, and concrete complaints are merged into a
// persistent issue list — "United Kingdom: orders not arriving" — that grows
// over time. Issues are location-tagged, accumulate mentions, and can be
// marked resolved with a note; if the same problem comes back later the issue
// REOPENS with its resolution history intact. No scores, no ratings.

const ISSUES_KEY = "sentiment_issues";
const SCANLOG_KEY = "sentiment_scanlog";
const CURSOR_KEY = "sentiment_cursor";

const MAX_MESSAGES_PER_SCAN = 40; // bound the Gemini prompt
const MAX_MENTION_EXAMPLES = 50;  // quotes kept per issue (count is separate)
const MAX_SCANLOG = 100;
const MAX_SEEN_IDS = 800;         // dedupe window across scans

interface Mention {
  at: string;
  source: "instagram" | "email";
  name: string;
  quote: string;
}

interface ResolutionRecord {
  resolvedAt: string;
  note: string;
}

export interface SentimentIssue {
  id: string;
  location: string;
  problem: string;
  status: "open" | "resolved";
  mentionCount: number;
  mentions: Mention[]; // most recent examples, capped
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
  reopenedAt?: string;
  resolutionHistory: ResolutionRecord[];
}

interface ScanLogEntry {
  at: string;
  source: "instagram" | "email";
  name: string;
  snippet: string;
  loggedIssue: boolean; // did this message land in an issue?
}

interface Cursor {
  lastScanAt: string | null;
  seenIds: string[];
  // True once the initial history backfill has drained. After that, only
  // recent messages are considered — so old ids evicted from the (capped)
  // seen window can never be re-ingested as duplicates.
  backfillDone?: boolean;
}

const RECENT_WINDOW_MS = 3 * 24 * 3600_000; // post-backfill look-back

// One new, not-yet-scanned customer message.
interface NewMessage {
  id: string; // stable dedupe id
  source: "instagram" | "email";
  name: string;
  text: string;
  at: string;
}

async function kvJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  return ((await env.PROFILE_CACHE.get(key, "json")) as T | null) ?? fallback;
}

export async function getIssues(env: Env): Promise<SentimentIssue[]> {
  return kvJson<SentimentIssue[]>(env, ISSUES_KEY, []);
}

async function putIssues(env: Env, issues: SentimentIssue[]): Promise<void> {
  await env.PROFILE_CACHE.put(ISSUES_KEY, JSON.stringify(issues));
}

// ── Collecting new messages ──────────────────────────────────────────────────

async function collectNewMessages(env: Env, cursor: Cursor): Promise<NewMessage[]> {
  const seen = new Set(cursor.seenIds);
  const cutoff = cursor.backfillDone ? Date.now() - RECENT_WINDOW_MS : 0;
  const fresh = (at: string) => (Date.parse(at) || 0) >= cutoff;
  const out: NewMessage[] = [];

  // Instagram: customer messages from stored conversations, newest window.
  try {
    const state = getDMState(env);
    const summaries = await state.listConversations();
    for (const s of summaries.slice(0, 40)) {
      const convo: Conversation | null = await state.getConversation(s.senderId).catch(() => null);
      if (!convo) continue;
      for (const m of convo.messages) {
        if (m.sender !== "user") continue;
        const id = `ig:${m.id}`;
        if (seen.has(id) || !fresh(m.timestamp)) continue;
        const text = (m.translation || m.text || "").trim();
        if (!text) continue;
        out.push({
          id,
          source: "instagram",
          name: convo.senderUsername || convo.senderId,
          text,
          at: m.timestamp,
        });
      }
    }
  } catch {
    // IG unavailable this pass — emails still scan
  }

  // Email: unread inbox threads (subject + snippet is enough to spot a complaint).
  try {
    const token = await getValidGoogleToken(env);
    if (token) {
      for (const t of await listUnreadThreads(token)) {
        const id = `em:${t.messageId}`;
        if (seen.has(id) || !fresh(t.date)) continue;
        out.push({
          id,
          source: "email",
          name: t.fromName || t.from,
          text: `Subject: ${t.subject}\n${t.snippet}`,
          at: t.date,
        });
      }
    }
  } catch {
    // Gmail unavailable this pass
  }

  // Oldest first so mention timestamps read naturally; bound the batch (the
  // rest is picked up next sweep since we only mark scanned ids as seen).
  out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return out.slice(0, MAX_MESSAGES_PER_SCAN);
}

// ── Gemini: match complaints to issues ───────────────────────────────────────

interface GeminiVerdict {
  index: number;
  complaint: boolean;
  issueId?: string;              // existing issue (open or resolved → reopen)
  location?: string;             // for a new issue
  problem?: string;              // for a new issue
  quote?: string;
}

async function judgeMessages(
  env: Env,
  issues: SentimentIssue[],
  messages: NewMessage[]
): Promise<GeminiVerdict[] | null> {
  if (!env.GEMINI_API_KEY) return null;
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;

  const issueList = issues
    .map((i) => `- id:${i.id} [${i.status}] ${i.location}: ${i.problem}`)
    .join("\n");
  const numbered = messages
    .map((m, idx) => `[${idx}] (${m.source}) ${m.name}:\n${m.text.slice(0, 900)}`)
    .join("\n\n---\n\n");

  const instruction = `You maintain the customer-problem log for BootInk, an Australian store selling custom transfers for personalising football boots (ships worldwide from Australia). Below are NEW customer messages from Instagram DMs and support emails, each numbered, plus the EXISTING issue log.

For each message decide:
1. Is it a CONCRETE COMPLAINT or problem report (order not arriving, customs trouble, shipping too expensive, damaged item, wrong item, website broken, refund trouble, etc.)? Routine questions (price, how-to, shipping availability), praise, and small talk are NOT complaints → complaint: false.
2. If it IS a complaint, infer the customer's LOCATION from any signal (countries/cities mentioned, currency, shipping destination, postcode, language). Use the most specific supported location; "Unknown" when there is no signal — never guess.
3. Match it to an existing issue whenever it describes the SAME UNDERLYING PROBLEM in the same or an overlapping place — "order never arrived" from Manchester belongs to an existing "United Kingdom: orders not arriving" issue, not a new one (match resolved issues too — that flags the problem has come back). Only create a new issue when no existing issue covers the problem; give it a specific one-sentence problem statement, e.g. "Orders taking 3+ weeks and customers say they never arrive". Do not invent vague issues like "general dissatisfaction".

Reply with ONLY a JSON array, one entry per numbered message:
[
  { "index": 0, "complaint": false },
  { "index": 1, "complaint": true, "issueId": "<id of matching existing issue>", "quote": "<short verbatim customer quote>" },
  { "index": 2, "complaint": true, "location": "<country or city>", "problem": "<one specific sentence>", "quote": "<short verbatim quote>" }
]`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: instruction }] },
        contents: [
          {
            role: "user",
            parts: [{ text: `EXISTING ISSUES:\n${issueList || "(none yet)"}\n\nNEW MESSAGES:\n${numbered}` }],
          },
        ],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1, responseMimeType: "application/json" },
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GeminiVerdict[]) : null;
  } catch {
    return null;
  }
}

// ── Consolidation: fold near-duplicate issues into one ───────────────────────
// The per-message matcher occasionally opens a second issue for a problem that
// already exists (different wording, city vs country). After a sweep that
// logged anything, ask the model which OPEN issues describe the same underlying
// problem and merge them — evidence (mentions) is combined, counts are summed.

interface MergeGroup {
  keepId: string;
  mergeIds: string[];
  location?: string; // optional cleaned-up combined labels
  problem?: string;
}

async function consolidateIssues(env: Env, issues: SentimentIssue[]): Promise<SentimentIssue[]> {
  const open = issues.filter((i) => i.status === "open");
  if (open.length < 2 || !env.GEMINI_API_KEY) return issues;
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;

  const list = open.map((i) => `- id:${i.id} ${i.location}: ${i.problem}`).join("\n");
  const instruction = `You maintain a customer-problem log. Below are the OPEN issues. Identify groups that describe the SAME underlying problem in the same or overlapping places (e.g. "Manchester: order never arrived" + "United Kingdom: orders not arriving" are one issue; "Australia: shipping too expensive" and "UK: orders not arriving" are NOT). For each group pick the issue to keep and optionally give a combined location (prefer the broader place) and a single clear problem sentence.

Reply with ONLY a JSON array (empty array if nothing should merge):
[ { "keepId": "<id>", "mergeIds": ["<id>", ...], "location": "<combined location>", "problem": "<combined problem sentence>" } ]`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text: list }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.1, responseMimeType: "application/json" },
      }),
    });
    if (!response.ok) return issues;
    const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return issues;
    const groups = JSON.parse(raw) as MergeGroup[];
    if (!Array.isArray(groups)) return issues;

    const remove = new Set<string>();
    for (const g of groups) {
      const keep = issues.find((i) => i.id === g.keepId && i.status === "open");
      if (!keep) continue;
      for (const mid of g.mergeIds || []) {
        if (mid === keep.id || remove.has(mid)) continue;
        const src = issues.find((i) => i.id === mid && i.status === "open");
        if (!src) continue;
        keep.mentionCount += src.mentionCount;
        keep.mentions = [...keep.mentions, ...src.mentions]
          .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
          .slice(-MAX_MENTION_EXAMPLES);
        if ((Date.parse(src.firstSeenAt) || Infinity) < (Date.parse(keep.firstSeenAt) || Infinity)) {
          keep.firstSeenAt = src.firstSeenAt;
        }
        if ((Date.parse(src.lastSeenAt) || 0) > (Date.parse(keep.lastSeenAt) || 0)) {
          keep.lastSeenAt = src.lastSeenAt;
        }
        keep.resolutionHistory = [...keep.resolutionHistory, ...src.resolutionHistory];
        remove.add(mid);
      }
      if (g.location) keep.location = String(g.location).slice(0, 60);
      if (g.problem) keep.problem = String(g.problem).slice(0, 300);
    }
    return remove.size ? issues.filter((i) => !remove.has(i.id)) : issues;
  } catch {
    return issues;
  }
}

// ── The scan itself (cron + manual) ──────────────────────────────────────────

export async function scanSentiment(env: Env): Promise<{ scanned: number; logged: number }> {
  const cursor = await kvJson<Cursor>(env, CURSOR_KEY, { lastScanAt: null, seenIds: [] });
  const messages = await collectNewMessages(env, cursor);
  const now = new Date().toISOString();

  if (messages.length === 0) {
    // Nothing left to scan — any initial backfill has drained.
    await env.PROFILE_CACHE.put(
      CURSOR_KEY,
      JSON.stringify({ ...cursor, lastScanAt: now, backfillDone: true })
    );
    return { scanned: 0, logged: 0 };
  }

  const issues = await getIssues(env);
  const verdicts = await judgeMessages(env, issues, messages);
  if (!verdicts) {
    // Gemini failed — leave messages unseen so the next sweep retries them.
    await env.PROFILE_CACHE.put(CURSOR_KEY, JSON.stringify({ ...cursor, lastScanAt: now }));
    return { scanned: 0, logged: 0 };
  }

  const byIndex = new Map(verdicts.filter((v) => Number.isInteger(v.index)).map((v) => [v.index, v]));
  let logged = 0;
  const scanEntries: ScanLogEntry[] = [];

  messages.forEach((m, idx) => {
    const v = byIndex.get(idx);
    const isComplaint = !!v?.complaint;
    scanEntries.push({
      at: m.at,
      source: m.source,
      name: m.name,
      snippet: m.text.replace(/\s+/g, " ").slice(0, 120),
      loggedIssue: isComplaint,
    });
    if (!v || !isComplaint) return;

    const mention: Mention = {
      at: m.at,
      source: m.source,
      name: m.name,
      quote: String(v.quote || m.text).slice(0, 200),
    };

    let issue = v.issueId ? issues.find((i) => i.id === v.issueId) : undefined;
    if (issue) {
      if (issue.status === "resolved") {
        // The problem is back — reopen, keeping the fix history.
        issue.status = "open";
        issue.reopenedAt = now;
      }
    } else if (v.problem) {
      issue = {
        id: crypto.randomUUID().slice(0, 8),
        location: String(v.location || "Unknown").slice(0, 60),
        problem: String(v.problem).slice(0, 300),
        status: "open",
        mentionCount: 0,
        mentions: [],
        firstSeenAt: m.at,
        lastSeenAt: m.at,
        resolutionHistory: [],
      };
      issues.push(issue);
    } else {
      return; // complaint but no usable issue — skip
    }

    issue.mentionCount++;
    issue.mentions = [...issue.mentions, mention].slice(-MAX_MENTION_EXAMPLES);
    if ((Date.parse(m.at) || 0) > (Date.parse(issue.lastSeenAt) || 0)) issue.lastSeenAt = m.at;
    logged++;
  });

  await putIssues(env, logged > 0 ? await consolidateIssues(env, issues) : issues);

  const scanlog = await kvJson<ScanLogEntry[]>(env, SCANLOG_KEY, []);
  await env.PROFILE_CACHE.put(
    SCANLOG_KEY,
    JSON.stringify([...scanlog, ...scanEntries].slice(-MAX_SCANLOG))
  );

  // Only messages actually judged become "seen"; anything beyond the batch cap
  // stays unscanned and is picked up next sweep. A full batch means there may
  // be more backlog, so the backfill stays open until a sweep comes up short.
  const seenIds = [...cursor.seenIds, ...messages.map((m) => m.id)].slice(-MAX_SEEN_IDS);
  const backfillDone = cursor.backfillDone || messages.length < MAX_MESSAGES_PER_SCAN;
  await env.PROFILE_CACHE.put(CURSOR_KEY, JSON.stringify({ lastScanAt: now, seenIds, backfillDone }));

  if (logged > 0) await clog(env, `Sentiment scan: ${messages.length} messages, ${logged} complaint(s) logged`);
  return { scanned: messages.length, logged };
}

// ── API handlers ─────────────────────────────────────────────────────────────

/** GET /api/sentiment — the full issue log + recent scan feed. */
export async function handleGetSentiment(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const [issues, scanlog, cursor] = await Promise.all([
    getIssues(env),
    kvJson<ScanLogEntry[]>(env, SCANLOG_KEY, []),
    kvJson<Cursor>(env, CURSOR_KEY, { lastScanAt: null, seenIds: [] }),
  ]);
  return jsonResponse({
    issues: issues.sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "")),
    scanlog: [...scanlog].reverse(), // newest first for the feed
    lastScanAt: cursor.lastScanAt,
  });
}

/** POST /api/sentiment/scan — run a sweep now instead of waiting for the cron.
 *  Unlike the cron, the manual scan ALWAYS runs a consolidation pass afterwards,
 *  so it doubles as a "merge my duplicate issues" button. */
export async function handleSentimentScan(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const result = await scanSentiment(env);
  const before = await getIssues(env);
  const after = await consolidateIssues(env, before);
  if (after.length !== before.length) await putIssues(env, after);
  return jsonResponse({ ...result, merged: before.length - after.length });
}

/** POST /api/sentiment/resolve {id, note} — close an issue with what you did. */
export async function handleSentimentResolve(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { id?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "").trim();
  const note = String(body.note ?? "").trim();
  if (!id || !note) return jsonResponse({ error: "id and a resolution note are required" }, 400);

  const issues = await getIssues(env);
  const issue = issues.find((i) => i.id === id);
  if (!issue) return jsonResponse({ error: "Unknown issue" }, 404);
  const resolvedAt = new Date().toISOString();
  issue.status = "resolved";
  issue.resolvedAt = resolvedAt;
  issue.resolutionNote = note.slice(0, 500);
  issue.resolutionHistory = [...issue.resolutionHistory, { resolvedAt, note: note.slice(0, 500) }];
  await putIssues(env, issues);
  return jsonResponse({ issue });
}

/** POST /api/sentiment/reopen {id} — manually reopen a resolved issue. */
export async function handleSentimentReopen(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "").trim();
  const issues = await getIssues(env);
  const issue = issues.find((i) => i.id === id);
  if (!issue) return jsonResponse({ error: "Unknown issue" }, 404);
  issue.status = "open";
  issue.reopenedAt = new Date().toISOString();
  await putIssues(env, issues);
  return jsonResponse({ issue });
}

/** POST /api/sentiment/dismiss {id} — delete a mis-detected issue entirely. */
export async function handleSentimentDismiss(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "").trim();
  const issues = await getIssues(env);
  const remaining = issues.filter((i) => i.id !== id);
  if (remaining.length === issues.length) return jsonResponse({ error: "Unknown issue" }, 404);
  await putIssues(env, remaining);
  return jsonResponse({ ok: true });
}
