// Order WRITE actions confirmed by an agent in the dashboard. Each endpoint maps
// one detected AI action (update_address, update_email, cancel_refund,
// duplicate_order, add_to_order) to the matching Shopify mutation, and mirrors
// shipping-relevant changes into StarShipit so the printed label stays correct.
//
// Safety model:
//  - All endpoints require a valid session (agent already logged in).
//  - Writes need the Shopify `write_orders` scope + creds. When unconfigured we
//    return { error, configured:false } and never touch anything (dormant).
//  - StarShipit is optional: when its creds are unset the StarShipit half is a
//    no-op ({ skipped:true }) and the Shopify write still succeeds.
//  - Guards (e.g. no address change after fulfilment) are enforced server-side,
//    not just in the UI.
import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr, clog } from "../services/logger";
import {
  shopifyConfigured,
  getOrderForWrite,
  isFulfilled,
  updateShippingAddress,
  updateOrderEmail,
  cancelOrderFull,
  refundAmount,
  refundOrderItems,
  suggestRefund,
  type RefundItemSel,
  createReplacementOrder,
  addItemsToOrder,
  searchProductVariants,
  canonCountry,
  createSingleUseDiscount,
  currentScopes,
  type StructuredAddress,
  type OrderWriteContext,
} from "../services/shopify-api";
import {
  starshipitConfigured,
  updateAddress as ssUpdateAddress,
  updateEmail as ssUpdateEmail,
  cancelOrder as ssCancelOrder,
  type StarShipitAddress,
} from "../services/starshipit-api";
import { parseAddress } from "../services/gemini-api";

// ── parse free-text address → structured fields (for the review modal) ─────────
// Body: { text } -> { address: ParsedAddress }. No write; just Gemini parsing.
export async function handleParseAddress(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  let text = "";
  try {
    text = String(((await request.json()) as { text?: unknown }).text || "").trim();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!text) return jsonResponse({ address: {} });
  const address = await parseAddress(text, env);
  return jsonResponse({ address });
}

/** Common preamble: auth + Shopify-configured gate + JSON body parse. Returns
 *  either a Response (to return early) or the parsed body. */
async function guard(request: Request, env: Env): Promise<Response | Record<string, unknown>> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!shopifyConfigured(env)) {
    return jsonResponse({ error: "Shopify writes not configured", configured: false }, 503);
  }
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
}

// Shown when Shopify returns no order for a number the customer says exists —
// by far the most common cause is the 60-day order visibility limit.
const NOT_FOUND_HINT =
  "If it exists, it may be older than 60 days — the Shopify app needs the read_all_orders scope to see orders past 60 days.";

/** Resolve the order or return a 404 Response. */
async function loadOrder(env: Env, orderNumber: string): Promise<OrderWriteContext | Response> {
  const clean = String(orderNumber || "").trim().replace(/^#/, "");
  if (!clean) return jsonResponse({ error: "Missing order number" }, 400);
  const ctx = await getOrderForWrite(env, clean);
  if (!ctx) return jsonResponse({ error: `Order #${clean} not found. ${NOT_FOUND_HINT}` }, 404);
  return ctx;
}

/** Map our canonical address to StarShipit's destination shape. */
function toStarShipit(addr: StructuredAddress): StarShipitAddress {
  return {
    name: [addr.firstName, addr.lastName].filter(Boolean).join(" ") || undefined,
    company: addr.company,
    street: addr.address1,
    suburb: addr.address2,
    city: addr.city,
    state: addr.province,
    post_code: addr.zip,
    country: canonCountry(addr.country),
  };
}

function asAddress(raw: unknown): StructuredAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const address1 = str(a.address1), city = str(a.city), country = str(a.country);
  if (!address1 || !city || !country) return null; // minimum to ship
  return {
    firstName: str(a.firstName) || undefined,
    lastName: str(a.lastName) || undefined,
    company: str(a.company) || undefined,
    address1,
    address2: str(a.address2) || undefined,
    city,
    province: str(a.province) || undefined,
    zip: str(a.zip) || undefined,
    country,
    phone: str(a.phone) || undefined,
  };
}

