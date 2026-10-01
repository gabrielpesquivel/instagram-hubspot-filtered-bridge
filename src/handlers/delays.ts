// Proactive delay outreach for the Support Assistant: list shipments the order
// globe's in-transit snapshot flags as "delayed" (no delivery past the usual
// window) or "issue" (failed / attempted delivery), let the agent AI-draft an
// email to the customer before they write in, and send it as a new thread.
//
// Source data is the snapshot syncOrderGlobe() refreshes on the 10-min cron
// (KV orders_geo_transit) — no extra Shopify scanning here. Per-order outreach
// state (contacted / dismissed) lives in one KV map so a shipment only shows
// up once.
import type { Env, ConversationMessage } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { cerr } from "../services/logger";
import { findOrderByName, type ShopifyOrderSummary } from "../services/shopify-api";
import { generateReply } from "../services/gemini-api";
import { getGoogleConnection, getValidGoogleToken } from "../services/google-oauth";
import { sendNewEmail } from "../services/gmail-api";
import { TRANSIT_KEY, type TransitSnapshot } from "./order-globe";
import { withSignature } from "./email";

const STATE_KEY = "support_delay_outreach";
const STATE_KEEP_DAYS = 60; // older entries are pruned (shipment has left the 40-day snapshot)
const DAY = 86400_000;

interface OutreachEntry {
  state: "contacted" | "dismissed";
  at: string;
  threadId?: string;
}
type OutreachState = Record<string, OutreachEntry>;

async function loadState(env: Env): Promise<OutreachState> {
  const raw = await env.PROFILE_CACHE.get(STATE_KEY);
  return raw ? (JSON.parse(raw) as OutreachState) : {};
}

async function saveEntry(env: Env, order: string, entry: OutreachEntry): Promise<void> {
  const state = await loadState(env);
  const cutoff = Date.now() - STATE_KEEP_DAYS * DAY;
  for (const [k, v] of Object.entries(state)) if (Date.parse(v.at) < cutoff) delete state[k];
  state[order] = entry;
  await env.PROFILE_CACHE.put(STATE_KEY, JSON.stringify(state));
}

