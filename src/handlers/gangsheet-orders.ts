import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import {
  fetchGangsheetRows,
  fetchGangsheetRowsByOrderRange,
  orderRangeForWindow,
  shopifyConfigured,
  windowForOrderRange,
} from "../services/shopify-api";
import { clog, cerr } from "../services/logger";
import type { GangsheetLineRow, GangsheetOrderMeta } from "../services/shopify-api";
import { updateOrderNote } from "../services/shopify-api";

// Daily Shopify order pull for the gangsheet generator — replaces the manual
// 9am Matrixify CSV export. The worker shapes Admin API line items into the
// exact CSV the Python pipeline already parses, so the generator itself is
// untouched. The cron-stored copy lives in R2 under orders-csv/<AEST date>.csv.

export const DAILY_PREFIX = "orders-csv/";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The generator's parser reads exactly these columns (see main.py
// collect_items_from_csv). Line: Type is always "Line Item" — cancelled orders
// and refunded quantities are already filtered out API-side.
const CSV_HEADER = 'Number,"Line: Type","Line: Name","Line: Variant Title","Line: Quantity","Line: Properties","Refund: ID"';

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildCsv(rows: { orderNumber: string; lineName: string; variantTitle: string; quantity: number; properties: string }[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push([
      csvField(r.orderNumber),
      "Line Item",
      csvField(r.lineName),
      csvField(r.variantTitle),
      String(r.quantity),
      csvField(r.properties),
      "", // Refund: ID — refunds already deducted via currentQuantity
    ].join(","));
  }
  return lines.join("\n");
}

/** The store's local (AEST, UTC+10) calendar date — used to label daily pulls
 *  so "today's orders" matches the operator's day, not UTC's. */
export function aestDate(now = new Date()): string {
  return new Date(now.getTime() + 10 * 3600_000).toISOString().slice(0, 10);
}

async function pullWindow(env: Env, fromISO: string, toISO: string) {
  const { rows, orderCount, orders: orderMeta } = await fetchGangsheetRows(env, fromISO, toISO);
  return { csv: buildCsv(rows), orders: orderCount, items: rows.length, rows, orderMeta };
}

// Customer-chosen wipe count carried as a line property (e.g. "Priming
// wipes: 6" on a REQUEST A FLAG line). That line contributes exactly N wipes
// instead of feeding the ½-per-unit formula.
const WIPES_PROPERTY_RE = /(?:^|\n)priming wipes?: *(\d+)\s*(?:\n|$)/i;

/** Priming wipes per order, by the packing rule: ½ per unit, rounded up per
 *  order (matches Stock View's consumption estimate). Units are the lines the
 *  gangsheet actually prints — Priming Wipe / Shipping lines and
 *  shopify/automatic variants (shipping, Kaching bundle placeholders) don't
 *  count. A line carrying a "Priming wipes: N" property contributes N wipes
 *  directly, and starter kits contribute 1 wipe per kit — both on top of the
 *  formula for the rest. Orders whose lines are all skipped count as 0. */
function primingWipesPerOrder(rows: GangsheetLineRow[]): Map<string, number> {
  const unitsPerOrder = new Map<string, number>();
  const explicitPerOrder = new Map<string, number>();
  const addExplicit = (order: string, n: number) =>
    explicitPerOrder.set(order, (explicitPerOrder.get(order) || 0) + n);
  for (const r of rows) {
    const variant = r.variantTitle.toLowerCase();
    if (!r.lineName || r.lineName.includes("Priming Wipe") || r.lineName.includes("Shipping")) continue;
    if (variant === "shopify" || variant === "automatic") continue;
    const explicit = r.properties.match(WIPES_PROPERTY_RE);
    if (explicit) {
      addExplicit(r.orderNumber, Number(explicit[1]));
      continue;
    }
    if (r.lineName.toUpperCase().includes("STARTER KIT")) {
      addExplicit(r.orderNumber, r.quantity);
      continue;
    }
    unitsPerOrder.set(r.orderNumber, (unitsPerOrder.get(r.orderNumber) || 0) + r.quantity);
  }
  const wipes = new Map<string, number>();
  for (const [order, units] of unitsPerOrder) wipes.set(order, Math.ceil(units / 2));
  for (const [order, n] of explicitPerOrder) wipes.set(order, (wipes.get(order) || 0) + n);
  return wipes;
}

const WIPES_LINE_RE = /^PRIMING WIPES: \d+$/m;

/** The order's note with "PRIMING WIPES: <n>" as its first line — replaces a
 *  previous wipes line (cron rerun), otherwise prepends above the existing
 *  staff note. */
function noteWithWipesLine(existingNote: string, wipes: number): string {
  const line = `PRIMING WIPES: ${wipes}`;
  if (WIPES_LINE_RE.test(existingNote)) return existingNote.replace(WIPES_LINE_RE, line);
  return existingNote.trim() ? `${line}\n\n${existingNote}` : line;
}

