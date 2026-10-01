import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { adminGraphQL, currentScopes } from "../services/shopify-api";
import { cerr, clog } from "../services/logger";
import { aestDate } from "./gangsheet-orders";

// Home-page order globe. Two data sets, both in KV and both anonymous (coords
// rounded to a ~50km grid, country codes and counts only, no names/addresses):
//
//   1. All-time aggregate (orders_geo_agg) — built once from a Shopify Bulk
//      Operation export of every order (async JSONL, no pagination/subrequest
//      limits), then topped up incrementally by the 10-min cron using a
//      createdAt cursor. POST /api/orders/globe/backfill (or the cron, when no
//      aggregate exists yet) starts the export; the cron polls it to completion.
//   2. In-transit snapshot (orders_geo_transit) — recent shipped orders and
//      their fulfillment tracking status, refreshed every 30 min. Drives the
//      animated Canberra → destination arcs and the delivery-time stats.
//
// All-time history needs the read_all_orders scope (Shopify otherwise only
// returns the last 60 days); the GET response flags it when missing.

const AGG_KEY = "orders_geo_agg";
const BULK_KEY = "orders_geo_bulk";
export const TRANSIT_KEY = "orders_geo_transit";
const SCOPE_KEY = "orders_geo_scope_ok";

// Dispatch point — Canberra, ACT.
export const ORIGIN = { lat: -35.2809, lng: 149.13, name: "Canberra" };

const GRID = 0.5; // degrees — storage grid for points (~55km)
const RECENT_MAX = 300; // last-24h ring markers kept
const TRANSIT_REFRESH_MS = 30 * 60_000;
const TRANSIT_WINDOW_DAYS = 40; // shipped orders newer than this are checked
const TRANSIT_MAX_PAGES = 30; // ×100 orders
// With no carrier events, a shipment older than this is assumed delivered.
const ASSUME_DELIVERED_DAYS = { domestic: 10, international: 25 };
const DELAYED_DAYS = { domestic: 7, international: 18 };

interface Agg {
  v: 1;
  total: number;
  located: number; // orders with usable coords
  points: Record<string, [number, string]>; // "lat,lng" → [count, countryCode]
  byCountry: Record<string, number>;
  byMonth: Record<string, number>; // "YYYY-MM" (AEST)
  byDay: Record<string, number>; // "YYYY-MM-DD" (AEST), all-time (feeds the records)
  recent: { lat: number; lng: number; t: number; cc: string }[];
  firstOrderAt: string | null;
  cursor: string | null; // newest createdAt folded in
  builtAt: string;
  syncedAt: string;
}

interface BulkState {
  id: string;
  startedAt: string;
  status: string;
  error?: string;
}

export interface TransitShipment {
  o: string; // order name
  lat: number;
  lng: number;
  cc: string;
  city: string;
  carrier: string;
  shippedAt: string;
  status: "label" | "in_transit" | "out_for_delivery" | "delayed" | "issue";
  eta: string | null;
  approx: boolean; // true = no carrier events, status inferred from age
}

export interface TransitSnapshot {
  refreshedAt: string;
  shipments: TransitShipment[];
  deliveryDays: Record<string, { n: number; avg: number }>; // by country
  awaitingDispatch: number | null;
}

interface OrderGeo {
  createdAt: string;
  cc: string;
  lat: number | null;
  lng: number | null;
}

// ── Aggregate building ──────────────────────────────────────────────────────

function emptyAgg(): Agg {
  const now = new Date().toISOString();
  return {
    v: 1, total: 0, located: 0, points: {}, byCountry: {}, byMonth: {}, byDay: {},
    recent: [], firstOrderAt: null, cursor: null, builtAt: now, syncedAt: now,
  };
}

function snap(x: number): number {
  return Math.round(x / GRID) * GRID;
}

/** Order coords, falling back to the country's centroid when Shopify didn't
 *  geocode the address. */
