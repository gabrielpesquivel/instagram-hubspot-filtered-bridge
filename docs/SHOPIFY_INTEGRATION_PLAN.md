# Shopify Integration — Implementation Plan

Goal: connect the Customer Support inbox to Shopify so agents (and eventually the
AI) can answer order/tracking questions with real data instead of deflecting to
`info@bootink.com`.

Three features, built in order (each is usable on its own):

1. **Order & tracking lookup** — agent enters an order # or email in the thread, sees live status + tracking.
2. **Auto customer context** — an incoming email is matched to its Shopify customer; their recent orders show automatically in the thread.
3. **AI answers order questions** — the AI pulls order status itself (Gemini function-calling) and writes the reply.

Build 1 first (safe, agent-driven). 2 reuses 1's service. 3 builds on both.

---

## 0. Prerequisites (do once, in Shopify admin)

Create a **custom app**: Shopify admin → Settings → Apps and sales channels →
Develop apps → Create an app.

- **Admin API access scopes:** `read_orders`, `read_customers`, `read_fulfillments`.
  (Read-only. We never write to Shopify.)
- Install the app → reveal the **Admin API access token** (`shpat_...`).
- Note the store domain, e.g. `bootink.myshopify.com`.

Add as Worker secrets / vars (do NOT commit the token):

```bash
npx wrangler secret put SHOPIFY_ADMIN_TOKEN     # shpat_...
```
```toml
# wrangler.toml [vars]
SHOPIFY_STORE_DOMAIN = "bootink.myshopify.com"
SHOPIFY_API_VERSION  = "2025-01"
```

Add the types to `src/types.ts` `Env`:
```ts
SHOPIFY_ADMIN_TOKEN: string;
SHOPIFY_STORE_DOMAIN: string;
SHOPIFY_API_VERSION: string;
```

---

## 1. Backend service — `src/services/shopify-api.ts`

Thin Admin GraphQL client (mirrors the style of `gmail-api.ts` / `instagram-api.ts`).

```
Endpoint: https://{SHOPIFY_STORE_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json
Header:   X-Shopify-Access-Token: {SHOPIFY_ADMIN_TOKEN}
Method:   POST  { query, variables }
```

Shape returned to the app (normalize GraphQL → a flat summary):

```ts
export interface ShopifyOrderSummary {
  name: string;            // "#1001"
  createdAt: string;
  financialStatus: string; // PAID, REFUNDED, ...
  fulfillmentStatus: string; // FULFILLED, UNFULFILLED, PARTIALLY_FULFILLED
  customerName: string;
  email: string;
  totalPrice: string;      // "$24.50 AUD"
  lineItems: { title: string; quantity: number }[];
  tracking: { company?: string; number?: string; url?: string }[];
  shippingCountry?: string;
}
```

Functions:

```ts
// Lookup by order name/number ("#1001" or "1001"). Returns 0-1.
findOrderByName(env, name): Promise<ShopifyOrderSummary | null>

// Lookup recent orders for an email. Returns newest-first, capped (e.g. 5).
findOrdersByEmail(env, email, limit=5): Promise<ShopifyOrderSummary[]>
```

GraphQL query sketch (orders by query string — Shopify supports `name:` and `email:`):

```graphql
query($q: String!, $n: Int!) {
  orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      name createdAt displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { presentmentMoney { amount currencyCode } }
      customer { firstName lastName email }
      shippingAddress { country }
      lineItems(first: 20) { edges { node { title quantity } } }
      fulfillments { trackingInfo { company number url } }
    } }
  }
}
```
- By name:  `variables.q = "name:#1001"`
- By email: `variables.q = "email:jane@x.com"`

Notes:
- GraphQL is cost-based (1000-point bucket, ~50/s leak). One order query is cheap. Cache by key (`shopify_order:<name>` / `shopify_orders:<email>`) in `PROFILE_CACHE` with a short TTL (e.g. 60–120s) to avoid hammering on repeated opens.
- Fail-soft: return `null`/`[]` and `cerr()` on any non-200, like the IG/email services.

---

## 2. Feature 1 — Order & tracking lookup (agent-driven)

### Backend — `src/handlers/shopify.ts`
- `GET /api/shopify/order?name=%231001` → `findOrderByName` → `{ order }` or 404.
- `GET /api/shopify/orders?email=jane@x.com` → `findOrdersByEmail` → `{ orders }`.
- Both `isAuthenticated`-gated.

Routes in `src/index.ts` (near the other `/api/*` blocks).

### Frontend — `dashboard/src/Inbox.tsx` (thread pane)
- Add a collapsible **"Orders"** panel in the thread header/sidebar.
- A small input: "Order # or email" + Look up button → calls the endpoint, renders:
  - order name, status badges (financial + fulfillment), total, line items, and a **tracking link** if present.
