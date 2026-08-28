import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";

// Free-form scratchpad for the home page. One shared note, persisted in KV
// with no TTL, so it survives across days, browsers and devices.

const NOTES_KEY = "dashboard_notes";

// KV values cap at 25 MB, but a scratchpad should never get near that —
// reject absurd payloads so a runaway client can't bloat the namespace.
const MAX_LENGTH = 100_000;

interface Notes {
  text: string;
  updatedAt: string;
}

/** GET /api/notes — the saved note ("" if never saved). */
export async function handleGetNotes(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const cached = await env.PROFILE_CACHE.get(NOTES_KEY);
  if (!cached) {
    return jsonResponse({ text: "", updatedAt: null });
  }
  return new Response(cached, { headers: { "Content-Type": "application/json" } });
}

/** PUT /api/notes — replace the note with { text }. */
export async function handlePutNotes(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.text !== "string") {
    return jsonResponse({ error: "text must be a string" }, 400);
  }
  if (body.text.length > MAX_LENGTH) {
    return jsonResponse({ error: `text must be under ${MAX_LENGTH} characters` }, 400);
  }
  const data: Notes = { text: body.text, updatedAt: new Date().toISOString() };
  await env.PROFILE_CACHE.put(NOTES_KEY, JSON.stringify(data));
  return jsonResponse(data);
}