function coordsFor(o: OrderGeo): [number, number] | null {
  if (o.lat != null && o.lng != null && (o.lat !== 0 || o.lng !== 0)) return [o.lat, o.lng];
  const c = CENTROIDS[o.cc];
  return c ? [c[0], c[1]] : null;
}

function addOrder(agg: Agg, o: OrderGeo): void {
  agg.total++;
  const cc = o.cc || "??";
  agg.byCountry[cc] = (agg.byCountry[cc] || 0) + 1;
  const day = aestDate(new Date(o.createdAt));
  agg.byMonth[day.slice(0, 7)] = (agg.byMonth[day.slice(0, 7)] || 0) + 1;
  agg.byDay[day] = (agg.byDay[day] || 0) + 1;
  if (!agg.firstOrderAt || o.createdAt < agg.firstOrderAt) agg.firstOrderAt = o.createdAt;
  if (!agg.cursor || o.createdAt > agg.cursor) agg.cursor = o.createdAt;

  const ll = coordsFor(o);
  if (!ll) return;
  agg.located++;
  const key = `${snap(ll[0]).toFixed(1)},${snap(ll[1]).toFixed(1)}`;
  const p = agg.points[key];
  if (p) p[0]++;
  else agg.points[key] = [1, cc];

  const t = Date.parse(o.createdAt);
  if (Date.now() - t < 24 * 3600_000) agg.recent.push({ lat: ll[0], lng: ll[1], t, cc });
}

function pruneAgg(agg: Agg): void {
  const recentCutoff = Date.now() - 24 * 3600_000;
  agg.recent = agg.recent.filter((r) => r.t >= recentCutoff).slice(-RECENT_MAX);
}

async function loadAgg(env: Env): Promise<Agg | null> {
  const raw = await env.PROFILE_CACHE.get(AGG_KEY);
  return raw ? (JSON.parse(raw) as Agg) : null;
}

async function saveAgg(env: Env, agg: Agg): Promise<void> {
  pruneAgg(agg);
  agg.syncedAt = new Date().toISOString();
  await env.PROFILE_CACHE.put(AGG_KEY, JSON.stringify(agg));
}

// ── Bulk backfill ───────────────────────────────────────────────────────────

const BULK_QUERY = `{
  orders(query: "-status:cancelled") {
    edges { node {
      createdAt
      shippingAddress { countryCodeV2 latitude longitude }
      billingAddress { countryCodeV2 }
    } }
  }
}`;