- For the **email channel**, prefill the input with the customer's email (we already have `replyTo`/`fromName`); one click shows their orders.
- Keep it read-only; no edits to Shopify.

### Acceptance
- Type `#1001` → see status + tracking. Type a customer email → see their recent orders.

---

## 3. Feature 2 — Auto customer context (email channel)

Reuses `findOrdersByEmail`.

- Backend: `GET /api/email/threads/:id` already returns `replyTo`. Either (a) extend it to also include `shopifyOrders` by extracting the customer email and calling `findOrdersByEmail`, or (b) have the frontend call `/api/shopify/orders?email=...` after loading the thread.
  - Prefer (b) — keeps concerns separate and lets the panel lazy-load.
- Frontend: when an **email** thread opens, auto-fetch the sender's orders and show the Orders panel pre-populated (no manual lookup needed).
- Instagram caveat: DMs have no email. Leave the manual lookup box for IG (agent asks the customer for an order # or email). Optionally cache an IG-handle → email mapping once discovered.

### Acceptance
- Open an email from a known customer → their orders appear automatically.

---

## 4. Feature 3 — AI answers order questions (Gemini function-calling)

This is the biggest change — the AI needs a *tool* it can call mid-generation.

### Mechanism
Gemini supports function calling via `tools: [{ functionDeclarations: [...] }]`.
Declare one tool:

```jsonc
{
  "name": "lookup_order",
  "description": "Look up a customer's order status and tracking. Use when the customer asks about an existing order, shipping status, or tracking.",
  "parameters": {
    "type": "object",
    "properties": {
      "order_number": { "type": "string", "description": "Order number e.g. #1001, if the customer gave one" },
      "email": { "type": "string", "description": "Customer email, if known/given" }
    }
  }
}
```

### Generation loop (extend `generateReply` in `services/gemini-api.ts`)
1. Call `generateContent` with `tools`.
2. If the response contains a `functionCall` for `lookup_order`:
   - Execute it against `shopify-api.ts` (`findOrderByName` / `findOrdersByEmail`).
   - Send a second `generateContent` with the original contents + the model's function call + a `functionResponse` part containing the order data.
   - Return the model's final text.
3. If no function call, return the text as today.

(Factor the single-shot fetch into a helper so the loop can call it twice.)

### Identity / safety
- **Verify ownership before revealing order details in an auto-reply.** On email, the requester's address must match the order's email. On IG (no email), the AI should *ask* for the order number or email rather than guess — never expose another customer's data.
- Add a guardrail line to `SYSTEM_PROMPT`: only share order details when the order's email matches the requester (email channel) or the customer themselves supplied the order number.
- Keep the existing "order issues → info@bootink.com" as the fallback when lookup fails or identity can't be confirmed.

### Rollout
- Gate behind an Agent Setting toggle (`order_lookup_enabled`) so it can be turned on after testing.
- Start with the tool returning data to the **agent-facing Auto Draft only**, then enable for auto-reply once trusted.

### Acceptance
- Customer: "where's my order #1001?" → Auto Draft replies with real status + tracking, in the customer's language, matching the house tone.

---

## 5. Files touched (summary)

| File | Change |
|---|---|
| `wrangler.toml` | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_API_VERSION` vars; secret note |
| `src/types.ts` | Shopify env fields |
| `src/services/shopify-api.ts` | **new** — Admin GraphQL client + lookups |
| `src/handlers/shopify.ts` | **new** — `/api/shopify/order`, `/api/shopify/orders` |
| `src/index.ts` | route the new endpoints |
| `dashboard/src/Inbox.tsx` | Orders panel (lookup + auto-context) |
| `src/services/gemini-api.ts` | (Feature 3) function-calling loop + `lookup_order` tool + guardrail |
| `src/handlers/conversations.ts` / `email.ts` | (Feature 3) pass order tool through suggest/generate |
| `dashboard/src/AgentSettings.tsx` | (Feature 3) `order_lookup_enabled` toggle |

## 6. Build order / estimate
1. Secrets + `shopify-api.ts` + `/api/shopify/*` + manual lookup panel → **Feature 1** (half day).
2. Auto-fetch on email open → **Feature 2** (1–2 hrs, reuses 1).
3. Function-calling loop + identity guardrails + settings toggle → **Feature 3** (most of a day; test carefully).

## 7. Risks / notes
- Rate limits: cache lookups briefly; don't auto-fetch on every poll, only on thread open.
- Token security: Admin token is powerful even read-only — Worker secret only, never to the browser. All Shopify calls go through the Worker.
- Order matching: Shopify order *names* include the `#` and any store prefix/suffix — normalize input (`#1001`, `1001`, `BK1001`).
- Currency: use `presentmentMoney` so totals match what the customer paid.
- Privacy: never surface order data in an auto-reply without confirming the requester owns the order.
