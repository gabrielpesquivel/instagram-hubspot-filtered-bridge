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
  // Never cache an empty result. queryOrders() is fail-soft — it returns [] on a
  // transport/auth/GraphQL error just as it does for a genuine "no such order".
  // Caching that would pin a "not found" for the full TTL even after a transient
  // Shopify hiccup clears, so the agent keeps seeing "order not found" on retry.
  if (Array.isArray(value) && value.length === 0) return value;
  await env.PROFILE_CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL });
  return value;
}

// "#1001" / "1001" -> a Shopify `name:` filter. Shopify stores names with the
// "#", but tokenises it away in the search index, so match both the "#1001" and
// "1001" forms with an OR to be robust to how a given order name got indexed.
// (This is a syntax safeguard only — it can't surface orders the app can't see,
// e.g. those older than 60 days without the read_all_orders scope.)
function nameFilter(raw: string): string {
  const n = raw.trim().replace(/^#/, "");
  return `name:#${n} OR name:${n}`;
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
  // Quote the email: it contains "@" and "." which Shopify's search parser
  // treats as token separators. Unquoted (`email:bob@gmail.com`) the lookup
  // often returns nothing or the wrong order; quoted it's an exact match.
  return cached(env, `shopify_orders:${clean}`, () =>
    queryOrders(env, `email:"${clean}"`, limit)
  );
}

// ── Gangsheet order pull ──────────────────────────────────────────────────────
// Replaces the daily Matrixify CSV export: fetch orders created in a window and
// shape them into the exact rows the gangsheet generator's CSV parser expects.

export interface GangsheetLineRow {
  orderNumber: string;      // "12646" (no #)
  lineName: string;         // "Initials - CUSTOM INITIALS / BLACK"
  variantTitle: string;
  quantity: number;         // currentQuantity — refunds/removals already deducted
  properties: string;       // newline-joined "key: value" pairs, values \:-escaped
}

const GANGSHEET_ORDERS_QUERY = `query($q: String!, $n: Int!, $cursor: String) {
  orders(first: $n, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      name cancelledAt
      lineItems(first: 100) { edges { node {
        name variantTitle currentQuantity
        customAttributes { key value }
      } } }
    } }
  }
}`;

/** All printable line rows for orders created in [from, to). Skips cancelled
 *  orders; uses currentQuantity so refunded/removed items are already deducted
 *  (the Admin API gives us the clean number the CSV export never had). Throws
 *  on API errors — the caller needs to distinguish "no orders" from "failed". */
export async function fetchGangsheetRows(
  env: Env,
  fromISO: string,
  toISO: string,
  // Optional inclusive order-number filter applied on top of the date window
  // (used by the order-range pull, where the window merely brackets the range).
  orderRange?: { lo: number; hi: number }
): Promise<{ rows: GangsheetLineRow[]; orderCount: number }> {
  type Node = {
    name: string;
    cancelledAt: string | null;
    lineItems: { edges: { node: {
      name: string; variantTitle: string | null; currentQuantity: number;
      customAttributes: { key: string; value: string | null }[];
    } }[] };
  };
  const q = `created_at:>='${fromISO}' created_at:<'${toISO}'`;
  const rows: GangsheetLineRow[] = [];
  let orderCount = 0;
  let cursor: string | null = null;
  // 20 pages × 50 = 1000 orders — far above any real day; guards a runaway loop.
  for (let page = 0; page < 20; page++) {
    const data: {
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: Node }[] };
    } = await adminGraphQL(env, GANGSHEET_ORDERS_QUERY, { q, n: 50, cursor });
    for (const { node } of data.orders.edges) {
      if (node.cancelledAt) continue;
      if (orderRange) {
        const num = Number(node.name.replace(/^#/, ""));
        if (!(num >= orderRange.lo && num <= orderRange.hi)) continue;
      }
      orderCount++;
      for (const { node: li } of node.lineItems.edges) {
        if (li.currentQuantity <= 0) continue; // fully refunded/removed
        const properties = li.customAttributes
          .map((a) => `${a.key}: ${(a.value || "").replace(/:/g, "\\:")}`)
          .join("\n");
        rows.push({
          orderNumber: node.name.replace(/^#/, ""),
          lineName: li.name,
          variantTitle: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "",
          quantity: li.currentQuantity,
          properties,
        });
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  return { rows, orderCount };
}

/** createdAt of a single order looked up by number — used to anchor the
 *  order-number-range pull. Throws when the order can't be found (typo, or
 *  older than 60 days without the read_all_orders scope). */
async function orderCreatedAt(env: Env, orderNumber: number): Promise<string> {
  const data = await adminGraphQL<{ orders: { edges: { node: { createdAt: string } }[] } }>(
    env,
    `query($q: String!) { orders(first: 1, query: $q) { edges { node { createdAt } } } }`,
    { q: nameFilter(String(orderNumber)) }
  );
  const node = data.orders.edges[0]?.node;
  if (!node) throw new Error(`Order #${orderNumber} not found`);
  return node.createdAt;
}

/** First and last order numbers created in [from, to) — a cheap preview for the
 *  dashboard's time↔order-number sync (two 1-order queries, no line items).
 *  Returns null when the window contains no orders. */
export async function orderRangeForWindow(
  env: Env,
  fromISO: string,
  toISO: string
): Promise<{ fromOrder: number; toOrder: number } | null> {
  const q = `created_at:>='${fromISO}' created_at:<'${toISO}'`;
  const one = `query($q: String!, $rev: Boolean!) {
    orders(first: 1, query: $q, sortKey: CREATED_AT, reverse: $rev) { edges { node { name } } }
  }`;
  type Resp = { orders: { edges: { node: { name: string } }[] } };
  const [first, last] = await Promise.all([
    adminGraphQL<Resp>(env, one, { q, rev: false }),
    adminGraphQL<Resp>(env, one, { q, rev: true }),
  ]);
  const lo = Number(first.orders.edges[0]?.node.name.replace(/^#/, ""));
  const hi = Number(last.orders.edges[0]?.node.name.replace(/^#/, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { fromOrder: lo, toOrder: hi };
}

/** createdAt timestamps of two endpoint orders — the inverse preview (order
 *  numbers → time window). Throws when either order can't be found. */
export async function windowForOrderRange(
  env: Env,
  fromOrder: number,
  toOrder: number
): Promise<{ from: string; to: string }> {
  const [lo, hi] = fromOrder <= toOrder ? [fromOrder, toOrder] : [toOrder, fromOrder];
  const [loCreated, hiCreated] = await Promise.all([
    orderCreatedAt(env, lo),
    lo === hi ? orderCreatedAt(env, lo) : orderCreatedAt(env, hi),
  ]);
  return { from: loCreated, to: hiCreated };
}

/** Printable line rows for an inclusive order-number range. Shopify has no
 *  order-number range filter, but numbers are assigned in creation order, so
 *  the two endpoint orders' createdAt bracket the whole range: pull that date
 *  window, then keep only rows whose number falls inside the range. */
export async function fetchGangsheetRowsByOrderRange(
  env: Env,
  fromOrder: number,
  toOrder: number
): Promise<{ rows: GangsheetLineRow[]; orderCount: number }> {
  const [lo, hi] = fromOrder <= toOrder ? [fromOrder, toOrder] : [toOrder, fromOrder];
  const [loCreated, hiCreated] = await Promise.all([
    orderCreatedAt(env, lo),
    lo === hi ? orderCreatedAt(env, lo) : orderCreatedAt(env, hi),
  ]);
  // created_at:< is exclusive — nudge past the last order's timestamp.
  const toISO = new Date(Date.parse(hiCreated) + 1000).toISOString();
  return fetchGangsheetRows(env, loCreated, toISO, { lo, hi });
}

// ── Writes ───────────────────────────────────────────────────────────────────
// Mutations behind the agent-confirmed order actions. Unlike the read path these
// THROW on failure (with a useful message) so the handler can report it to the
// agent rather than silently fail-soft. They need the `write_orders` scope on the
// Shopify app — when it's missing the API returns an access-denied error which we
// surface verbatim. getAccessToken() is reused from the read path.

/** Canonical structured address used across the action endpoints + StarShipit. */
export interface StructuredAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;   // state/region — name or code
  zip?: string;
  country: string;     // name or ISO code
  phone?: string;
}

export interface OrderWriteContext {
  id: string;                  // gid://shopify/Order/123
  name: string;                // "#1001"
  email: string;
  fulfillmentStatus: string;   // FULFILLED | UNFULFILLED | PARTIALLY_FULFILLED
  financialStatus: string;
  cancelledAt: string | null;
  currency: string;            // presentment currency, for refunds
  shippingAddress: StructuredAddress | null;
  lineItems: {
    id: string;
    variantId: string | null;
    title: string;
    quantity: number;
    currentQuantity: number;    // after prior refunds/removals — max refundable
    unitPrice: string;
    properties: { key: string; value: string }[];
  }[];
}

const GRAPHQL_ENDPOINT = (env: Env) =>
  `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION || "2026-04"}/graphql.json`;

interface GraphQLResult<T> { data?: T; errors?: { message: string }[]; }

/** POST an arbitrary Admin GraphQL query/mutation. Throws on transport, HTTP,
 *  or top-level GraphQL errors. userErrors on mutation payloads are the
 *  caller's responsibility to check. */
async function adminGraphQL<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken(env);
  if (!token) throw new Error("Shopify not configured (no access token)");
  const res = await fetch(GRAPHQL_ENDPOINT(env), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    if (res.status === 401) await env.PROFILE_CACHE.delete(TOKEN_KEY);
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify API ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as GraphQLResult<T>;
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("Shopify API returned no data");
  return json.data;
}

function joinUserErrors(errs: { field?: string[] | null; message: string }[] | undefined): string {
  return (errs || []).map((e) => `${(e.field || []).join(".")}: ${e.message}`).join("; ");
}

/** True when the order has any fulfillment (so an address change is too late). */
export function isFulfilled(ctx: OrderWriteContext): boolean {
  return ctx.fulfillmentStatus === "FULFILLED" || ctx.fulfillmentStatus === "PARTIALLY_FULFILLED";
}

const ORDER_CTX_QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    edges { node {
      id name email cancelledAt
      displayFulfillmentStatus displayFinancialStatus
      currentTotalPriceSet { presentmentMoney { currencyCode } }
      shippingAddress { firstName lastName company address1 address2 city province zip country phone }
      lineItems(first: 50) { edges { node {
        id title quantity currentQuantity
        originalUnitPriceSet { presentmentMoney { amount } }
        variant { id } customAttributes { key value }
      } } }
    } }
  }
}`;

/** Fetch the gid + status + line items needed by the write mutations. Bypasses
 *  the read-path cache so we always act on current order state. Returns null if
 *  no order matches. */
export async function getOrderForWrite(env: Env, name: string): Promise<OrderWriteContext | null> {
  const clean = name.trim().replace(/^#/, "");
  if (!clean) return null;
  type AddrNode = {
    firstName: string | null; lastName: string | null; company: string | null;
    address1: string | null; address2: string | null; city: string | null;
    province: string | null; zip: string | null; country: string | null; phone: string | null;
  };
  const data = await adminGraphQL<{
    orders: { edges: { node: {
      id: string; name: string; email: string | null; cancelledAt: string | null;
      displayFulfillmentStatus: string | null; displayFinancialStatus: string | null;
      currentTotalPriceSet: { presentmentMoney: { currencyCode: string } } | null;
      shippingAddress: AddrNode | null;
      lineItems: { edges: { node: { id: string; title: string; quantity: number; currentQuantity: number; originalUnitPriceSet: { presentmentMoney: { amount: string } } | null; variant: { id: string } | null; customAttributes: { key: string; value: string | null }[] } }[] };
    } }[] };
  }>(env, ORDER_CTX_QUERY, { q: `name:#${clean} OR name:${clean}` });
  const node = data.orders.edges[0]?.node;
  if (!node) return null;
  const a = node.shippingAddress;
  return {
    id: node.id,
    name: node.name,
    email: node.email || "",
    fulfillmentStatus: node.displayFulfillmentStatus || "UNKNOWN",
    financialStatus: node.displayFinancialStatus || "UNKNOWN",
    cancelledAt: node.cancelledAt,
    currency: node.currentTotalPriceSet?.presentmentMoney.currencyCode || "AUD",
    shippingAddress: a && a.address1 && a.city && a.country ? {
      firstName: a.firstName || undefined, lastName: a.lastName || undefined, company: a.company || undefined,
      address1: a.address1, address2: a.address2 || undefined, city: a.city,
      province: a.province || undefined, zip: a.zip || undefined, country: a.country, phone: a.phone || undefined,
    } : null,
    lineItems: node.lineItems.edges.map((e) => ({
      id: e.node.id,
      variantId: e.node.variant?.id || null,
      title: e.node.title,
      quantity: e.node.quantity,
      currentQuantity: e.node.currentQuantity ?? e.node.quantity,
      unitPrice: e.node.originalUnitPriceSet?.presentmentMoney.amount || "0",
      properties: (e.node.customAttributes || [])
        .filter((a) => a.value != null && a.value !== "")
        .map((a) => ({ key: a.key, value: a.value as string })),
    })),
  };
}

const VARIANT_SEARCH = `query($q: String!) {
  productVariants(first: 12, query: $q) {
    edges { node { id title displayName price product { title } } }
  }
}`;

export interface VariantHit {
  variantId: string;
  label: string;   // "Product — Variant"
  price: string;
}

/** Search product variants by free text, for the add-to-order picker. */
export async function searchProductVariants(env: Env, q: string): Promise<VariantHit[]> {
  const clean = q.trim();
  if (!clean) return [];
  const data = await adminGraphQL<{
    productVariants: { edges: { node: { id: string; title: string; displayName: string; price: string; product: { title: string } } }[] };
  }>(env, VARIANT_SEARCH, { q: clean });
  return data.productVariants.edges.map((e) => ({
    variantId: e.node.id,
    label: e.node.displayName || `${e.node.product.title} — ${e.node.title}`,
    price: e.node.price,
  }));
}

// Shopify's MailingAddressInput.country wants a canonical English country name —
// it rejects common free-text/customer variants like "UK", "USA", "England".
// Map the variants we actually see (BootInk's ship-to list + obvious aliases) to
// the name Shopify accepts; anything not listed is passed through unchanged.
const COUNTRY_CANON: Record<string, string> = {
  "australia": "Australia", "au": "Australia", "aus": "Australia",
  "new zealand": "New Zealand", "nz": "New Zealand", "nzl": "New Zealand",
  "united states": "United States", "united states of america": "United States",
  "usa": "United States", "us": "United States", "u s a": "United States", "america": "United States",
  "canada": "Canada", "can": "Canada",
  "united kingdom": "United Kingdom", "uk": "United Kingdom", "u k": "United Kingdom",
  "great britain": "United Kingdom", "britain": "United Kingdom", "gb": "United Kingdom", "gbr": "United Kingdom",
  "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom", "northern ireland": "United Kingdom",
  "austria": "Austria", "belgium": "Belgium", "denmark": "Denmark",
  "france": "France", "germany": "Germany", "deutschland": "Germany",
  "iceland": "Iceland", "ireland": "Ireland", "italy": "Italy", "italia": "Italy",
  "monaco": "Monaco", "netherlands": "Netherlands", "the netherlands": "Netherlands", "holland": "Netherlands",
  "norway": "Norway", "poland": "Poland", "polska": "Poland", "portugal": "Portugal",
  "spain": "Spain", "espana": "Spain", "españa": "Spain", "sweden": "Sweden", "switzerland": "Switzerland",
  "singapore": "Singapore", "hong kong": "Hong Kong", "japan": "Japan", "nippon": "Japan",
  "south korea": "South Korea", "korea": "South Korea", "republic of korea": "South Korea",
};

/** Normalise a free-text country to the canonical name Shopify accepts. Strips
 *  punctuation and case so "U.S.A." / "u.k." resolve; unknown values pass through
 *  so we never block a valid-but-unlisted country. */
export function canonCountry(raw: string | undefined): string {
  const c = (raw || "").trim();
  if (!c) return c;
  const key = c.toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ");
  return COUNTRY_CANON[key] || c;
}

const ORDER_UPDATE = `mutation($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id }
    userErrors { field message }
  }
}`;

// userError messages that mean "the province/region doesn't fit the country" —
// used to decide whether dropping the province and retrying is worth a shot.
const ADDRESS_REGION_ERROR = /provinc|countr|\bregion\b|\bstate\b|\bzone\b/i;

/** One orderUpdate with the given shippingAddress; throws joined userErrors. */
async function runShippingAddressUpdate(
  env: Env,
  orderId: string,
  shippingAddress: Record<string, unknown>
): Promise<void> {
  const data = await adminGraphQL<{ orderUpdate: { userErrors: { field?: string[]; message: string }[] } }>(
    env,
    ORDER_UPDATE,
    { input: { id: orderId, shippingAddress } }
  );
  const err = joinUserErrors(data.orderUpdate.userErrors);
  if (err) throw new Error(err);
}

/** Overwrite the shipping address on an order. Hardened against the two ways
 *  Shopify rejects an otherwise-fine address:
 *   1. Country aliases ("UK"/"USA"/"England") → normalise to the canonical name.
 *   2. A province that doesn't belong to the destination country (most UK/EU/Asia
 *      addresses have no Shopify subdivision) → retry once without the province if
 *      the first attempt fails on a province/country/region error. */
export async function updateShippingAddress(env: Env, orderId: string, addr: StructuredAddress): Promise<void> {
  const base: Record<string, unknown> = {
    firstName: addr.firstName, lastName: addr.lastName, company: addr.company,
    address1: addr.address1, address2: addr.address2, city: addr.city,
    zip: addr.zip, country: canonCountry(addr.country), phone: addr.phone,
  };
  const province = addr.province?.trim();
  try {
    await runShippingAddressUpdate(env, orderId, province ? { ...base, province } : base);
  } catch (error) {
    if (province && error instanceof Error && ADDRESS_REGION_ERROR.test(error.message)) {
      // Province likely doesn't apply to this country — drop it and retry once.
      await runShippingAddressUpdate(env, orderId, base);
      return;
    }
    throw error;
  }
}

/** Change the email on an order. */
export async function updateOrderEmail(env: Env, orderId: string, email: string): Promise<void> {
  const data = await adminGraphQL<{ orderUpdate: { userErrors: { field?: string[]; message: string }[] } }>(
    env,
    ORDER_UPDATE,
    { input: { id: orderId, email } }
  );
  const err = joinUserErrors(data.orderUpdate.userErrors);
  if (err) throw new Error(err);
}

const ORDER_CANCEL = `mutation($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notify: Boolean) {
  orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notify) {
    job { id }
    orderCancelUserErrors { field message }
  }
}`;

/** Cancel an order with a full refund. `restock`/`notify` are caller choices;
 *  `reason` is a Shopify OrderCancelReason enum (CUSTOMER, DECLINED, FRAUD,
 *  INVENTORY, STAFF, OTHER). */
export async function cancelOrderFull(
  env: Env,
  orderId: string,
  opts: { reason: string; restock: boolean; notify: boolean }
): Promise<void> {
  const data = await adminGraphQL<{ orderCancel: { orderCancelUserErrors: { field?: string[]; message: string }[] } }>(
    env,
    ORDER_CANCEL,
    { orderId, reason: opts.reason, refund: true, restock: opts.restock, notify: opts.notify }
  );
  const err = joinUserErrors(data.orderCancel.orderCancelUserErrors);
  if (err) throw new Error(err);
}

const REFUND_CREATE = `mutation($input: RefundInput!) {
  refundCreate(input: $input) {
    refund { id }
    userErrors { field message }
  }
}`;

const ORDER_TXNS = `query($id: ID!) {
  order(id: $id) {
    transactions(first: 10) { id kind status gateway parentTransaction { id } }
  }
}`;

/** Find the parent sale/capture transaction to refund against. */
async function parentRefundTransaction(env: Env, orderId: string): Promise<{ parentId: string; gateway: string }> {
  const data = await adminGraphQL<{ order: { transactions: { id: string; kind: string; status: string; gateway: string; parentTransaction: { id: string } | null }[] } | null }>(
    env, ORDER_TXNS, { id: orderId }
  );
  const txns = data.order?.transactions || [];
  // Prefer a successful SALE or CAPTURE; that is the transaction a REFUND parents to.
  const parent = txns.find((t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS")
    || txns.find((t) => t.status === "SUCCESS");
  if (!parent) throw new Error("No refundable transaction on this order");
  return { parentId: parent.id, gateway: parent.gateway };
}

/** Issue a partial refund of a fixed `amount` WITHOUT cancelling the order, by
 *  posting a manual REFUND transaction against the order's sale transaction. */
export async function refundAmount(
  env: Env,
  orderId: string,
  amount: string,
  currency: string,
  opts: { notify: boolean; note?: string }
): Promise<void> {
  const { parentId, gateway } = await parentRefundTransaction(env, orderId);
  const data = await adminGraphQL<{ refundCreate: { userErrors: { field?: string[]; message: string }[] } }>(
    env,
    REFUND_CREATE,
    { input: {
      orderId,
      note: opts.note,
      notify: opts.notify,
      transactions: [{ orderId, parentId, gateway, kind: "REFUND", amount }],
    } }
  );
  void currency; // amount is in the order's currency; Shopify validates against the parent txn
  const err = joinUserErrors(data.refundCreate.userErrors);
  if (err) throw new Error(err);
}

// ── item-based refunds (Shopify-admin style) ─────────────────────────────────
// The agent picks exact line items + quantities; Shopify's suggestedRefund
// calculates the correct amount (unit prices, taxes, discounts, prior refunds)
// and which transaction(s) to refund against — the same engine the admin UI uses.

export interface RefundItemSel { lineItemId: string; quantity: number }

export interface RefundSuggestion {
  amount: string;
  currency: string;
  tax: string;
  shippingAmount: string;      // shipping included in this suggestion
  maxShipping: string;         // shipping still refundable on the order
  transactions: { parentId: string; gateway: string; amount: string }[];
}

const SUGGESTED_REFUND_QUERY = `query($id: ID!, $refundLineItems: [RefundLineItemInput!], $refundShipping: Boolean) {
  order(id: $id) {
    suggestedRefund(refundLineItems: $refundLineItems, refundShipping: $refundShipping) {
      amountSet { presentmentMoney { amount currencyCode } }
      totalTaxSet { presentmentMoney { amount } }
      shipping { amountSet { presentmentMoney { amount } } maximumRefundableSet { presentmentMoney { amount } } }
      suggestedTransactions { amountSet { presentmentMoney { amount } } gateway parentTransaction { id } }
    }
  }
}`;

/** Ask Shopify what refunding the given line items (+ optionally shipping) is
 *  worth. Throws when the order is missing or nothing is refundable. */
export async function suggestRefund(
  env: Env,
  orderId: string,
  items: RefundItemSel[],
  refundShipping: boolean
): Promise<RefundSuggestion> {
  const data = await adminGraphQL<{
    order: {
      suggestedRefund: {
        amountSet: { presentmentMoney: { amount: string; currencyCode: string } };
        totalTaxSet: { presentmentMoney: { amount: string } };
        shipping: { amountSet: { presentmentMoney: { amount: string } }; maximumRefundableSet: { presentmentMoney: { amount: string } } } | null;
        suggestedTransactions: { amountSet: { presentmentMoney: { amount: string } }; gateway: string; parentTransaction: { id: string } | null }[];
      } | null;
    } | null;
  }>(env, SUGGESTED_REFUND_QUERY, {
    id: orderId,
    refundLineItems: items.map((i) => ({ lineItemId: i.lineItemId, quantity: i.quantity })),
    refundShipping,
  });
  const s = data.order?.suggestedRefund;
  if (!s) throw new Error("Shopify could not calculate a refund for this selection");
  return {
    amount: s.amountSet.presentmentMoney.amount,
    currency: s.amountSet.presentmentMoney.currencyCode,
    tax: s.totalTaxSet.presentmentMoney.amount,
    shippingAmount: s.shipping?.amountSet.presentmentMoney.amount || "0",
    maxShipping: s.shipping?.maximumRefundableSet.presentmentMoney.amount || "0",
    transactions: s.suggestedTransactions
      .filter((t) => t.parentTransaction)
      .map((t) => ({ parentId: t.parentTransaction!.id, gateway: t.gateway, amount: t.amountSet.presentmentMoney.amount })),
  };
}

/** Refund specific line items (+ optionally shipping) without cancelling the
 *  order. Amount and target transaction come from suggestedRefund; an explicit
 *  `amountOverride` replaces the money amount (single-transaction orders only).
 *  Items are NOT restocked — BootInk products are custom-printed. Returns what
 *  was refunded. */
export async function refundOrderItems(
  env: Env,
  orderId: string,
  items: RefundItemSel[],
  opts: { notify: boolean; note?: string; refundShipping: boolean; amountOverride?: string }
): Promise<{ amount: string; currency: string }> {
  const s = await suggestRefund(env, orderId, items, opts.refundShipping);
  if (!s.transactions.length) throw new Error("No refundable transaction on this order");

  let transactions = s.transactions.map((t) => ({
    orderId,
    parentId: t.parentId,
    gateway: t.gateway,
    kind: "REFUND",
    amount: t.amount,
  }));
  let amount = s.amount;
  if (opts.amountOverride) {
    if (transactions.length > 1) {
      throw new Error("Manual amount override isn't supported when the order was paid across multiple transactions — use the calculated amount");
    }
    transactions = [{ ...transactions[0], amount: opts.amountOverride }];
    amount = opts.amountOverride;
  }

  const data = await adminGraphQL<{ refundCreate: { userErrors: { field?: string[]; message: string }[] } }>(
    env,
    REFUND_CREATE,
    { input: {
      orderId,
      note: opts.note,
      notify: opts.notify,
      refundLineItems: items.map((i) => ({ lineItemId: i.lineItemId, quantity: i.quantity, restockType: "NO_RESTOCK" })),
      ...(opts.refundShipping ? { shipping: { fullRefund: true } } : {}),
      transactions,
    } }
  );
  const err = joinUserErrors(data.refundCreate.userErrors);
  if (err) throw new Error(err);
  return { amount, currency: s.currency };
}

const DRAFT_CREATE = `mutation($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id }
    userErrors { field message }
  }
}`;
const DRAFT_COMPLETE = `mutation($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: false) {
    draftOrder { id order { id name } }
    userErrors { field message }
  }
}`;

/** Create a $0 replacement order cloning the SELECTED line items of an original
 *  order. Builds a draft order with a 100% discount (so total is $0), then
 *  completes it into a real order ready to fulfil. StarShipit auto-imports the
 *  new order from Shopify, so no StarShipit write is needed here. Returns the new
 *  order's name (e.g. "#1042"). */
export async function createReplacementOrder(
  env: Env,
  opts: {
    email: string;
    shippingAddress: StructuredAddress;
    items: { variantId: string; quantity: number; properties?: { key: string; value: string }[] }[];
    note?: string;
  }
): Promise<string> {
  const created = await adminGraphQL<{ draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { field?: string[]; message: string }[] } }>(
    env,
    DRAFT_CREATE,
    { input: {
      email: opts.email,
      note: opts.note || "Replacement order",
      tags: ["replacement"],
      shippingAddress: {
        firstName: opts.shippingAddress.firstName, lastName: opts.shippingAddress.lastName,
        address1: opts.shippingAddress.address1, address2: opts.shippingAddress.address2,
        city: opts.shippingAddress.city, province: opts.shippingAddress.province,
        zip: opts.shippingAddress.zip, country: canonCountry(opts.shippingAddress.country),
        phone: opts.shippingAddress.phone,
      },
      lineItems: opts.items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity,
        // Line item properties (custom names, initials, etc.) — without these
        // the replacement renders blank on the gangsheet.
        ...(i.properties?.length ? { customAttributes: i.properties } : {}),
      })),
      appliedDiscount: { valueType: "PERCENTAGE", value: 100, description: "Replacement (no charge)" },
    } }
  );
  const cErr = joinUserErrors(created.draftOrderCreate.userErrors);
  if (cErr) throw new Error(cErr);
  const draftId = created.draftOrderCreate.draftOrder?.id;
  if (!draftId) throw new Error("Draft order not created");

  const done = await adminGraphQL<{ draftOrderComplete: { draftOrder: { order: { name: string } | null } | null; userErrors: { field?: string[]; message: string }[] } }>(
    env,
    DRAFT_COMPLETE,
    { id: draftId }
  );
  const dErr = joinUserErrors(done.draftOrderComplete.userErrors);
  if (dErr) throw new Error(dErr);
  return done.draftOrderComplete.draftOrder?.order?.name || "(new order)";
}

const EDIT_BEGIN = `mutation($id: ID!) {
  orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } }
}`;
const EDIT_ADD = `mutation($id: ID!, $variantId: ID!, $qty: Int!) {
  orderEditAddVariant(id: $id, variantId: $variantId, quantity: $qty, allowDuplicates: true) {
    calculatedOrder { id } userErrors { field message }
  }
}`;
const EDIT_COMMIT = `mutation($id: ID!, $notify: Boolean!, $note: String) {
  orderEditCommit(id: $id, notifyCustomer: $notify, staffNote: $note) {
    order { id } userErrors { field message }
  }
}`;

/** Add line items to an existing order via an order-editing session. When
 *  `notify` is true Shopify emails the customer about the edit including a
 *  payment link for the added amount — that is the "invoice". */
export async function addItemsToOrder(
  env: Env,
  orderId: string,
  items: { variantId: string; quantity: number }[],
  opts: { notify: boolean; note?: string }
): Promise<void> {
  const begin = await adminGraphQL<{ orderEditBegin: { calculatedOrder: { id: string } | null; userErrors: { field?: string[]; message: string }[] } }>(
    env, EDIT_BEGIN, { id: orderId }
  );
  const bErr = joinUserErrors(begin.orderEditBegin.userErrors);
  if (bErr) throw new Error(bErr);
  const calcId = begin.orderEditBegin.calculatedOrder?.id;
  if (!calcId) throw new Error("Could not begin order edit");

  for (const item of items) {
    const add = await adminGraphQL<{ orderEditAddVariant: { userErrors: { field?: string[]; message: string }[] } }>(
      env, EDIT_ADD, { id: calcId, variantId: item.variantId, qty: item.quantity }
    );
    const aErr = joinUserErrors(add.orderEditAddVariant.userErrors);
    if (aErr) throw new Error(aErr);
  }

  const commit = await adminGraphQL<{ orderEditCommit: { userErrors: { field?: string[]; message: string }[] } }>(
    env, EDIT_COMMIT, { id: orderId, notify: opts.notify, note: opts.note || "Items added per customer request" }
  );
  const cErr = joinUserErrors(commit.orderEditCommit.userErrors);
  if (cErr) throw new Error(cErr);
}