const BULK_RUN = `mutation($q: String!) {
  bulkOperationRunQuery(query: $q) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const BULK_POLL = `query($id: ID!) {
  node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } }
}`;

async function startBackfill(env: Env): Promise<BulkState> {
  const data = await adminGraphQL<{
    bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: { message: string }[] };
  }>(env, BULK_RUN, { q: BULK_QUERY });
  const r = data.bulkOperationRunQuery;
  if (!r.bulkOperation) throw new Error(r.userErrors.map((e) => e.message).join("; ") || "bulk op not created");
  const state: BulkState = { id: r.bulkOperation.id, startedAt: new Date().toISOString(), status: r.bulkOperation.status };
  await env.PROFILE_CACHE.put(BULK_KEY, JSON.stringify(state));
  await clog(env, `Order globe: bulk backfill started ${state.id}`);
  return state;
}

interface BulkLine {
  createdAt?: string;
  shippingAddress?: { countryCodeV2?: string | null; latitude?: number | null; longitude?: number | null } | null;
  billingAddress?: { countryCodeV2?: string | null } | null;
}

/** Stream the bulk JSONL and fold every order into a fresh aggregate. */
async function ingestBulk(env: Env, url: string): Promise<Agg> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`bulk download ${res.status}`);
  const agg = emptyAgg();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const handle = (line: string) => {
    if (!line.trim()) return;
    const o = JSON.parse(line) as BulkLine;
    if (!o.createdAt) return;
    const s = o.shippingAddress;
    addOrder(agg, {
      createdAt: o.createdAt,
      cc: s?.countryCodeV2 || o.billingAddress?.countryCodeV2 || "",
      lat: s?.latitude ?? null,
      lng: s?.longitude ?? null,
    });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  return agg;
}

/** Cron step: advance a running backfill. Returns true while one is in flight
 *  (so the incremental sync waits for it). */
async function pollBackfill(env: Env): Promise<boolean> {
  const raw = await env.PROFILE_CACHE.get(BULK_KEY);
  if (!raw) return false;
  const state = JSON.parse(raw) as BulkState;
  if (state.status === "COMPLETED" || state.status === "FAILED" || state.status === "CANCELED") return false;

  const data = await adminGraphQL<{
    node: { status: string; errorCode: string | null; objectCount: string; url: string | null } | null;
  }>(env, BULK_POLL, { id: state.id });
  const op = data.node;
  if (!op) {
    state.status = "FAILED";
    state.error = "bulk operation not found";
  } else if (op.status === "COMPLETED") {
    // A store with zero orders completes with url=null.
    const agg = op.url ? await ingestBulk(env, op.url) : emptyAgg();
    await saveAgg(env, agg);
    state.status = "COMPLETED";
    await clog(env, `Order globe: backfill done, ${agg.total} orders (${agg.located} located)`);
  } else if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
    state.status = "FAILED";
    state.error = op.errorCode || op.status;
    await cerr(env, `Order globe: bulk backfill ${op.status}`, op.errorCode);
  } else {
    state.status = op.status; // CREATED / RUNNING
  }
  await env.PROFILE_CACHE.put(BULK_KEY, JSON.stringify(state));
  return state.status !== "COMPLETED" && state.status !== "FAILED";
}

// ── Incremental sync ────────────────────────────────────────────────────────

const NEW_ORDERS_QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      createdAt
      shippingAddress { countryCodeV2 latitude longitude }
      billingAddress { countryCodeV2 }
    } }
  }
}`;