// ── update_address ───────────────────────────────────────────────────────────
// Body: { orderNumber, address: StructuredAddress }
export async function handleUpdateAddress(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;
  const order = await loadOrder(env, String(body.orderNumber || ""));
  if (order instanceof Response) return order;

  // Hard guard: never change a shipping address after the order has shipped.
  if (isFulfilled(order)) {
    return jsonResponse(
      { error: `Order ${order.name} is already fulfilled — the address can't be changed. Handle manually / arrange a redirect.`, fulfilled: true },
      409
    );
  }
  const address = asAddress(body.address);
  if (!address) return jsonResponse({ error: "Address needs at least address1, city and country" }, 400);

  try {
    await updateShippingAddress(env, order.id, address);
    const ss = await ssUpdateAddress(env, order.name, toStarShipit(address));
    await clog(env, `Order ${order.name}: shipping address updated`);
    return jsonResponse({ ok: true, order: order.name, starshipit: ssStatus(env, ss) });
  } catch (error) {
    await cerr(env, "update_address failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── update_email ─────────────────────────────────────────────────────────────
// Body: { orderNumber, email }
export async function handleUpdateEmail(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;
  const order = await loadOrder(env, String(body.orderNumber || ""));
  if (order instanceof Response) return order;
  const email = String(body.email || "").trim();
  if (!email || !email.includes("@")) return jsonResponse({ error: "Valid email required" }, 400);

  try {
    await updateOrderEmail(env, order.id, email);
    const ss = await ssUpdateEmail(env, order.name, email);
    await clog(env, `Order ${order.name}: email updated`);
    return jsonResponse({ ok: true, order: order.name, starshipit: ssStatus(env, ss) });
  } catch (error) {
    await cerr(env, "update_email failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── cancel_refund ────────────────────────────────────────────────────────────
// Body: { orderNumber, mode: "cancel" | "refund", reason, restock?, notify?,
//         items?: [{lineItemId, quantity}], refundShipping?, amount? }
//  - mode "cancel": full refund + cancel the order (+ delete StarShipit order)
//  - mode "refund" with items: refund those exact line items/quantities (amount
//    calculated by Shopify via suggestedRefund; `amount` acts as an override)
//  - mode "refund" without items: legacy fixed-amount refund of `amount`
const CANCEL_REASONS = new Set(["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "STAFF", "OTHER"]);

function asRefundItems(raw: unknown): RefundItemSel[] {
  return Array.isArray(raw)
    ? (raw as { lineItemId?: unknown; quantity?: unknown }[])
        .filter((i) => i && typeof i.lineItemId === "string" && i.lineItemId)
        .map((i) => ({ lineItemId: String(i.lineItemId), quantity: Math.max(1, Number(i.quantity) || 1) }))
    : [];
}
export async function handleCancelRefund(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;
  const order = await loadOrder(env, String(body.orderNumber || ""));
  if (order instanceof Response) return order;
  if (order.cancelledAt) return jsonResponse({ error: `Order ${order.name} is already cancelled` }, 409);

  const mode = body.mode === "refund" ? "refund" : "cancel";
  const reason = CANCEL_REASONS.has(String(body.reason)) ? String(body.reason) : "CUSTOMER";
  const notify = body.notify !== false;

  try {
    if (mode === "cancel") {
      const restock = body.restock !== false;
      await cancelOrderFull(env, order.id, { reason, restock, notify });
      const ss = await ssCancelOrder(env, order.name);
      await clog(env, `Order ${order.name}: cancelled + refunded (restock=${restock})`);
      return jsonResponse({ ok: true, order: order.name, mode, starshipit: ssStatus(env, ss) });
    }
    // partial refund — item-based when a selection is given, else fixed amount
    const amount = String(body.amount || "").trim();
    if (amount && (isNaN(Number(amount)) || Number(amount) <= 0)) {
      return jsonResponse({ error: "Refund amount must be a positive number" }, 400);
    }
    const items = asRefundItems(body.items);
    if (items.length) {
      const done = await refundOrderItems(env, order.id, items, {
        notify,
        note: `Partial refund (${reason})`,
        refundShipping: body.refundShipping === true,
        amountOverride: amount || undefined,
      });
      await clog(env, `Order ${order.name}: refunded ${items.length} item line(s) — ${done.amount} ${done.currency}`);
      return jsonResponse({ ok: true, order: order.name, mode, amount: done.amount, currency: done.currency });
    }
    if (!amount) {
      return jsonResponse({ error: "Select items to refund, or enter a refund amount" }, 400);
    }
    await refundAmount(env, order.id, amount, order.currency, { notify, note: `Partial refund (${reason})` });
    await clog(env, `Order ${order.name}: partial refund ${amount} ${order.currency}`);
    return jsonResponse({ ok: true, order: order.name, mode, amount, currency: order.currency });
  } catch (error) {
    await cerr(env, "cancel_refund failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── refund preview ───────────────────────────────────────────────────────────
// Body: { orderNumber, items: [{lineItemId, quantity}], refundShipping? }
// Returns Shopify's calculated refund for the selection (amount incl. tax) so
// the modal can show the exact figure before the agent commits. No write.
export async function handleRefundPreview(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;
  const order = await loadOrder(env, String(body.orderNumber || ""));
  if (order instanceof Response) return order;
  const items = asRefundItems(body.items);
  if (!items.length) return jsonResponse({ error: "No items selected" }, 400);
  try {
    const s = await suggestRefund(env, order.id, items, body.refundShipping === true);
    return jsonResponse({
      order: order.name,
      amount: s.amount,
      currency: s.currency,
      tax: s.tax,
      shippingAmount: s.shippingAmount,
      maxShipping: s.maxShipping,
      multiTransaction: s.transactions.length > 1,
    });
  } catch (error) {
    await cerr(env, "refund-preview failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── duplicate_order ──────────────────────────────────────────────────────────
// Body: { orderNumber, items?: [{variantId, quantity}], address?: StructuredAddress, email? }
//  - items default to ALL of the original order's line items; the UI passes a
//    subset for partial replacements (AI pre-selects the relevant ones).
//  - address/email default to the original order's; UI may override.
export async function handleDuplicateOrder(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;
  const order = await loadOrder(env, String(body.orderNumber || ""));
  if (order instanceof Response) return order;

  // Resolve items: explicit selection, else clone everything that has a variant.
  // Properties (custom names/initials) ride along either way so the replacement
  // carries the same personalisation as the original.
  type DupItem = { variantId: string; quantity: number; properties?: { key: string; value: string }[] };
  const asProperties = (raw: unknown): { key: string; value: string }[] =>
    Array.isArray(raw)
      ? (raw as { key?: unknown; value?: unknown }[])
          .filter((p) => p && typeof p.key === "string" && typeof p.value === "string")
          .map((p) => ({ key: p.key as string, value: p.value as string }))
      : [];
  let items: DupItem[];
  if (Array.isArray(body.items) && body.items.length) {
    items = (body.items as { variantId?: string; quantity?: number; properties?: unknown }[])
      .filter((i) => i.variantId)
      .map((i) => ({
        variantId: String(i.variantId),
        quantity: Math.max(1, Number(i.quantity) || 1),
        properties: asProperties(i.properties),
      }));
  } else {
    items = order.lineItems
      .filter((li) => li.variantId)
      .map((li) => ({ variantId: li.variantId as string, quantity: li.quantity, properties: li.properties }));
  }
  if (!items.length) {
    return jsonResponse({ error: "No replaceable items (line items have no variant — make the replacement manually)" }, 422);
  }

  const address = asAddress(body.address) || order.shippingAddress;
  if (!address) return jsonResponse({ error: "No shipping address on the original order — provide one" }, 400);
  const email = String(body.email || order.email || "").trim();

  try {
    const newName = await createReplacementOrder(env, {
      email,
      shippingAddress: address,
      items,
      note: `Replacement for ${order.name}`,
    });
    await clog(env, `Order ${order.name}: $0 replacement created → ${newName}`);
    // The new order auto-imports into StarShipit from Shopify; no push needed.
    return jsonResponse({ ok: true, sourceOrder: order.name, replacementOrder: newName });
  } catch (error) {
    await cerr(env, "duplicate_order failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── add_to_order ─────────────────────────────────────────────────────────────
// Body: { orderNumber, items: [{variantId, quantity}], notify? }
//  - Charges via invoice: notify=true emails the customer a payment link for the
//    added amount (Shopify order-edit notification).
export async function handleAddToOrder(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;
  const order = await loadOrder(env, String(body.orderNumber || ""));
  if (order instanceof Response) return order;
  if (isFulfilled(order)) {
    return jsonResponse({ error: `Order ${order.name} is already fulfilled — create a new order instead`, fulfilled: true }, 409);
  }
  const items = Array.isArray(body.items)
    ? (body.items as { variantId?: string; quantity?: number }[])
        .filter((i) => i.variantId)
        .map((i) => ({ variantId: String(i.variantId), quantity: Math.max(1, Number(i.quantity) || 1) }))
    : [];
  if (!items.length) return jsonResponse({ error: "No items to add (each needs a variantId)" }, 400);
  const notify = body.notify !== false; // default: send the invoice

  try {
    await addItemsToOrder(env, order.id, items, { notify });
    await clog(env, `Order ${order.name}: ${items.length} item(s) added (invoice notify=${notify})`);
    return jsonResponse({ ok: true, order: order.name, invoiced: notify });
  } catch (error) {
    await cerr(env, "add_to_order failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── create_discount ──────────────────────────────────────────────────────────
// Body: { code, amount? } — creates a single-use fixed-amount discount code
// (default $10, shop currency). The code is usually FIRSTNAME + last initial +
// the dollar amount (e.g. SARAHJ10); the modal generates it, the agent can edit.
// No StarShipit half — discounts are Shopify-only. Needs write_discounts scope.
export async function handleCreateDiscount(request: Request, env: Env): Promise<Response> {
  const body = await guard(request, env);
  if (body instanceof Response) return body;

  const code = String(body.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,40}$/.test(code)) {
    return jsonResponse({ error: "Code must be 4–40 letters/numbers (no spaces or symbols)" }, 400);
  }
  const amount = String(body.amount ?? "10").trim();
  if (isNaN(Number(amount)) || Number(amount) <= 0 || Number(amount) > 500) {
    return jsonResponse({ error: "Amount must be a positive number (max 500)" }, 400);
  }

  try {
    // Create-first: attempt the code as-is; when Shopify reports it taken,
    // retry with a counter inserted before the trailing dollar amount so the
    // code stays readable: JACKM10 taken → JACKM210, JACKM310… (appended when
    // the code doesn't end in the amount, e.g. a fully custom code). No
    // lookup-first pre-check — that needs read_discounts; this needs only write.
    const amt = String(Math.round(Number(amount)));
    const base = code.endsWith(amt) ? code.slice(0, code.length - amt.length) : null;
    for (let n = 1; n <= 20; n++) {
      const candidate = n === 1 ? code : base !== null ? `${base}${n}${amt}` : `${code}${n}`;
      if ((await createSingleUseDiscount(env, { code: candidate, amount })) === "taken") continue;
      await clog(env, `Discount ${candidate} created: $${amount} off, single-use, non-stacking`);
      return jsonResponse({ ok: true, code: candidate, amount, adjusted: candidate !== code });
    }
    return jsonResponse({ error: `Code ${code} and 19 numbered variants are all taken — pick a different code` }, 409);
  } catch (error) {
    await cerr(env, "create_discount failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// GET /api/shopify/actions/scopes — the scopes the live token actually has,
// for diagnosing scope propagation after a Dev Dashboard release.
export async function handleGetScopes(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!shopifyConfigured(env)) return jsonResponse({ error: "Shopify not configured", configured: false }, 503);
  try {
    return jsonResponse({ scopes: await currentScopes(env) });
  } catch (error) {
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// ── read helpers for the modals ──────────────────────────────────────────────
// GET /api/shopify/actions/order-items?name=#1001 -> order context for the
// duplicate/add modals (line items w/ variant ids, address, fulfilment state).
export async function handleGetOrderItems(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!shopifyConfigured(env)) return jsonResponse({ error: "Shopify writes not configured", configured: false }, 503);
  const name = new URL(request.url).searchParams.get("name")?.trim();
  if (!name) return jsonResponse({ error: "Missing order name" }, 400);
  try {
    const ctx = await getOrderForWrite(env, name);
    if (!ctx) return jsonResponse({ error: `Order #${String(name).replace(/^#/, "")} not found. ${NOT_FOUND_HINT}` }, 404);
    return jsonResponse({
      order: ctx.name,
      email: ctx.email,
      fulfilled: isFulfilled(ctx),
      cancelled: !!ctx.cancelledAt,
      shippingAddress: ctx.shippingAddress,
      lineItems: ctx.lineItems.map((li) => ({
        lineItemId: li.id,
        variantId: li.variantId,
        title: li.title,
        quantity: li.quantity,
        currentQuantity: li.currentQuantity,
        unitPrice: li.unitPrice,
        properties: li.properties,
      })),
    });
  } catch (error) {
    await cerr(env, "order-items lookup failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

// GET /api/shopify/actions/search-variants?q=italy -> [{variantId,label,price}]
export async function handleSearchVariants(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!shopifyConfigured(env)) return jsonResponse({ error: "Shopify writes not configured", configured: false }, 503);
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q) return jsonResponse({ variants: [] });
  try {
    return jsonResponse({ variants: await searchProductVariants(env, q) });
  } catch (error) {
    await cerr(env, "search-variants failed:", error);
    return jsonResponse({ error: errMsg(error) }, 502);
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Action failed";
}

/** Summarise the StarShipit half for the agent UI. */
function ssStatus(env: Env, ss: { ok: boolean; skipped?: boolean; error?: string }): string {
  if (!starshipitConfigured(env)) return "not configured";
  if (ss.skipped) return ss.error ? `skipped (${ss.error})` : "skipped";
  return ss.ok ? "updated" : `failed (${ss.error || "unknown"})`;
}
