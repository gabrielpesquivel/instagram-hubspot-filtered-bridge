import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";

// Weekly staff roster — one shared grid (rows = positions, columns = Mon–Fri),
// persisted whole in KV like the notes scratchpad. The dashboard edits cells
// in place and PUTs the full row set; last write wins, which is fine for a
// single-team sheet.

const ROSTER_KEY = "dashboard_roster";
const MAX_ROWS = 30;
const MAX_CELL = 80;

interface RosterRow {
  id: string;
  role: string;
  start: string;
  days: string[]; // exactly 5 entries, Monday..Friday
}

/** GET /api/roster — saved rows (rows: null if never saved, so the client
 *  can seed its defaults without clobbering anyone's edits). */
export async function handleGetRoster(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const cached = await env.PROFILE_CACHE.get(ROSTER_KEY);
  if (!cached) {
    return jsonResponse({ rows: null, updatedAt: null });
  }
  return new Response(cached, { headers: { "Content-Type": "application/json" } });
}

/** PUT /api/roster — replace the grid with { rows }. */
export async function handlePutRoster(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { rows?: unknown };
  try {
    body = (await request.json()) as { rows?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS) {
    return jsonResponse({ error: `rows must be an array of up to ${MAX_ROWS}` }, 400);
  }
  const clip = (v: unknown): string => String(v ?? "").slice(0, MAX_CELL);
  const rows: RosterRow[] = body.rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    const days = Array.isArray(row.days) ? row.days : [];
    return {
      id: clip(row.id) || crypto.randomUUID(),
      role: clip(row.role),
      start: clip(row.start),
      days: Array.from({ length: 5 }, (_, i) => clip(days[i])),
    };
  });
  const data = { rows, updatedAt: new Date().toISOString() };
  await env.PROFILE_CACHE.put(ROSTER_KEY, JSON.stringify(data));
  return jsonResponse(data);
}
