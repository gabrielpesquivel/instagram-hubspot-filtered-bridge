import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { fetchGangsheetRows, fetchGangsheetRowsByOrderRange, shopifyConfigured } from "../services/shopify-api";
import { clog, cerr } from "../services/logger";

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
  const { rows, orderCount } = await fetchGangsheetRows(env, fromISO, toISO);
  return { csv: buildCsv(rows), orders: orderCount, items: rows.length };
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

/** Cron entry: pull the last 24h of orders and store the CSV in R2, labelled
 *  with the AEST date. Overwrites any earlier pull for the same day (rerunning
 *  the cron refreshes the snapshot). Fail-soft — a bad day logs and moves on. */
export async function storeDailyOrders(env: Env): Promise<void> {
  if (!shopifyConfigured(env)) return;
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const to = now.toISOString();
  try {
    const { csv, orders, items } = await pullWindow(env, from, to);
    const date = aestDate(now);
    await env.GANGSHEET_FILES.put(`${DAILY_PREFIX}${date}.csv`, csv, {
      httpMetadata: { contentType: "text/csv" },
      customMetadata: { orders: String(orders), items: String(items), pulledAt: to },
    });
    await clog(env, `Daily gangsheet pull stored: ${date} — ${orders} orders, ${items} line items`);
  } catch (error) {
    await cerr(env, "Daily gangsheet pull failed:", error);
  }
}
