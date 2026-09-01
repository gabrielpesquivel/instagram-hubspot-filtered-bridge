import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { clog } from "../services/logger";

// Stock take (v1, manual): a running list of stock items with on-hand counts,
// adjusted by hand as stock arrives or ships. All state lives in one KV blob —
// one operator updates at human speed, so read-modify-write is safe. Barcode
// scanning and automatic Shopify sold-netting come later; the item shape keeps
// an optional `sku` so scans can key onto the same rows when they arrive.

const STATE_KEY = "stocktake_state";

interface StockItem {
  id: string;
  name: string;
  sku?: string;
  qty: number;       // current on-hand count
  updatedAt: string;
}

interface StockTakeState {
  startedAt: string;
  items: StockItem[];
}

async function getState(env: Env): Promise<StockTakeState> {
  const raw = await env.PROFILE_CACHE.get(STATE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as StockTakeState;
    } catch {
      // corrupt blob — fall through to a fresh state
    }
  }
  return { startedAt: new Date().toISOString(), items: [] };
}

async function putState(env: Env, state: StockTakeState): Promise<void> {
  await env.PROFILE_CACHE.put(STATE_KEY, JSON.stringify(state));
}

/** GET /api/stocktake — the full stock list. */
export async function handleGetStockTake(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const state = await getState(env);
  return jsonResponse(state);
}

/** POST /api/stocktake/item {name, sku?, qty} — add an item (or update the
 *  qty of an existing item with the same name, so re-entering doesn't dupe). */
export async function handleStockAddItem(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { name?: unknown; sku?: unknown; qty?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const name = String(body.name ?? "").trim();
  const sku = String(body.sku ?? "").trim();
  const qty = Number(body.qty ?? 0);
  if (!name) return jsonResponse({ error: "name is required" }, 400);
  if (!Number.isInteger(qty) || qty < 0 || qty > 1_000_000) {
    return jsonResponse({ error: "qty must be a non-negative integer" }, 400);
  }
  const state = await getState(env);
  const existing = state.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
  let item: StockItem;
  if (existing) {
    existing.qty = qty;
    if (sku) existing.sku = sku;
    existing.updatedAt = new Date().toISOString();
    item = existing;
  } else {
    item = {
      id: crypto.randomUUID(),
      name,
      ...(sku ? { sku } : {}),
      qty,
      updatedAt: new Date().toISOString(),
    };
    state.items.push(item);
  }
  await putState(env, state);
  return jsonResponse({ item });
}

/** POST /api/stocktake/adjust {id, delta?} or {id, qty?} — nudge a count up or
 *  down (stock in/out) or set it outright. Counts never go below zero. */
export async function handleStockAdjust(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { id?: unknown; delta?: unknown; qty?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "").trim();
  const state = await getState(env);
  const item = state.items.find((i) => i.id === id);
  if (!item) return jsonResponse({ error: "Unknown item" }, 404);

  if (body.qty !== undefined) {
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > 1_000_000) {
      return jsonResponse({ error: "qty must be a non-negative integer" }, 400);
    }
    item.qty = qty;
  } else {
    const delta = Number(body.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) {
      return jsonResponse({ error: "delta must be a non-zero integer" }, 400);
    }
    item.qty = Math.max(0, item.qty + delta);
  }
  item.updatedAt = new Date().toISOString();
  await putState(env, state);
  return jsonResponse({ item });
}

/** POST /api/stocktake/remove {id} — drop an item from the list. */
export async function handleStockRemove(request: Request, env: Env): Promise<Response> {
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
  const state = await getState(env);
  const before = state.items.length;
  state.items = state.items.filter((i) => i.id !== id);
  if (state.items.length === before) return jsonResponse({ error: "Unknown item" }, 404);
  await putState(env, state);
  return jsonResponse({ ok: true });
}

/** POST /api/stocktake/reset — clear the whole list and start fresh. */
export async function handleStockReset(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const fresh: StockTakeState = { startedAt: new Date().toISOString(), items: [] };
  await putState(env, fresh);
  await clog(env, "Stock take reset — list cleared");
  return jsonResponse(fresh);
}
