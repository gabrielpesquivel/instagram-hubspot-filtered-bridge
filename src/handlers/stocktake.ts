import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import {
  fetchOrderConsumptionStats,
  type OrderConsumptionStats,
  type DailyConsumption,
} from "../services/shopify-api";
import { clog } from "../services/logger";

// Stock View: BootInk prints on demand, so the only stock is consumables.
// A FIXED catalog (below) carries each item's counted stock, lead time, and
// how it's consumed; weekly order volume from Shopify turns that into a
// runout projection, compared against the item's lead time to flag reorders.
//
// Usage rules (per the ops spec):
//   per ORDER: 1 transfer bag, 1 wipes bag, 1 box, 1 box sleeve,
//              1 shipping sleeve, 1 shipping label
//   per UNIT:  ink (bottles) and film A/B (rolls) at a configurable rate
//   wipes:     ceil(units-in-order / 2), summed per order server-side
//
// Counts are LIVE: a count is a baseline (qty at countedAt); the effective
// on-hand shown everywhere is baseline minus what the orders since then have
// consumed, so the number keeps ticking down between counts.
//
// Demand spikes: projections use the hotter of the 7-day and 28-day run
// rates (when the last week is >25% above the monthly average), so a surge
// pulls runout dates forward instead of hiding in the average.
//
// On-order: marking an item ordered (with optional ETA/qty) quiets its
// reorder alert; a receive/scan clears it. An ETA in the past flags
// "order overdue" — placed but never arrived.

const STATE_KEY = "stockview_state";
const STATS_CACHE_KEY = "stockview_orderstats_v2"; // v2: pre-fix truncated stats poisoned v1
const STATS_CACHE_TTL = 3600; // recompute volume at most hourly
const STATS_WINDOW_DAYS = 28; // trailing window for the base rate
const REORDER_BUFFER_DAYS = 7; // "order soon" margin on top of lead time
const SPIKE_THRESHOLD = 1.25; // 7d rate must beat 28d rate by 25% to count

type UsageKind = "perOrder" | "perUnit" | "wipes";

interface CatalogEntry {
  id: string;
  name: string;
  unit: string; // what one count means: bottles, rolls, bags, …
  usage: UsageKind;
}

const CATALOG: CatalogEntry[] = [
  { id: "ink", name: "Ink", unit: "bottles", usage: "perUnit" },
  { id: "film_a", name: "Film roll A", unit: "rolls", usage: "perUnit" },
  { id: "film_b", name: "Film roll B", unit: "rolls", usage: "perUnit" },
  { id: "transfer_bags", name: "Transfer zip lock bags", unit: "bags", usage: "perOrder" },
  { id: "wipes_bags", name: "Alcohol wipes zip lock bags", unit: "bags", usage: "perOrder" },
  { id: "wipes", name: "Alcohol wipes", unit: "wipes", usage: "wipes" },
  { id: "boxes", name: "Boxes", unit: "boxes", usage: "perOrder" },
  { id: "box_sleeves", name: "Box sleeves", unit: "sleeves", usage: "perOrder" },
  { id: "shipping_sleeves", name: "Shipping sleeves", unit: "sleeves", usage: "perOrder" },
  { id: "shipping_labels", name: "Shipping labels", unit: "labels", usage: "perOrder" },
];

interface OnOrder {
  placedAt: string;
  eta: string | null; // ISO date the supplier promised
  qty: number | null; // how many units are coming, if known
}

interface ItemState {
  qty: number | null;          // counted baseline (null = never counted)
  countedAt: string | null;    // when that baseline was set
  leadTimeDays: number | null;
  usagePerUnit: number | null; // ink/film only — e.g. 0.004 bottles per unit
  barcode: string | null;
  packSize: number;            // units added per scan of that barcode
  onOrder: OnOrder | null;
  updatedAt: string | null;
}

type StockViewState = Record<string, ItemState>;

const emptyItem = (): ItemState => ({
  qty: null,
  countedAt: null,
  leadTimeDays: null,
  usagePerUnit: null,
  barcode: null,
  packSize: 1,
  onOrder: null,
  updatedAt: null,
});

async function getState(env: Env): Promise<StockViewState> {
  const raw = (await env.PROFILE_CACHE.get(STATE_KEY, "json")) as StockViewState | null;
  const state: StockViewState = {};
  for (const c of CATALOG) state[c.id] = { ...emptyItem(), ...(raw?.[c.id] || {}) };
  return state;
}