const orderName = (s: unknown) => {
  const n = String(s ?? "").trim().replace(/^#/, "");
  return /^\d{3,7}$/.test(n) ? `#${n}` : "";
};

// GET /api/support/delays → flagged shipments not yet dismissed, newest
// problems first; contacted ones stay listed (greyed in the UI) for a record.
export async function handleListDelays(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const [raw, state] = await Promise.all([env.PROFILE_CACHE.get(TRANSIT_KEY), loadState(env)]);
  if (!raw) return jsonResponse({ refreshedAt: null, items: [] });
  const snap = JSON.parse(raw) as TransitSnapshot;
  const items = snap.shipments
    .filter((s) => (s.status === "delayed" || s.status === "issue") && state[s.o]?.state !== "dismissed")
    .map((s) => ({
      order: s.o,
      status: s.status,
      country: s.cc,
      city: s.city,
      carrier: s.carrier,
      shippedAt: s.shippedAt,
      eta: s.eta,
      approx: s.approx,
      days: Math.floor((Date.now() - Date.parse(s.shippedAt)) / DAY),
      contacted: state[s.o]?.state === "contacted" ? state[s.o].at : null,
    }))
    // Not-yet-contacted first, then issues before delays, then oldest shipment.
    .sort((a, b) =>
      Number(!!a.contacted) - Number(!!b.contacted) ||
      Number(b.status === "issue") - Number(a.status === "issue") ||
      b.days - a.days
    );
  return jsonResponse({ refreshedAt: snap.refreshedAt, items });
}

function situation(order: ShopifyOrderSummary): string {
  const ship = order.shipments?.[order.shipments.length - 1];
  const status = ship?.status || "UNKNOWN";
  if (["FAILURE", "ATTEMPTED_DELIVERY", "NOT_DELIVERED"].includes(status)) {
    return `The carrier could NOT deliver the parcel (status ${status}). Explain that in plain words using the latest scan, and tell them what to do: check for a carrier card / collect it from the local post office if the scan says it's waiting there, or reply to confirm their address so we can help. Don't offer a replacement yet.`;
  }
  return `The parcel is taking longer than usual (no delivery yet, status ${status}). Briefly apologise, give the latest scan in plain words with its day (or, if there are no scans, say it's on its way and international parcels can be held up in customs), and reassure them we're keeping an eye on it. Tell them that if it hasn't arrived within about a week, they can reply and we'll send a replacement free of charge.`;
}

// POST /api/support/delays/draft { order } → { to, name, subject, body }
export async function handleDraftDelay(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as { order?: string };
  const name = orderName(body.order);
  if (!name) return jsonResponse({ error: "Missing order number" }, 400);

  try {
    const order = await findOrderByName(env, name);
    if (!order) return jsonResponse({ error: `Order ${name} not found` }, 404);
    if (!order.email) return jsonResponse({ error: `Order ${name} has no customer email` }, 422);
    const firstName = order.customerName.split(/\s+/)[0] || "";

    // generateReply needs a user turn; the brief rides in the system prompt.
    const messages: ConversationMessage[] = [{
      id: crypto.randomUUID(),
      sender: "user",
      text: "(Internal request — the customer has NOT contacted us. Write the proactive email described in the instructions.)",
      timestamp: new Date().toISOString(),
    }];
    const brief = `PROACTIVE DELAY EMAIL — We are emailing this customer first, before they contact us, about their order ${name}. Write in English. Don't say "thanks for reaching out" or imply they asked. Don't restate the order contents or address. Mention the order number once. End with the tracking link on its own line if there is one.
${situation(order)}
Live order data: ${JSON.stringify({
      fulfillmentStatus: order.fulfillmentStatus,
      shippingCountry: order.shippingCountry,
      shippingCity: order.shippingCity,
      tracking: order.tracking,
      shipments: order.shipments,
    })}`;
    const draft = await generateReply(messages, env, brief, {
      channel: "email",
      customerName: firstName || undefined,
    });
    return jsonResponse({
      to: order.email,
      name: order.customerName,
      subject: `An update on your BootInk order ${name}`,
      body: draft.replace(/⟦|⟧/g, ""),
    });
  } catch (error) {
    await cerr(env, "Delay draft error:", error);
    return jsonResponse({ error: "Failed to draft email" }, 500);
  }
}

// POST /api/support/delays/send { order, to, subject, body } → new Gmail thread
export async function handleSendDelay(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const conn = await getGoogleConnection(env);
  const token = await getValidGoogleToken(env);
  if (!conn || !token) return jsonResponse({ error: "Gmail not connected" }, 409);

  const b = (await request.json().catch(() => ({}))) as { order?: string; to?: string; subject?: string; body?: string };
  const name = orderName(b.order);
  const to = (b.to || "").trim();
  const text = (b.body || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !text || !b.subject?.trim()) {
    return jsonResponse({ error: "Order, recipient, subject and body are required" }, 400);
  }

  try {
    const { body, html } = await withSignature(env, token, conn.email, text);
    const threadId = await sendNewEmail(token, { to, fromEmail: conn.email, subject: b.subject.trim(), body, html });
    if (!threadId) return jsonResponse({ error: "Gmail rejected the message" }, 502);
    await saveEntry(env, name, { state: "contacted", at: new Date().toISOString(), threadId });
    return jsonResponse({ ok: true, threadId });
  } catch (error) {
    await cerr(env, "Delay send error:", error);
    return jsonResponse({ error: "Failed to send email" }, 500);
  }
}

// POST /api/support/delays/dismiss { order } → hide it from the list
export async function handleDismissDelay(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const b = (await request.json().catch(() => ({}))) as { order?: string };
  const name = orderName(b.order);
  if (!name) return jsonResponse({ error: "Missing order number" }, 400);
  await saveEntry(env, name, { state: "dismissed", at: new Date().toISOString() });
  return jsonResponse({ ok: true });
}
