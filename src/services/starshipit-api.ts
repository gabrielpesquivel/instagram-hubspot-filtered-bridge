// Thin StarShipit API client for order writes that must mirror Shopify changes
// (shipping address, email, cancellation). Mirrors the fail-soft style of
// shopify-api.ts / gmail-api.ts: every call returns a typed result and never
// throws; on any error it reports { ok:false, error } and logs via cerr.
//
// Auth: two headers on every request —
//   StarShipIT-Api-Key        per-account API key (StarShipit account)
//   Ocp-Apim-Subscription-Key developer subscription key
// Base URL: https://api.starshipit.com/api
//
// Endpoints + shapes VERIFIED against the live API (2026-06-30):
//   GET    /api/orders?order_number=%23<n>   → { order, success }  (order_number stored WITH '#')
//   PUT    /api/orders                        body { order: { order_id, destination } }
//   DELETE /api/orders/delete                 body { order_id }
// StarShipit rate-limits ~1 req/s (429 "Rate limit exceeded"); api() retries once.
import type { Env } from "../types";
import { cerr } from "./logger";

const BASE = "https://api.starshipit.com/api";

const EP = {
  // order_number is stored with the leading '#', e.g. "#18329" → must be encoded.
  getOrder: (orderNumber: string) =>
    `${BASE}/orders?order_number=${encodeURIComponent(orderNumber)}`,
  updateOrder: `${BASE}/orders`,
  deleteOrder: `${BASE}/orders/delete`,
} as const;

/** Structured `destination` object StarShipit stores on an order (verified field
 *  names). `street` is line 1; `suburb` is the secondary/suburb line. */
export interface StarShipitAddress {
  name?: string;
  company?: string;
  building?: string;
  street?: string;
  suburb?: string;
  city?: string;
  state?: string;
  post_code?: string;
  country?: string;      // full country name (e.g. "United Kingdom")
  email?: string;
}

interface StarShipitOrder {
  order_id: number;
  order_number?: string;
  status?: string;       // "Unshipped" | "Printed" | "Shipped" | "Delivered" | ...
  [k: string]: unknown;
}

export interface StarShipitResult {
  ok: boolean;
  skipped?: boolean;     // true when StarShipit isn't configured — not an error
  error?: string;
  order?: StarShipitOrder;
}

/** True when StarShipit creds are present. When false, every write below
 *  returns { ok:true, skipped:true } so the Shopify half still succeeds. */
export function starshipitConfigured(env: Env): boolean {
  return !!(env.STARSHIPIT_API_KEY && env.STARSHIPIT_SUBSCRIPTION_KEY);
}

function headers(env: Env): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "StarShipIT-Api-Key": env.STARSHIPIT_API_KEY,
    "Ocp-Apim-Subscription-Key": env.STARSHIPIT_SUBSCRIPTION_KEY,
  };
}

async function api<T>(
  env: Env,
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    let res = await fetch(url, { ...init, headers: { ...headers(env), ...(init.headers || {}) } });
    // StarShipit rate-limits ~1 req/s — back off once on 429.
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1200));
      res = await fetch(url, { ...init, headers: { ...headers(env), ...(init.headers || {}) } });
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      await cerr(env, `StarShipit ${init.method || "GET"} ${res.status}:`, text.slice(0, 500));
      return { ok: false, status: res.status, error: `StarShipit ${res.status}` };
    }
    return { ok: true, status: res.status, data: text ? (JSON.parse(text) as T) : undefined };
  } catch (error) {
    await cerr(env, "StarShipit request error:", error);
    return { ok: false, status: 0, error: "StarShipit request failed" };
  }
}

/** Look up a single StarShipit order by the Shopify order number. StarShipit
 *  stores the number WITH the leading '#' (e.g. "#18329"), so we always query
 *  with it. Returns the single `order` from the response. */
export async function findOrder(env: Env, orderNumber: string): Promise<StarShipitOrder | null> {
  if (!starshipitConfigured(env)) return null;
  const clean = orderNumber.trim().replace(/^#/, "");
  if (!clean) return null;
  const res = await api<{ order?: StarShipitOrder; data?: { orders?: StarShipitOrder[] } }>(
    env,
    EP.getOrder(`#${clean}`),
    { method: "GET" }
  );
  if (!res.ok || !res.data) return null;
  return res.data.order || res.data.data?.orders?.[0] || null;
}

/** Push a new shipping address onto the matching StarShipit order. No-op (ok)
 *  when not configured or when the order isn't found in StarShipit. */
export async function updateAddress(
  env: Env,
  orderNumber: string,
  addr: StarShipitAddress
): Promise<StarShipitResult> {
  if (!starshipitConfigured(env)) return { ok: true, skipped: true };
  const order = await findOrder(env, orderNumber);
  if (!order) return { ok: true, skipped: true, error: "order not in StarShipit" };
  // Overwrite the address lines, but carry over contact/handling fields the
  // agent didn't touch (email, phone, delivery_instructions).
  const old = (order.destination as Record<string, unknown> | undefined) || {};
  const destination: Record<string, unknown> = {
    email: old.email,
    phone: old.phone,
    delivery_instructions: old.delivery_instructions,
    ...addr,
  };
  const res = await api<{ order?: StarShipitOrder }>(env, EP.updateOrder, {
    method: "PUT",
    body: JSON.stringify({ order: { order_id: order.order_id, destination } }),
  });
  return res.ok ? { ok: true, order: res.data?.order } : { ok: false, error: res.error };
}

/** Push a new email onto the matching StarShipit order (tracking notices).
 *  Merges into the existing `destination` so the address isn't wiped (PUT
 *  replaces the whole destination object). */
export async function updateEmail(
  env: Env,
  orderNumber: string,
  email: string
): Promise<StarShipitResult> {
  if (!starshipitConfigured(env)) return { ok: true, skipped: true };
  const order = await findOrder(env, orderNumber);
  if (!order) return { ok: true, skipped: true, error: "order not in StarShipit" };
  const destination = { ...(order.destination as Record<string, unknown> | undefined), email };
  const res = await api<{ order?: StarShipitOrder }>(env, EP.updateOrder, {
    method: "PUT",
    body: JSON.stringify({ order: { order_id: order.order_id, destination } }),
  });
  return res.ok ? { ok: true, order: res.data?.order } : { ok: false, error: res.error };
}

/** Cancel an order in StarShipit by deleting it so no label prints. Safe no-op
 *  when not configured or order absent; refuses once the order has shipped. */
export async function cancelOrder(env: Env, orderNumber: string): Promise<StarShipitResult> {
  if (!starshipitConfigured(env)) return { ok: true, skipped: true };
  const order = await findOrder(env, orderNumber);
  if (!order) return { ok: true, skipped: true, error: "order not in StarShipit" };
  const status = String(order.status || "").toLowerCase();
  if (status === "shipped" || status === "delivered") {
    return { ok: false, error: `already ${status} in StarShipit — cannot delete` };
  }
  const res = await api(env, EP.deleteOrder, {
    method: "DELETE",
    body: JSON.stringify({ order_id: order.order_id }),
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