async function putState(env: Env, state: StockViewState): Promise<void> {
  await env.PROFILE_CACHE.put(STATE_KEY, JSON.stringify(state));
}

async function getOrderStats(env: Env): Promise<OrderConsumptionStats | null> {
  const cached = (await env.PROFILE_CACHE.get(STATS_CACHE_KEY, "json")) as OrderConsumptionStats | null;
  if (cached && cached.daily) return cached;
  try {
    const stats = await fetchOrderConsumptionStats(env, STATS_WINDOW_DAYS);
    await env.PROFILE_CACHE.put(STATS_CACHE_KEY, JSON.stringify(stats), {
      expirationTtl: STATS_CACHE_TTL,
    });
    return stats;
  } catch {
    return null; // fail-soft: projections show as unavailable
  }
}

// ── Consumption math ─────────────────────────────────────────────────────────

/** How much of THIS item one day's volume consumes. Null when the rate is
 *  unknowable (ink/film before usagePerUnit is set). */
function dayUse(entry: CatalogEntry, item: ItemState, d: DailyConsumption): number | null {
  if (entry.usage === "perOrder") return d.orders;
  if (entry.usage === "wipes") return d.wipes;
  if (item.usagePerUnit == null || item.usagePerUnit <= 0) return null;
  return d.units * item.usagePerUnit;
}

/** Units consumed since `sinceISO`: exact from the daily buckets inside the
 *  stats window, average-rate extrapolation for any time before it. */
function consumedSince(
  entry: CatalogEntry,
  item: ItemState,
  stats: OrderConsumptionStats,
  sinceISO: string
): number | null {
  const since = Date.parse(sinceISO);
  if (!Number.isFinite(since)) return null;
  const now = Date.now();
  if (since >= now) return 0;

  const windowStart = now - stats.days * 24 * 3600_000;
  let total = 0;

  // Exact part: sum daily buckets from `since` forward, scaling the bucket of
  // the count day by the fraction of that day remaining after the count.
  for (const [day, d] of Object.entries(stats.daily)) {
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    const dayEnd = dayStart + 24 * 3600_000;
    if (dayEnd <= since) continue;
    const use = dayUse(entry, item, d);
    if (use == null) return null;
    const fraction = since > dayStart ? (dayEnd - since) / (24 * 3600_000) : 1;
    total += use * fraction;
  }

  // Extrapolated part: counted before the window — assume the average rate.
  if (since < windowStart) {
    const avg = dayUse(entry, item, {
      orders: stats.orders / stats.days,
      units: stats.units / stats.days,
      wipes: stats.wipes / stats.days,
    });
    if (avg == null) return null;
    total += (avg * (windowStart - since)) / (24 * 3600_000);
  }
  return total;
}

interface Rates {
  wk28: number | null;
  wk7: number | null;
  projection: number | null; // the hotter rate when a spike is on
  spike: boolean;
}

/** Weekly rates for this item — 28-day base, 7-day recent, and which one the
 *  projection should use. */
function weeklyRates(entry: CatalogEntry, item: ItemState, stats: OrderConsumptionStats): Rates {
  const base = dayUse(entry, item, {
    orders: stats.orders / stats.days,
    units: stats.units / stats.days,
    wipes: stats.wipes / stats.days,
  });
  if (base == null) return { wk28: null, wk7: null, projection: null, spike: false };
  const wk28 = base * 7;

  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  let recent = 0;
  for (const [day, d] of Object.entries(stats.daily)) {
    if (Date.parse(`${day}T00:00:00Z`) + 24 * 3600_000 <= weekAgo) continue;
    recent += dayUse(entry, item, d) ?? 0;
  }
  const wk7 = recent;
  const spike = wk28 > 0 && wk7 > wk28 * SPIKE_THRESHOLD;
  return { wk28, wk7, projection: spike ? wk7 : wk28, spike };
}

// ── Projection ───────────────────────────────────────────────────────────────

type ItemStatus =
  | "uncounted"
  | "no-rate"
  | "ok"
  | "order-soon"
  | "order-now"
  | "on-order"
  | "order-overdue";

interface ProjectedItem extends CatalogEntry, ItemState {
  effectiveQty: number | null; // baseline minus consumption since the count
  weeklyUse: number | null;    // the rate the projection uses
  weeklyUse28: number | null;
  weeklyUse7: number | null;
  spike: boolean;
  daysLeft: number | null;
  runoutDate: string | null;
  status: ItemStatus;
}

