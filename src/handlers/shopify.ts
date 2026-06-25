// Customer Support inbox -> Shopify order/tracking lookup (read-only).
// Feature 1: agent-driven lookup by order # or customer email.
import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr } from "../services/logger";
import { findOrderByName, findOrdersByEmail } from "../services/shopify-api";

/** GET /api/shopify/order?name=%231001 -> { order } | 404 */
export async function handleShopifyOrderLookup(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const name = new URL(request.url).searchParams.get("name")?.trim();
  if (!name) return jsonResponse({ error: "Missing order name" }, 400);
  try {
    const order = await findOrderByName(env, name);
    if (!order) return jsonResponse({ error: "Order not found" }, 404);
    return jsonResponse({ order });
  } catch (error) {
    await cerr(env, "Shopify order lookup error:", error);
    return jsonResponse({ error: "Lookup failed" }, 500);
  }
}

/** GET /api/shopify/orders?email=jane@x.com -> { orders } */
export async function handleShopifyOrdersByEmail(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const email = new URL(request.url).searchParams.get("email")?.trim();
  if (!email) return jsonResponse({ error: "Missing email" }, 400);
  try {
    const orders = await findOrdersByEmail(env, email);
    return jsonResponse({ orders });
  } catch (error) {
    await cerr(env, "Shopify orders-by-email error:", error);
    return jsonResponse({ error: "Lookup failed" }, 500);
  }
}