async function syncNewOrders(env: Env, agg: Agg): Promise<number> {
  if (!agg.cursor) return 0;
  let after: string | null = null;
  let added = 0;
  for (let page = 0; page < 10; page++) {
    const data: {
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: { node: BulkLine & { createdAt: string } }[] };
    } = await adminGraphQL(env, NEW_ORDERS_QUERY, {
      q: `created_at:>'${agg.cursor}' -status:cancelled`,
      after,
    });
    for (const { node } of data.orders.edges) {
      // Shopify's created_at filter has second granularity — skip the boundary order.
      if (agg.cursor && node.createdAt <= agg.cursor) continue;
      const s = node.shippingAddress;
      addOrder(agg, {
        createdAt: node.createdAt,
        cc: s?.countryCodeV2 || node.billingAddress?.countryCodeV2 || "",
        lat: s?.latitude ?? null,
        lng: s?.longitude ?? null,
      });
      added++;
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return added;
}

// ── In-transit snapshot ─────────────────────────────────────────────────────

const TRANSIT_QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      name
      shippingAddress { city countryCodeV2 latitude longitude }
      fulfillments(first: 5) {
        status displayStatus createdAt inTransitAt deliveredAt estimatedDeliveryAt
        trackingInfo(first: 1) { company }
      }
    } }
  }
}`;

const AWAITING_QUERY = `query {
  ordersCount(query: "fulfillment_status:unshipped -status:cancelled status:open", limit: 10000) { count }
}`;

interface TransitNode {
  name: string;
  shippingAddress: { city: string | null; countryCodeV2: string | null; latitude: number | null; longitude: number | null } | null;
  fulfillments: {
    status: string;
    displayStatus: string | null;
    createdAt: string;
    inTransitAt: string | null;
    deliveredAt: string | null;
    estimatedDeliveryAt: string | null;
    trackingInfo: { company: string | null }[];
  }[];
}

const DAY = 86400_000;

async function refreshTransit(env: Env): Promise<TransitSnapshot> {
  const since = new Date(Date.now() - TRANSIT_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const shipments: TransitShipment[] = [];
  const delivery: Record<string, { n: number; sum: number }> = {};
  let after: string | null = null;

  for (let page = 0; page < TRANSIT_MAX_PAGES; page++) {
    const data: {
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: { node: TransitNode }[] };
    } = await adminGraphQL(env, TRANSIT_QUERY, {
      q: `created_at:>=${since} fulfillment_status:shipped -status:cancelled`,
      after,
    });
    for (const { node } of data.orders.edges) {
      const addr = node.shippingAddress;
      const cc = addr?.countryCodeV2 || "";
      const ll = coordsFor({ createdAt: "", cc, lat: addr?.latitude ?? null, lng: addr?.longitude ?? null });
      const intl = cc !== "AU";
      // Latest real fulfillment on the order.
      const f = node.fulfillments
        .filter((x) => x.status === "SUCCESS" || x.status === "OPEN" || x.status === "PENDING")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!f) continue;

      const shippedAt = f.inTransitAt || f.createdAt;
      if (f.deliveredAt || f.displayStatus === "DELIVERED") {
        if (f.deliveredAt && cc) {
          const days = (Date.parse(f.deliveredAt) - Date.parse(f.createdAt)) / DAY;
          if (days >= 0 && days < 90) {
            const d = (delivery[cc] ||= { n: 0, sum: 0 });
            d.n++;
            d.sum += days;
          }
        }
        continue;
      }
      if (!ll) continue;

      const ageDays = (Date.now() - Date.parse(shippedAt)) / DAY;
      const ds = f.displayStatus || "";
      let status: TransitShipment["status"];
      let approx = false;
      if (ds === "OUT_FOR_DELIVERY") status = "out_for_delivery";
      else if (ds === "FAILURE" || ds === "ATTEMPTED_DELIVERY" || ds === "NOT_DELIVERED") status = "issue";
      else if (ds === "LABEL_PRINTED" || ds === "LABEL_PURCHASED" || ds === "CONFIRMED") status = "label";
      else if (ds === "IN_TRANSIT" || ds === "READY_FOR_PICKUP" || f.inTransitAt) status = "in_transit";
      else {
        // FULFILLED with no carrier events — infer from age.
        approx = true;
        if (ageDays > (intl ? ASSUME_DELIVERED_DAYS.international : ASSUME_DELIVERED_DAYS.domestic)) continue;
        status = "in_transit";
      }
      const eta = f.estimatedDeliveryAt;
      if (status === "in_transit" || status === "label") {
        const late = eta ? Date.now() > Date.parse(eta) + DAY : ageDays > (intl ? DELAYED_DAYS.international : DELAYED_DAYS.domestic);
        if (late) status = "delayed";
      }
      shipments.push({
        o: node.name,
        lat: ll[0],
        lng: ll[1],
        cc,
        city: addr?.city || "",
        carrier: f.trackingInfo[0]?.company || "",
        shippedAt,
        status,
        eta,
        approx,
      });
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  let awaitingDispatch: number | null = null;
  try {
    const d = await adminGraphQL<{ ordersCount: { count: number } }>(env, AWAITING_QUERY, {});
    awaitingDispatch = d.ordersCount.count;
  } catch (e) {
    await cerr(env, "Order globe: awaiting-dispatch count failed", e);
  }

  const deliveryDays: TransitSnapshot["deliveryDays"] = {};
  for (const [cc, d] of Object.entries(delivery)) deliveryDays[cc] = { n: d.n, avg: Math.round((d.sum / d.n) * 10) / 10 };

  const snapshot: TransitSnapshot = { refreshedAt: new Date().toISOString(), shipments, deliveryDays, awaitingDispatch };
  await env.PROFILE_CACHE.put(TRANSIT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

// ── Entry points ────────────────────────────────────────────────────────────

const RUN_KEY = "orders_geo_lastrun";
const ERROR_KEY = "orders_geo_error";
const PAGE_SYNC_GAP_MS = 5 * 60_000; // page loads trigger at most one sync per 5 min

interface SyncResult {
  backfill: string | null;
  added: number;
  shipments: number | null;
  errors: string[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Advance/kick off the backfill, fold in new orders, refresh the in-transit
 *  snapshot (every 30 min, or always when `forceTransit`). Each step is
 *  independent and fail-soft; the last errors are kept in KV so the card can
 *  show them. Runs from the 10-min cron, page loads, and the Refresh button. */
export async function syncOrderGlobe(env: Env, forceTransit = false): Promise<SyncResult> {
  const result: SyncResult = { backfill: null, added: 0, shipments: null, errors: [] };
  await env.PROFILE_CACHE.put(RUN_KEY, String(Date.now()), { expirationTtl: 3600 });
  try {
    const running = await pollBackfill(env);
    if (running) {
      const raw = await env.PROFILE_CACHE.get(BULK_KEY);
      result.backfill = raw ? (JSON.parse(raw) as BulkState).status : null;
    } else {
      const agg = await loadAgg(env);
      if (!agg) {
        const bulkRaw = await env.PROFILE_CACHE.get(BULK_KEY);
        const bulk = bulkRaw ? (JSON.parse(bulkRaw) as BulkState) : null;
        // Auto-start once; after a failure wait for a manual rebuild.
        if (!bulk) result.backfill = (await startBackfill(env)).status;
        else result.backfill = bulk.status;
      } else {
        result.added = await syncNewOrders(env, agg);
        await saveAgg(env, agg);
        result.backfill = "COMPLETED";
      }
    }
  } catch (e) {
    result.errors.push(`History: ${errMsg(e)}`);
    await cerr(env, "Order globe sync error:", e);
  }
  try {
    const raw = await env.PROFILE_CACHE.get(TRANSIT_KEY);
    const last = raw ? Date.parse((JSON.parse(raw) as TransitSnapshot).refreshedAt) : 0;
    if (forceTransit || Date.now() - last >= TRANSIT_REFRESH_MS - 60_000) {
      result.shipments = (await refreshTransit(env)).shipments.length;
    }
  } catch (e) {
    result.errors.push(`In transit: ${errMsg(e)}`);
    await cerr(env, "Order globe transit refresh error:", e);
  }
  if (result.errors.length) {
    await env.PROFILE_CACHE.put(ERROR_KEY, JSON.stringify({ at: new Date().toISOString(), errors: result.errors }));
  } else {
    await env.PROFILE_CACHE.delete(ERROR_KEY);
  }
  return result;
}

async function hasAllOrdersScope(env: Env): Promise<boolean | null> {
  const cached = await env.PROFILE_CACHE.get(SCOPE_KEY);
  if (cached) return cached === "1";
  try {
    const ok = (await currentScopes(env)).includes("read_all_orders");
    await env.PROFILE_CACHE.put(SCOPE_KEY, ok ? "1" : "0", { expirationTtl: 3600 });
    return ok;
  } catch {
    return null;
  }
}

export async function handleGetOrderGlobe(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const [aggRaw, transitRaw, bulkRaw, allOrders, lastRun, errRaw] = await Promise.all([
    env.PROFILE_CACHE.get(AGG_KEY),
    env.PROFILE_CACHE.get(TRANSIT_KEY),
    env.PROFILE_CACHE.get(BULK_KEY),
    hasAllOrdersScope(env),
    env.PROFILE_CACHE.get(RUN_KEY),
    env.PROFILE_CACHE.get(ERROR_KEY),
  ]);
  // Stale data → sync in the background on this request (its own subrequest
  // budget, separate from the busy 10-min cron).
  if (!lastRun || Date.now() - Number(lastRun) > PAGE_SYNC_GAP_MS) ctx.waitUntil(syncOrderGlobe(env));
  const agg = aggRaw ? (JSON.parse(aggRaw) as Agg) : null;
  if (agg) pruneAgg(agg);
  const bulk = bulkRaw ? (JSON.parse(bulkRaw) as BulkState) : null;
  return jsonResponse({
    origin: ORIGIN,
    agg: agg && {
      total: agg.total,
      located: agg.located,
      points: Object.entries(agg.points).map(([k, [n, cc]]) => {
        const [lat, lng] = k.split(",").map(Number);
        return { lat, lng, n, cc };
      }),
      byCountry: agg.byCountry,
      byMonth: agg.byMonth,
      byDay: agg.byDay,
      recent: agg.recent,
      firstOrderAt: agg.firstOrderAt,
      syncedAt: agg.syncedAt,
    },
    transit: transitRaw ? JSON.parse(transitRaw) : null,
    backfill: bulk && { status: bulk.status, startedAt: bulk.startedAt, error: bulk.error },
    allOrdersScope: allOrders,
    syncError: errRaw ? JSON.parse(errRaw) : null,
    today: aestDate(),
  });
}

/** Manual (re)build of the all-time aggregate — e.g. after granting
 *  read_all_orders. Runs async; the cron picks it up. */
export async function handleOrderGlobeBackfill(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  try {
    await env.PROFILE_CACHE.delete(SCOPE_KEY);
    const state = await startBackfill(env);
    return jsonResponse({ ok: true, backfill: state });
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
}

/** Refresh button: run the full sync now and report what happened. */
export async function handleOrderGlobeRefresh(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const result = await syncOrderGlobe(env, true);
  return jsonResponse({ ok: result.errors.length === 0, ...result });
}

// Country centroids for addresses Shopify didn't geocode (lat, lng).
const CENTROIDS: Record<string, [number, number]> = {
  AU: [-25.3, 133.8], NZ: [-41.5, 172.8], US: [39.8, -98.6], CA: [56.1, -106.3], GB: [54.0, -2.5],
  IE: [53.4, -8.2], DE: [51.2, 10.4], FR: [46.2, 2.2], NL: [52.1, 5.3], BE: [50.5, 4.5],
  ES: [40.5, -3.7], PT: [39.4, -8.2], IT: [41.9, 12.6], CH: [46.8, 8.2], AT: [47.5, 14.6],
  SE: [60.1, 18.6], NO: [60.5, 8.5], DK: [56.3, 9.5], FI: [61.9, 25.7], PL: [51.9, 19.1],
  CZ: [49.8, 15.5], GR: [39.1, 21.8], HU: [47.2, 19.5], RO: [45.9, 24.97], HR: [45.1, 15.2],
  JP: [36.2, 138.3], KR: [35.9, 127.8], CN: [35.9, 104.2], HK: [22.3, 114.2], TW: [23.7, 121.0],
  SG: [1.35, 103.8], MY: [4.2, 102.0], TH: [15.9, 100.99], ID: [-0.8, 113.9], PH: [12.9, 121.8],
  VN: [14.1, 108.3], IN: [20.6, 78.96], AE: [23.4, 53.8], SA: [23.9, 45.1], IL: [31.0, 34.9],
  ZA: [-30.6, 22.9], BR: [-14.2, -51.9], AR: [-38.4, -63.6], CL: [-35.7, -71.5], MX: [23.6, -102.6],
  CO: [4.6, -74.3], PE: [-9.2, -75.0], FJ: [-17.7, 178.1], PG: [-6.3, 143.96], NC: [-20.9, 165.6],
  IS: [64.96, -19.0], LU: [49.8, 6.1], MT: [35.9, 14.4], CY: [35.1, 33.4], EE: [58.6, 25.0],
  LV: [56.9, 24.6], LT: [55.2, 23.9], SK: [48.7, 19.7], SI: [46.2, 14.99], BG: [42.7, 25.5],
  RS: [44.0, 21.0], UA: [48.4, 31.2], TR: [38.96, 35.2], EG: [26.8, 30.8], NG: [9.1, 8.7],
  KE: [-0.02, 37.9], PK: [30.4, 69.3], BD: [23.7, 90.4], LK: [7.9, 80.8], PR: [18.2, -66.6],
};