/** Write each pulled order's wipe count into its Shopify order note so staff
 *  see "PRIMING WIPES: X" in the order view while picking. Idempotent —
 *  reruns update the existing line. Fail-soft per order; returns a summary. */
async function annotateOrdersWithWipes(
  env: Env,
  orderMeta: GangsheetOrderMeta[],
  rows: GangsheetLineRow[]
): Promise<{ updated: number; unchanged: number; failed: string[]; totalWipes: number; results: { order: string; wipes: number; note: string }[] }> {
  const wipesByOrder = primingWipesPerOrder(rows);
  let updated = 0;
  let unchanged = 0;
  let totalWipes = 0;
  const failed: string[] = [];
  const results: { order: string; wipes: number; note: string }[] = [];
  // Small batches: ~150 orders/day, one mutation each — parallel enough to
  // finish fast, serial enough to stay clear of API throttling.
  const BATCH = 5;
  for (let i = 0; i < orderMeta.length; i += BATCH) {
    await Promise.all(orderMeta.slice(i, i + BATCH).map(async (order) => {
      const wipes = wipesByOrder.get(order.number) || 0;
      totalWipes += wipes;
      const note = noteWithWipesLine(order.note, wipes);
      results.push({ order: order.number, wipes, note });
      if (note === order.note) {
        unchanged++;
        return;
      }
      try {
        await updateOrderNote(env, order.id, note);
        updated++;
      } catch (error) {
        failed.push(`#${order.number}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  return { updated, unchanged, failed, totalWipes, results };
}

// GET /api/gangsheet/orders?from=<ISO>&to=<ISO> — on-demand pull. Defaults to
// the last 24 hours. Alternatively ?fromOrder=<num>&toOrder=<num> pulls an
// inclusive order-number range instead. Returns the CSV inline for the
// dashboard to feed straight into the Pyodide pipeline.
export async function handlePullOrders(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!shopifyConfigured(env)) {
    return jsonResponse({ error: "Shopify is not configured" }, 503);
  }
  const params = new URL(request.url).searchParams;
  if (params.get("fromOrder") || params.get("toOrder")) {
    const lo = Number(params.get("fromOrder"));
    const hi = Number(params.get("toOrder"));
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || hi <= 0) {
      return jsonResponse({ error: "Invalid order number range — both order numbers are required" }, 400);
    }
    try {
      const { rows, orderCount } = await fetchGangsheetRowsByOrderRange(env, lo, hi);
      return jsonResponse({
        csv: buildCsv(rows),
        orders: orderCount,
        items: rows.length,
        fromOrder: Math.min(lo, hi),
        toOrder: Math.max(lo, hi),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Order pull failed";
      if (message.includes("not found")) return jsonResponse({ error: message }, 404);
      await cerr(env, "Gangsheet order-range pull error:", error);
      return jsonResponse({ error: message }, 502);
    }
  }
  const to = params.get("to") || new Date().toISOString();
  const from = params.get("from") || new Date(Date.parse(to) - 24 * 3600_000).toISOString();
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
    return jsonResponse({ error: "Invalid from/to range" }, 400);
  }
  try {
    const result = await pullWindow(env, from, to);
    return jsonResponse({ ...result, from, to });
  } catch (error) {
    await cerr(env, "Gangsheet order pull error:", error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Order pull failed" }, 502);
  }
}

// GET /api/gangsheet/preview — cheap lookup powering the dashboard's
// time↔order-number sync. ?from=<ISO>&to=<ISO> returns the first/last order
// numbers in the window; ?fromOrder=<num>&toOrder=<num> returns the two orders'
// createdAt timestamps. No line items are fetched.
export async function handlePullPreview(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!shopifyConfigured(env)) {
    return jsonResponse({ error: "Shopify is not configured" }, 503);
  }
  const params = new URL(request.url).searchParams;
  try {
    if (params.get("fromOrder") || params.get("toOrder")) {
      const lo = Number(params.get("fromOrder"));
      const hi = Number(params.get("toOrder"));
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || hi <= 0) {
        return jsonResponse({ error: "Invalid order number range" }, 400);
      }
      return jsonResponse(await windowForOrderRange(env, lo, hi));
    }
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
      return jsonResponse({ error: "Invalid from/to range" }, 400);
    }
    const range = await orderRangeForWindow(env, from, to);
    if (!range) return jsonResponse({ error: "No orders in range" }, 404);
    return jsonResponse(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview failed";
    if (message.includes("not found")) return jsonResponse({ error: message }, 404);
    return jsonResponse({ error: message }, 502);
  }
}

// POST /api/gangsheet/wipes-notes {fromOrder, toOrder} — manually run the
// priming-wipes note stamping for an inclusive order-number range (testing /
// backfill; the 9am cron does the daily pull automatically).
export async function handleWipesNotes(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!shopifyConfigured(env)) {
    return jsonResponse({ error: "Shopify is not configured" }, 503);
  }
  let body: { fromOrder?: unknown; toOrder?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const lo = Number(body.fromOrder);
  const hi = Number(body.toOrder);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || hi <= 0) {
    return jsonResponse({ error: "fromOrder and toOrder are required" }, 400);
  }
  try {
    const { rows, orders: orderMeta } = await fetchGangsheetRowsByOrderRange(env, lo, hi);
    const { updated, unchanged, failed, totalWipes, results } = await annotateOrdersWithWipes(env, orderMeta, rows);
    return jsonResponse({ updated, unchanged, failed, totalWipes, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wipes-note run failed";
    if (message.includes("not found")) return jsonResponse({ error: message }, 404);
    await cerr(env, "Wipes-note run error:", error);
    return jsonResponse({ error: message }, 502);
  }
}

// GET /api/gangsheet/daily?date=YYYY-MM-DD — the cron-stored pull for a day
// (default: today AEST). 404 when the cron hasn't run or found nothing.
export async function handleGetDailyOrders(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const date = new URL(request.url).searchParams.get("date") || aestDate();
  if (!DATE_RE.test(date)) {
    return jsonResponse({ error: "Invalid date (YYYY-MM-DD)" }, 400);
  }
  const obj = await env.GANGSHEET_FILES.get(`${DAILY_PREFIX}${date}.csv`);
  if (!obj) {
    return jsonResponse({ error: "No stored pull for that date" }, 404);
  }
  const csv = await obj.text();
  const meta = obj.customMetadata || {};
  return jsonResponse({
    date,
    csv,
    orders: Number(meta.orders || 0),
    items: Number(meta.items || 0),
    pulledAt: meta.pulledAt || obj.uploaded.toISOString(),
  });
}

/** Cron entry: pull the last day of orders and store the CSV in R2, labelled
 *  with the AEST date. Overwrites any earlier pull for the same day (rerunning
 *  the cron refreshes the snapshot). Fail-soft — a bad day logs and moves on.
 *
 *  Weekends (AEST) are skipped entirely. To spread the weekend load, Monday's
 *  pull covers Friday 9am → Sunday 9am and Tuesday's covers Sunday 9am →
 *  Tuesday 9am (48h each); Wed–Fri stay 24h. Returns whether a pull was
 *  stored, so the caller can skip the render on weekend days. */
export async function storeDailyOrders(env: Env): Promise<boolean> {
  if (!shopifyConfigured(env)) return false;
  const now = new Date();
  // Day of week in AEST (0 = Sunday … 6 = Saturday)
  const aestDay = new Date(now.getTime() + 10 * 3600_000).getUTCDay();
  if (aestDay === 6 || aestDay === 0) {
    await clog(env, "Daily gangsheet pull skipped: weekend (covered by Monday/Tuesday pulls)");
    return false;
  }
  // Monday: Fri 9am → Sun 9am; Tuesday: Sun 9am → Tue 9am; else last 24h
  const fromHoursAgo = aestDay === 1 ? 72 : aestDay === 2 ? 48 : 24;
  const toHoursAgo = aestDay === 1 ? 24 : 0;
  const from = new Date(now.getTime() - fromHoursAgo * 3600_000).toISOString();
  const to = new Date(now.getTime() - toHoursAgo * 3600_000).toISOString();
  try {
    const { csv, orders, items, rows, orderMeta } = await pullWindow(env, from, to);
    const date = aestDate(now);
    await env.GANGSHEET_FILES.put(`${DAILY_PREFIX}${date}.csv`, csv, {
      httpMetadata: { contentType: "text/csv" },
      customMetadata: { orders: String(orders), items: String(items), pulledAt: now.toISOString() },
    });
    // Stamp "PRIMING WIPES: X" into each order's Shopify note so pickers see
    // the count in the order view. Fail-soft: note trouble shouldn't kill the
    // pull.
    try {
      const { updated, unchanged, failed, totalWipes } = await annotateOrdersWithWipes(env, orderMeta, rows);
      await clog(env, `Priming-wipes notes: ${updated} updated, ${unchanged} unchanged, ${failed.length} failed — ${totalWipes} wipes total`);
      if (failed.length) await cerr(env, "Priming-wipes note failures:", failed.join("; "));
    } catch (error) {
      await cerr(env, "Priming-wipes note pass failed:", error);
    }
    await clog(env, `Daily gangsheet pull stored: ${date} — ${orders} orders, ${items} line items`);
    return true;
  } catch (error) {
    await cerr(env, "Daily gangsheet pull failed:", error);
    return false;
  }
}