function project(entry: CatalogEntry, item: ItemState, stats: OrderConsumptionStats | null): ProjectedItem {
  const rates: Rates = stats
    ? weeklyRates(entry, item, stats)
    : { wk28: null, wk7: null, projection: null, spike: false };

  let effectiveQty: number | null = null;
  if (item.qty != null) {
    if (stats && item.countedAt) {
      const used = consumedSince(entry, item, stats, item.countedAt);
      effectiveQty = used == null ? item.qty : Math.max(0, item.qty - used);
    } else {
      effectiveQty = item.qty;
    }
  }

  let daysLeft: number | null = null;
  let runoutDate: string | null = null;
  let status: ItemStatus;

  if (item.qty == null) {
    status = "uncounted";
  } else if (rates.projection == null) {
    status = "no-rate";
  } else if (rates.projection <= 0) {
    status = "ok";
  } else {
    daysLeft = (effectiveQty ?? 0) / (rates.projection / 7);
    runoutDate = new Date(Date.now() + daysLeft * 24 * 3600_000).toISOString();
    const lead = item.leadTimeDays ?? 0;
    status =
      daysLeft <= lead ? "order-now" : daysLeft <= lead + REORDER_BUFFER_DAYS ? "order-soon" : "ok";
  }

  // An order on the way overrides the reorder nag — unless its ETA has passed.
  if (item.onOrder) {
    const etaPassed = item.onOrder.eta && Date.parse(item.onOrder.eta) < Date.now();
    status = etaPassed ? "order-overdue" : "on-order";
  }

  return {
    ...entry,
    ...item,
    effectiveQty:
      effectiveQty == null
        ? null
        : entry.usage === "perUnit"
        ? Math.round(effectiveQty * 10) / 10
        : Math.round(effectiveQty),
    weeklyUse: rates.projection,
    weeklyUse28: rates.wk28,
    weeklyUse7: rates.wk7,
    spike: rates.spike,
    daysLeft,
    runoutDate,
    status,
  };
}

/** The actionable subset, for the home-page digest: needs ordering, or an
 *  order that should have arrived. Fail-soft null on any error. */
export async function getStockAlerts(
  env: Env
): Promise<{ name: string; status: string; daysLeft: number | null; eta: string | null }[] | null> {
  try {
    const [state, stats] = await Promise.all([getState(env), getOrderStats(env)]);
    return CATALOG.map((c) => project(c, state[c.id], stats))
      .filter((i) => i.status === "order-now" || i.status === "order-soon" || i.status === "order-overdue")
      .map((i) => ({
        name: i.name,
        status: i.status,
        daysLeft: i.daysLeft == null ? null : Math.floor(i.daysLeft),
        eta: i.onOrder?.eta ?? null,
      }));
  } catch {
    return null;
  }
}

// ── API handlers ─────────────────────────────────────────────────────────────

/** GET /api/stocktake — catalog + live counts + volume + projections. */
export async function handleGetStockTake(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const [state, stats] = await Promise.all([getState(env), getOrderStats(env)]);
  const items = CATALOG.map((c) => project(c, state[c.id], stats));

  // Headline demand comparison (units): is this week running hot?
  let demand: { unitsWk28: number; unitsWk7: number; spikePct: number } | null = null;
  if (stats) {
    const wk28 = (stats.units / stats.days) * 7;
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    let wk7 = 0;
    for (const [day, d] of Object.entries(stats.daily)) {
      if (Date.parse(`${day}T00:00:00Z`) + 24 * 3600_000 <= weekAgo) continue;
      wk7 += d.units;
    }
    demand = {
      unitsWk28: Math.round(wk28),
      unitsWk7: Math.round(wk7),
      spikePct: wk28 > 0 ? Math.round((wk7 / wk28 - 1) * 100) : 0,
    };
  }

  return jsonResponse({
    stats: stats ? { days: stats.days, orders: stats.orders, units: stats.units, wipes: stats.wipes } : null,
    demand,
    items,
  });
}

/** POST /api/stocktake/item {id, qty?, leadTimeDays?, usagePerUnit?, packSize?, barcode?}
 *  — edit an item's settings. Setting qty establishes a fresh count baseline. */
