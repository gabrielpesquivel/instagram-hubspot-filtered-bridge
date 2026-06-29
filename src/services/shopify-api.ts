// Thin Shopify Admin GraphQL client. Read-only order/tracking lookups for the
// Customer Support inbox — by order name ("#1001") or by customer email.
// Mirrors the style of gmail-api.ts / instagram-api.ts: fail-soft, returns
// null/[] on any error. We never write to Shopify.
import type { Env } from "../types";
import { cerr } from "./logger";

export interface ShopifyOrderSummary {
  name: string;              // "#1001"
  createdAt: string;
  financialStatus: string;   // PAID, REFUNDED, ...
  fulfillmentStatus: string; // FULFILLED, UNFULFILLED, PARTIALLY_FULFILLED
  customerName: string;
  email: string;
  totalPrice: string;        // "24.50 AUD"
  lineItems: { title: string; variantTitle?: string; quantity: number }[];
  tracking: { company?: string; number?: string; url?: string }[];
  shippingCountry?: string;
}

// Shape of the GraphQL order node we request.
interface OrderNode {
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { presentmentMoney: { amount: string; currencyCode: string } } | null;
  customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
  shippingAddress: { country: string | null } | null;
  lineItems: { edges: { node: { title: string; variantTitle: string | null; quantity: number } }[] };
  fulfillments: { trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[];
}

interface OrdersResponse {
  data?: { orders?: { edges: { node: OrderNode }[] } };
  errors?: { message: string }[];
}

const ORDERS_QUERY = `query($q: String!, $n: Int!) {
  orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      name createdAt displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { presentmentMoney { amount currencyCode } }
      customer { firstName lastName email }
      shippingAddress { country }
      lineItems(first: 20) { edges { node { title variantTitle quantity } } }
      fulfillments { trackingInfo { company number url } }
    } }
  }
}`;

function normalize(node: OrderNode): ShopifyOrderSummary {
  const money = node.currentTotalPriceSet?.presentmentMoney;
  const first = node.customer?.firstName || "";
  const last = node.customer?.lastName || "";
  const tracking = node.fulfillments
    .flatMap((f) => f.trackingInfo || [])
    .map((t) => ({
      company: t.company || undefined,
      number: t.number || undefined,
      url: t.url || undefined,
    }))
    .filter((t) => t.number || t.url);
  return {
    name: node.name,
    createdAt: node.createdAt,
    financialStatus: node.displayFinancialStatus || "UNKNOWN",
    fulfillmentStatus: node.displayFulfillmentStatus || "UNKNOWN",
    customerName: `${first} ${last}`.trim(),
    email: node.customer?.email || "",
    totalPrice: money ? `${money.amount} ${money.currencyCode}` : "",
    lineItems: node.lineItems.edges.map((e) => {
      // Shopify returns "Default Title" for products with no real variants — drop it as noise.
      const variant = e.node.variantTitle && e.node.variantTitle !== "Default Title"
        ? e.node.variantTitle
        : undefined;
      return { title: e.node.title, ...(variant ? { variantTitle: variant } : {}), quantity: e.node.quantity };
    }),
    tracking,
    shippingCountry: node.shippingAddress?.country || undefined,
  };
}

/** True when the Worker has the creds needed to talk to Shopify. Used to gate
 *  the AI order-lookup tool so we don't offer a tool that can't work. */
export function shopifyConfigured(env: Env): boolean {
  return !!(env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
}

const TOKEN_KEY = "shopify_access_token";

// Get an Admin API access token via the client credentials grant, cached in KV.
// New Shopify (Dev Dashboard) apps no longer issue a static shpat_ token — we
// exchange the Client ID/Secret for a 24h token and refresh it before expiry.
async function getAccessToken(env: Env): Promise<string | null> {
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = env;
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    await cerr(env, "Shopify auth skipped: missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET");
    return null;
  }
  const cached = await env.PROFILE_CACHE.get(TOKEN_KEY);
  if (cached) return cached;
  try {
    const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
      }),
    });
    if (!res.ok) {
      await cerr(env, `Shopify token exchange ${res.status}:`, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      await cerr(env, "Shopify token exchange: no access_token in response");
      return null;
    }
    // Cache just under the 24h lifetime; refresh 5 min early to avoid races.
    const ttl = Math.max(60, (data.expires_in || 86399) - 300);
    await env.PROFILE_CACHE.put(TOKEN_KEY, data.access_token, { expirationTtl: ttl });
    return data.access_token;
  } catch (error) {
    await cerr(env, "Shopify token exchange error:", error);
    return null;
  }
}

// POST the orders query with a Shopify `query:` filter string, return summaries
// newest-first. Fail-soft: [] on any non-200 / GraphQL error / missing config.
async function queryOrders(env: Env, q: string, n: number): Promise<ShopifyOrderSummary[]> {
  const token = await getAccessToken(env);
  if (!token) return [];
  const version = env.SHOPIFY_API_VERSION || "2026-04";
  const endpoint = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${version}/graphql.json`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: ORDERS_QUERY, variables: { q, n } }),
    });
    if (!res.ok) {
      // Token revoked/expired early — drop it so the next call re-exchanges.
      if (res.status === 401) await env.PROFILE_CACHE.delete(TOKEN_KEY);
      await cerr(env, `Shopify API ${res.status}:`, await res.text().catch(() => ""));
      return [];
    }
    const data = (await res.json()) as OrdersResponse;
    if (data.errors?.length) {
      await cerr(env, "Shopify GraphQL errors:", data.errors.map((e) => e.message).join("; "));
      return [];
    }
    return (data.data?.orders?.edges || []).map((e) => normalize(e.node));
  } catch (error) {
    await cerr(env, "Shopify lookup error:", error);
    return [];
  }
}

const CACHE_TTL = 90; // seconds — short, just to absorb repeated thread opens

async function cached<T>(env: Env, key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = await env.PROFILE_CACHE.get(key);
  if (hit !== null) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      // fall through to refetch on a corrupt cache entry
    }
  }
  const value = await fetcher();
  await env.PROFILE_CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL });
  return value;
}

// "#1001" / "1001" -> a Shopify `name:` filter. Shopify stores names with the
// "#", and the search syntax matches with or without it.
function nameFilter(raw: string): string {
  const n = raw.trim().replace(/^#/, "");
  return `name:#${n}`;
}

/** Look up a single order by name/number ("#1001" or "1001"). Returns 0-1. */
export async function findOrderByName(env: Env, name: string): Promise<ShopifyOrderSummary | null> {
  const clean = name.trim().replace(/^#/, "");
  if (!clean) return null;
  const orders = await cached(env, `shopify_order:${clean}`, () =>
    queryOrders(env, nameFilter(clean), 1)
  );
  return orders[0] || null;
}

/** Recent orders for a customer email, newest-first, capped at `limit`. */
export async function findOrdersByEmail(
  env: Env,
  email: string,
  limit = 5
): Promise<ShopifyOrderSummary[]> {
  const clean = email.trim().toLowerCase();
  if (!clean) return [];
  return cached(env, `shopify_orders:${clean}`, () =>
    queryOrders(env, `email:${clean}`, limit)
  );
}
