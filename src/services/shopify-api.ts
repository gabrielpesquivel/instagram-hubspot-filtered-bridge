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
  lineItems: { id: string; variantId: string | null; title: string; quantity: number }[];
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
      lineItems(first: 50) { edges { node { id title quantity variant { id } } } }
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
      lineItems: { edges: { node: { id: string; title: string; quantity: number; variant: { id: string } | null } }[] };
    } }[] };
  }>(env, ORDER_CTX_QUERY, { q: `name:#${clean}` });
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

const ORDER_UPDATE = `mutation($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id }
    userErrors { field message }
  }
}`;

/** Overwrite the shipping address on an order. */
export async function updateShippingAddress(env: Env, orderId: string, addr: StructuredAddress): Promise<void> {
  const data = await adminGraphQL<{ orderUpdate: { userErrors: { field?: string[]; message: string }[] } }>(
    env,
    ORDER_UPDATE,
    { input: { id: orderId, shippingAddress: {
      firstName: addr.firstName, lastName: addr.lastName, company: addr.company,
      address1: addr.address1, address2: addr.address2, city: addr.city,
      province: addr.province, zip: addr.zip, country: addr.country, phone: addr.phone,
    } } }
  );
  const err = joinUserErrors(data.orderUpdate.userErrors);
  if (err) throw new Error(err);
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
    items: { variantId: string; quantity: number }[];
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
        zip: opts.shippingAddress.zip, country: opts.shippingAddress.country,
        phone: opts.shippingAddress.phone,
      },
      lineItems: opts.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
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