export async function handleStockUpdateItem(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "");
  const entry = CATALOG.find((c) => c.id === id);
  if (!entry) return jsonResponse({ error: "Unknown item" }, 404);

  const state = await getState(env);
  const item = state[id];

  const num = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const qty = num(body.qty);
  if (qty !== undefined) {
    item.qty = qty == null ? null : Math.round(qty);
    item.countedAt = qty == null ? null : new Date().toISOString();
  }
  const lead = num(body.leadTimeDays);
  if (lead !== undefined) item.leadTimeDays = lead == null ? null : Math.round(lead);
  const rate = num(body.usagePerUnit);
  if (rate !== undefined) item.usagePerUnit = rate;
  const pack = num(body.packSize);
  if (pack !== undefined && pack != null && pack >= 1) item.packSize = Math.round(pack);
  if (body.barcode !== undefined) {
    const code = String(body.barcode ?? "").trim();
    // One barcode maps to one item — unassign it elsewhere first.
    if (code) for (const other of Object.values(state)) if (other.barcode === code) other.barcode = null;
    item.barcode = code || null;
  }
  item.updatedAt = new Date().toISOString();

  await putState(env, state);
  return jsonResponse({ item: { id, ...item } });
}

/** Fold a stock arrival into the baseline: new count = current effective
 *  on-hand + what arrived, counted now. Also clears any on-order flag. */
async function registerArrival(env: Env, state: StockViewState, id: string, added: number): Promise<void> {
  const entry = CATALOG.find((c) => c.id === id)!;
  const item = state[id];
  const stats = await getOrderStats(env);
  let effective = item.qty ?? 0;
  if (stats && item.qty != null && item.countedAt) {
    const used = consumedSince(entry, item, stats, item.countedAt);
    if (used != null) effective = Math.max(0, item.qty - used);
  }
  item.qty = Math.max(0, Math.round(effective + added));
  item.countedAt = new Date().toISOString();
  item.onOrder = null; // it arrived
  item.updatedAt = item.countedAt;
  await putState(env, state);
}

/** POST /api/stocktake/receive {id, qty} — stock arrived (manual entry). */
export async function handleStockReceive(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { id?: unknown; qty?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "");
  const qty = Number(body.qty);
  if (!CATALOG.some((c) => c.id === id)) return jsonResponse({ error: "Unknown item" }, 404);
  if (!Number.isInteger(qty) || qty === 0) {
    return jsonResponse({ error: "qty must be a non-zero integer" }, 400);
  }
  const state = await getState(env);
  await registerArrival(env, state, id, qty);
  return jsonResponse({ item: { id, ...state[id] } });
}

/** POST /api/stocktake/ordered {id, eta?, qty?, cancel?} — mark an order
 *  placed with the supplier (quiets the reorder alert until it arrives or the
 *  ETA passes), or cancel the flag. */
export async function handleStockOrdered(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { id?: unknown; eta?: unknown; qty?: unknown; cancel?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = String(body.id ?? "");
  if (!CATALOG.some((c) => c.id === id)) return jsonResponse({ error: "Unknown item" }, 404);
  const state = await getState(env);
  const item = state[id];
  if (body.cancel) {
    item.onOrder = null;
  } else {
    const eta = String(body.eta ?? "").trim();
    const qty = Number(body.qty);
    item.onOrder = {
      placedAt: new Date().toISOString(),
      eta: eta && Number.isFinite(Date.parse(eta)) ? new Date(eta).toISOString() : null,
      qty: Number.isInteger(qty) && qty > 0 ? qty : null,
    };
  }
  item.updatedAt = new Date().toISOString();
  await putState(env, state);
  return jsonResponse({ item: { id, ...item } });
}

/** POST /api/stocktake/scan {code, count?} — the scanner path. A recognised
 *  barcode adds packSize × count units automatically; an unknown barcode
 *  returns matched:false so the UI can offer to assign it. */
export async function handleStockScan(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let body: { code?: unknown; count?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const code = String(body.code ?? "").trim();
  if (!code) return jsonResponse({ error: "code is required" }, 400);
  const count = Number(body.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    return jsonResponse({ error: "count must be a positive integer" }, 400);
  }

  const state = await getState(env);
  const id = Object.keys(state).find((k) => state[k].barcode === code);
  if (!id) {
    return jsonResponse({ matched: false, code });
  }
  const added = state[id].packSize * count;
  await registerArrival(env, state, id, added);
  const entry = CATALOG.find((c) => c.id === id)!;
  await clog(env, `Stock scan: +${added} ${entry.unit} ${entry.name} (${code})`);
  return jsonResponse({
    matched: true,
    item: { id, name: entry.name, unit: entry.unit, added, ...state[id] },
  });
}
