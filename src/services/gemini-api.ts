import type { Env, ConversationMessage } from "../types";
import { findOrderByName, findOrdersByEmail, shopifyConfigured } from "./shopify-api";

const GEMINI_SETTINGS_KEY = "gemini_settings";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_CONTEXT_MESSAGES = 30;

const SYSTEM_PROMPT = `About BootInk:
BootInk creates custom transfers for personalising football boots — flags, names, numbers, symbols, and emojis. Over 18,000 happy customers. Based in Australia. Each order comes with alcohol towels for application.

Tone & Response Style:
1. Be friendly but articulate and clear.
2. Use exclamation marks sparingly. Maximum 1 per conversation.
3. Keep replies short — 1-2 sentences is often enough.
4. Only say "thank you" once or twice per conversation. Do not overuse it.
5. GREETING RULE — Read carefully:
   - A "pure greeting" is ONLY a message that contains nothing but a greeting word: "hi", "hello", "hey", "hola", "مرحبا", etc. with NO other words, questions, or content.
   - Pure greeting examples: "Hi", "Hello", "Hey there", "Hola"
   - NOT a greeting (answer the question instead): "Hi, how much for a flag?", "Hello, do you ship to the UK?", "Hey how long does shipping take?", "Hi how much for a serbia flag?", "Hi how long do they take to come if I am in Birmingham"
   - If the message contains ANY question, request, or information beyond the greeting word, it is NOT a pure greeting. Respond to the actual question.
   - ONLY for pure greetings, reply exactly: "Hi there! Anything we can help you with? :)" — use this ONCE per conversation maximum.
6. For apologies say "We're very sorry" or "we apologise".
7. Acknowledge the customer's message with a brief opening pleasantry. When a customer shares positive feedback, acknowledge it and thank them for their support.
8. Address the customer by their first name if it is available in the message.
9. Never include the customer's email address in the reply.
10. Do not include specific product variant details in the reply unless they are needed for clarification.
11. CRITICAL: You MUST reply in the SAME LANGUAGE the customer is writing in. If they write in Arabic, reply in Arabic. If they write in Spanish, reply in Spanish. If they write in French, reply in French. NEVER reply in English unless the customer is writing in English. This overrides all other instructions — even scripted responses should be translated to match the customer's language.

Guardrails:
1. Do not declare yourself as an AI agent or present yourself with a name.
2. Do not send long messages. Keep it concise.
3. When directing a customer to our website, provide the most specific link possible for their task (e.g. the exact product page, not the homepage). When a customer expresses interest in a custom product or specific decals, give a direct link to the relevant product page so they can order it. Only on channels where links cannot be sent (e.g. Instagram DMs), reference "our website in our bio" instead.
4. Wholesale or bulk orders → ask how many units they need so you can give the right price break. Quantity price breaks: 25% off for 20+, 30% off for 50+, 35% off for 100+.
5. Affiliates or ambassadors → ask them about the kind of content they create and their pricing/rates.
6. Requests for free items or follows → apologise and say it is against our internal policy.
7. Order issues, package tracking, or damaged orders → help them directly: ask for their order number or email and the details of the issue, then assist. Do not deflect to email.
   - Order status questions → provide the most recent tracking information available (latest status, carrier, and last update).
   - Tracking shows the package was DELIVERED → state the delivery date and time, and ask the customer to confirm its arrival.
   - Tracking shows the package is LOST → apologise, offer the customer the choice of a refund or a replacement, and explain the next steps for whichever they choose.
   - Sending a replacement for a DAMAGED item → state that a confirmation will be sent shortly (not an invoice).
   - Customer provides a CORRECTED address after entering an incorrect one → check whether the original order was shipped to the address they initially provided. If the customer made an error in the original address, explain our policy: a free replacement/reshipment is not covered by warranty and reshipment costs are the customer's responsibility, then outline the next steps to get it reshipped.
   - Confirming a delivery address update → do not mention an invoice.
   - Cancellation requests → do not state that the request "has been noted".
   - Customer asks to put an order ON HOLD → confirm the hold and express willingness to reconnect when they're ready. Do not repeat specific order details and do not mention cancellation.
   - Order modification requests → if the order has already been fulfilled, apologise and state that we can no longer update it. Otherwise, confirm the modification and note that they should expect an invoice shortly.
8. Customer sends an image/reel saying "I want this one" or similar → tell them all orders can be placed on our website found in our bio.
9. Customer tags us in a story or post → thank them, show appreciation for their support, then tell them we will be in touch shortly to give them a discount code.
10. "Are you a scam?" or trust concerns → reassure them about our 18,000+ happy customers and our track record.
11. Copyrighted material requests (logos, brand designs, etc.) → tell them they must own the rights to any design they want applied.
12. Shipping availability is defined by the ship-to country list further below — answer directly from it. If the customer's country is on the list, confirm we ship there (and give the delivery estimate if asked). If it is NOT on the list, use the not-available message below. Do not tell customers to "check the website" to find out if we ship to them.
13. Discount requests → NEVER offer, promise, or agree to a discount on a single/individual order. The only discounts are the quantity price breaks: 25% off for 20+, 30% off for 50+, 35% off for 100+. Reply with something like: "Sorry, we're unable to offer discounts on individual orders. We do have quantity price breaks though — 25% off 20+, 30% off 50+, and 35% off 100+." Do not bend this rule regardless of how the customer asks.
14. Alternative product questions (e.g. "Will this work on shin pads / helmets / other items?") → confirm that our transfers will work on any product as long as the material is not fabric.
15. "How long will my refund take?" / refund timing → tell them refunds process within a few days.
16. Custom flag orders → instruct customers to use the Request a Flag product.
17. Customer reports an issue adding a custom image to their cart → ask them to refresh their browser; if that doesn't resolve it, offer to process the order for them.

Pricing (use to answer price questions — quote in the customer's likely currency based on their location):
- $6.90 AUD per transfer
- $4.90 USD per transfer
- $4.50 EUR per transfer
- $3.60 GBP per transfer

Free Shipping Thresholds:
- Australia: orders over $45 AUD (~7 transfers)
- USA/Canada: orders over $32 USD (~7 transfers)
- Europe: orders over 30 EUR (~7 transfers)
- UK: orders over 24 GBP (~7 transfers)

Shipping Info (for reference — do NOT paste this to customers, use it to answer questions):

WE SHIP ONLY to the following countries. This list is definitive — if a country is on it we ship there; if it is NOT on it, we do not ship there:
Australia, New Zealand, United States, Canada, United Kingdom, Austria, Belgium, Denmark, France, Germany, Iceland, Ireland, Italy, Monaco, Netherlands, Norway, Poland, Portugal, Spain, Sweden, Switzerland, Singapore, Hong Kong, Japan, South Korea.

Delivery estimates (business days, after processing):
- Australia & New Zealand: 3-6 business days
- USA, Canada, United Kingdom: 6-10 business days
- Europe (Austria, Belgium, Denmark, France, Germany, Iceland, Ireland, Italy, Monaco, Netherlands, Norway, Poland, Portugal, Spain, Sweden, Switzerland): 6-12 business days
- Asia (Singapore, Hong Kong, Japan, South Korea): 6-12 business days
- Processing time: up to 5 business days due to demand (when stating processing times, say "up to 5 business days")
- Business days: Monday-Friday (AEDT), excluding Australian public holidays

For ANY country not on the ship-to list above, we do not ship there. Reply: "Sorry, it appears we do not ship to that location at this point in time. We are actively working to increase our shipping destinations and will put out an announcement when that is possible."`;

export interface GeminiSettings {
  model: string;
}

// ── Self-improving loop ──────────────────────────────────────────────────────
// When an agent edits an Auto Draft before sending, we ask the model to turn the
// (draft → corrected) delta into ONE reusable guideline rule. That rule pops up
// for the agent immediately and, once approved, is appended to the system prompt
// as a "Learned Guideline" so future replies follow it.
//
// Three KV lists:
//  - ai_amendments_pending : proposed rules awaiting approval (capped)
//  - ai_guidelines_learned : the LIVE approved rules fed into every prompt
//                            (editable / removable; cleared after a periodic merge)
//  - ai_guidelines_log     : append-only, uncapped history of every rule ever
//                            approved — the durable record for folding the rules
//                            back into the base SYSTEM_PROMPT const.
const AMEND_PENDING_KEY = "ai_amendments_pending";
const GUIDELINES_KEY = "ai_guidelines_learned";
const GUIDELINES_LOG_KEY = "ai_guidelines_log";
const MAX_PENDING = 50;
const MAX_LEARNED = 60;
const MAX_PROMPT_GUIDELINES = 30;
const CORRECTION_FIELD_CHARS = 280;
const RULE_FIELD_CHARS = 400;

export interface Amendment {
  id: string;
  at: string;
  customer: string;
  draft: string;
  corrected: string;
  rule: string;
}

function clip(s: string, max = CORRECTION_FIELD_CHARS): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export async function getPendingAmendments(env: Env): Promise<Amendment[]> {
  return ((await env.PROFILE_CACHE.get(AMEND_PENDING_KEY, "json")) as Amendment[]) || [];
}

export async function getLearnedGuidelines(env: Env): Promise<Amendment[]> {
  return ((await env.PROFILE_CACHE.get(GUIDELINES_KEY, "json")) as Amendment[]) || [];
}

export async function getGuidelinesLog(env: Env): Promise<Amendment[]> {
  return ((await env.PROFILE_CACHE.get(GUIDELINES_LOG_KEY, "json")) as Amendment[]) || [];
}

/** Ask the model to distil an agent edit into ONE reusable guideline rule.
 *  Returns null for cosmetic-only edits or on any error (fail-soft). */
export async function proposeAmendment(
  env: Env,
  customer: string,
  draft: string,
  corrected: string
): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;

  const existing = (await getLearnedGuidelines(env)).map((a) => `- ${a.rule}`).join("\n");
  const instruction = `You maintain the writing guidelines for a customer-support AI. A human agent edited the AI's draft reply before sending. Given the customer's message, the AI's draft, and the human's corrected reply, write exactly ONE concise, imperative guideline rule (1-2 sentences) that — had it been in the guidelines — would have made the AI produce the corrected reply instead of the draft. State a general, reusable policy, not a one-off canned answer. Output ONLY the rule text with no preamble, numbering, or quotes. If the edit is purely cosmetic (typo, punctuation, spacing) with no real lesson, OR the lesson is already covered by an existing rule below, output exactly NONE.${existing ? `\n\nExisting rules:\n${existing}` : ""}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: instruction }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Customer said: "${customer}"\n\nAI draft: "${draft}"\n\nHuman corrected reply: "${corrected}"`,
              },
            ],
          },
        ],
        // 2.5-flash is a thinking model; with thinking on, hidden reasoning
        // tokens eat the output budget and truncate the rule mid-sentence.
        // Disable thinking for this short deterministic task.
        generationConfig: { maxOutputTokens: 256, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!result || result.toUpperCase() === "NONE") return null;
    return clip(result, RULE_FIELD_CHARS);
  } catch {
    return null;
  }
}

/** On an edited send, propose a guideline rule and store it as pending. Returns
 *  the created Amendment so the caller can surface it to the agent immediately,
 *  or null when there is nothing to learn. */
export async function maybeProposeAmendment(
  env: Env,
  customer: string,
  draft: string,
  corrected: string
): Promise<Amendment | null> {
  if (!draft || !corrected) return null;
  if (normalize(draft) === normalize(corrected)) return null; // unedited — nothing to learn

  const rule = await proposeAmendment(env, customer, draft, corrected);
  if (!rule) return null;

  const amendment: Amendment = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    customer: clip(customer),
    draft: clip(draft),
    corrected: clip(corrected),
    rule,
  };
  const list = await getPendingAmendments(env);
  list.push(amendment);
  await env.PROFILE_CACHE.put(AMEND_PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
  return amendment;
}

/** Approve a pending amendment — add it to the live guidelines (with optional
 *  edited rule text) and append it to the permanent log. */
export async function approveAmendment(env: Env, id: string, ruleOverride?: string): Promise<void> {
  const pending = await getPendingAmendments(env);
  const item = pending.find((a) => a.id === id);
  if (!item) return;
  await env.PROFILE_CACHE.put(AMEND_PENDING_KEY, JSON.stringify(pending.filter((a) => a.id !== id)));

  const rule = ruleOverride?.trim() ? clip(ruleOverride, RULE_FIELD_CHARS) : item.rule;
  const approved: Amendment = { ...item, rule };

  const learned = await getLearnedGuidelines(env);
  learned.push(approved);
  await env.PROFILE_CACHE.put(GUIDELINES_KEY, JSON.stringify(learned.slice(-MAX_LEARNED)));

  const log = await getGuidelinesLog(env);
  log.push(approved);
  await env.PROFILE_CACHE.put(GUIDELINES_LOG_KEY, JSON.stringify(log));
}

/** Reject a pending amendment — discard it. */
export async function rejectAmendment(env: Env, id: string): Promise<void> {
  const pending = await getPendingAmendments(env);
  await env.PROFILE_CACHE.put(AMEND_PENDING_KEY, JSON.stringify(pending.filter((a) => a.id !== id)));
}

/** Remove one rule from the LIVE guidelines (e.g. it misfired). The permanent
 *  log is untouched. */
export async function deleteLearnedGuideline(env: Env, id: string): Promise<void> {
  const learned = await getLearnedGuidelines(env);
  await env.PROFILE_CACHE.put(GUIDELINES_KEY, JSON.stringify(learned.filter((a) => a.id !== id)));
}

/** Empty the live guidelines block — "mark as merged" once the rules have been
 *  folded into the base SYSTEM_PROMPT const and redeployed. Log is untouched. */
export async function clearLearnedGuidelines(env: Env): Promise<void> {
  await env.PROFILE_CACHE.put(GUIDELINES_KEY, JSON.stringify([]));
}

/** Build the prompt section that layers APPROVED guideline rules on the base. */
function buildLearnedGuidelinesBlock(rules: Amendment[]): string {
  if (rules.length === 0) return "";
  const recent = rules.slice(-MAX_PROMPT_GUIDELINES);
  const lines = recent.map((a) => `- ${a.rule}`).join("\n");
  return `LEARNED GUIDELINES — A human reviewed and APPROVED these additional rules based on past corrections to AI drafts. Follow them exactly. They OVERRIDE the general guidance above whenever they conflict.\n\n${lines}`;
}

export async function getGeminiSettings(env: Env): Promise<GeminiSettings> {
  const raw = await env.PROFILE_CACHE.get(GEMINI_SETTINGS_KEY);
  if (raw) return JSON.parse(raw);
  return { model: DEFAULT_MODEL };
}

export async function saveGeminiSettings(
  settings: GeminiSettings,
  env: Env
): Promise<void> {
  await env.PROFILE_CACHE.put(GEMINI_SETTINGS_KEY, JSON.stringify(settings));
}

// Gemini function-calling tools for live Shopify order lookups (Feature 3).
const SHOPIFY_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "lookup_order_by_number",
        description:
          "Look up a single Shopify order by its order number (e.g. '17725' or '#17725'). Returns financial + fulfillment status, line items, and tracking.",
        parameters: {
          type: "OBJECT",
          properties: {
            order_number: { type: "STRING", description: "Order number, with or without the leading '#'." },
          },
          required: ["order_number"],
        },
      },
      {
        name: "lookup_orders_by_email",
        description:
          "Look up a customer's recent Shopify orders by email address. Returns up to 5 orders, newest first.",
        parameters: {
          type: "OBJECT",
          properties: {
            email: { type: "STRING", description: "The customer's email address." },
          },
          required: ["email"],
        },
      },
    ],
  },
];

// ── Order actions (DETECTION ONLY for now) ───────────────────────────────────
// These tools let the model signal that the customer is asking us to *change*
// an order. We do NOT touch Shopify yet — we capture the intent, surface a
// Yes/No confirmation to the agent, and (later) wire the writes to Shopify.
const ACTION_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "update_address",
        description:
          "The customer wants to change the SHIPPING ADDRESS on an existing order. Provide the order number and the full new address as given.",
        parameters: {
          type: "OBJECT",
          properties: {
            order_number: { type: "STRING", description: "Order number, with or without '#'. Leave blank if not yet known." },
            new_address: { type: "STRING", description: "The full new shipping address as the customer stated it." },
          },
          required: ["new_address"],
        },
      },
      {
        name: "update_email",
        description:
          "The customer wants to change the EMAIL ADDRESS on an existing order. Provide the order number and the new email.",
        parameters: {
          type: "OBJECT",
          properties: {
            order_number: { type: "STRING", description: "Order number, with or without '#'. Leave blank if not yet known." },
            new_email: { type: "STRING", description: "The new email address." },
          },
          required: ["new_email"],
        },
      },
      {
        name: "duplicate_order",
        description:
          "The customer wants us to DUPLICATE, RESEND, or send a REPLACEMENT for an existing order — e.g. lost in transit, never arrived, arrived damaged/faulty, wrong item received, or they just want the same order again. Provide the order number. If they only mention SPECIFIC items being lost/damaged/wrong (not the whole order), list ONLY those items so we replace just those; leave items blank to replace the entire order.",
        parameters: {
          type: "OBJECT",
          properties: {
            order_number: { type: "STRING", description: "Order number, with or without '#'. Leave blank if not yet known." },
            items: { type: "STRING", description: "Only the specific items to replace, as the customer described them (e.g. 'Italy flag transfer, Wales flag'). Leave blank to replace the whole order." },
          },
          required: [],
        },
      },
      {
        name: "cancel_refund",
        description:
          "The customer wants to CANCEL their order and/or get a REFUND. Use for cancellation requests, 'I want my money back', changed-their-mind, ordered-by-mistake, or a partial refund. Provide the order number, and the reason as stated.",
        parameters: {
          type: "OBJECT",
          properties: {
            order_number: { type: "STRING", description: "Order number, with or without '#'. Leave blank if not yet known." },
            reason: { type: "STRING", description: "Why they want to cancel/refund, as the customer stated it." },
          },
          required: [],
        },
      },
      {
        name: "add_to_order",
        description:
          "The customer wants to ADD one or more items to an existing (usually not-yet-shipped) order. Provide the order number and what they want to add.",
        parameters: {
          type: "OBJECT",
          properties: {
            order_number: { type: "STRING", description: "Order number, with or without '#'. Leave blank if not yet known." },
            items: { type: "STRING", description: "What the customer wants to add (e.g. '2x Italy flag transfer')." },
          },
          required: ["items"],
        },
      },
    ],
  },
];

const ACTION_NAMES = new Set(["update_address", "update_email", "duplicate_order", "add_to_order", "cancel_refund"]);

export interface ActionProposal {
  id: string;
  type: string;
  orderNumber?: string;
  summary: string; // human label, e.g. "Update #18032 address"
  args: Record<string, unknown>;
}

// Build the human-facing label + structured proposal from a detected action call.
function buildActionProposal(name: string, args: Record<string, unknown>): ActionProposal {
  const raw = String(args.order_number ?? "").trim().replace(/^#/, "");
  const order = raw ? `#${raw}` : "";
  const tail = order || "order (number TBC)";
  const summary =
    name === "update_address"
      ? `Update ${tail} address`
      : name === "update_email"
      ? `Update ${tail} email`
      : name === "duplicate_order"
      ? `Duplicate/replace ${tail}`
      : name === "add_to_order"
      ? `Add items to ${tail}`
      : name === "cancel_refund"
      ? `Cancel/refund ${tail}`
      : `${name} ${tail}`;
  return { id: crypto.randomUUID(), type: name, orderNumber: order || undefined, summary, args };
}

function actionInstruction(): string {
  return `ORDER ACTIONS — The customer may ask us to change an existing order. When they CLEARLY request one of these for a specific order, CALL the matching tool with the order number and new details:
- update_address — change the shipping address
- update_email — change the email on the order
- duplicate_order — duplicate, resend, or send a replacement for the order (lost, damaged/faulty, wrong item, or wants the same again); list only the specific items if they name them
- add_to_order — add item(s) to the order
- cancel_refund — cancel the order and/or refund the customer
A team member carries these out after confirming, so in your reply tell the customer you'll get it sorted / pass it on — do NOT claim it is already done. If the order number is unclear, still call the tool (leave order_number blank) and ask them for it in your reply. Do not call an action tool for general questions, quotes, or status checks.`;
}

// Execute a tool call and return a plain object for the functionResponse.
// `hint.orderNumber` is an order number detected server-side in the customer's
// message; it powers the automatic email→number fallback below.
async function runShopifyTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
  hint?: { orderNumber?: string }
): Promise<Record<string, unknown>> {
  if (name === "lookup_order_by_number") {
    const order = await findOrderByName(env, String(args.order_number ?? ""));
    return { found: !!order, order: order ?? null };
  }
  if (name === "lookup_orders_by_email") {
    const orders = await findOrdersByEmail(env, String(args.email ?? ""));
    if (orders.length === 0 && hint?.orderNumber) {
      // The email didn't match any order (e.g. placed under a different address,
      // or a contact-form sender). Fall back to the order number we detected in
      // their message before giving up, so a valid order isn't reported missing.
      const byNumber = await findOrderByName(env, hint.orderNumber);
      if (byNumber) return { count: 1, orders: [byNumber], matchedBy: "order_number_fallback" };
    }
    return { count: orders.length, orders };
  }
  return { error: `unknown function: ${name}` };
}

function shopifyInstruction(customerEmail?: string, orderNumber?: string): string {
  const emailLine = customerEmail
    ? `The customer's email is ${customerEmail} — use lookup_orders_by_email with it unless they give a specific order number.`
    : `Ask for or infer the order number or email from the conversation.`;
  const orderLine = orderNumber
    ? ` An order number was detected in their email: #${orderNumber}. If lookup_orders_by_email returns no orders, call lookup_order_by_number with #${orderNumber} before falling back to asking.`
    : "";
  return `LIVE ORDER LOOKUP (this supersedes guardrail 7 for this email — use live data instead of asking them for their order details):
You have tools to fetch real Shopify order and tracking data. When the customer asks about their order status, shipping, tracking, or delivery, CALL a lookup tool and answer directly from the result. ${emailLine}${orderLine}
If a lookup returns no order, then (and only then) fall back to asking them to confirm their order number or email.
If their order is lost, damaged/faulty, wrong, or they want it resent, look it up to confirm the order, then also use the duplicate_order action — looking up the data does not replace taking the action.
GREEN-FACT MARKERS: wrap every sentence that states a fact taken from the live order data (status, tracking number/carrier, item, date, total, address) in ⟦ ⟧ delimiters — e.g. "⟦Your order #17725 is paid and currently unfulfilled.⟧". Only wrap sentences containing live order facts; leave greetings, apologies, and generic text unwrapped. Never mention these markers to the customer.`;
}

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};
type GeminiContent = { role: string; parts: GeminiPart[] };
type GeminiCandidate = {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
};

export async function generateReply(
  messages: ConversationMessage[],
  env: Env,
  extraInstruction?: string,
  opts?: { shopify?: { customerEmail?: string; orderNumber?: string }; collectActions?: ActionProposal[] }
): Promise<string> {
  const settings = await getGeminiSettings(env);
  const learnedBlock = buildLearnedGuidelinesBlock(await getLearnedGuidelines(env));
  const useShopify = !!opts?.shopify && shopifyConfigured(env);
  const collectActions = opts?.collectActions;
  const actionsEnabled = !!collectActions;

  // Limit context to prevent overflow — keep most recent messages
  const recentMessages = messages.length > MAX_CONTEXT_MESSAGES
    ? messages.slice(-MAX_CONTEXT_MESSAGES)
    : messages;

  // Gemini requires contents to start with "user" role and alternate roles
  let contents: GeminiContent[] = [];
  for (const m of recentMessages) {
    const role = m.sender === "user" ? "user" : "model";
    // Include translation as context so Gemini understands non-English messages
    let text = m.text;
    if (m.translation && m.sender === "user") {
      text = `${m.text}\n[English translation: ${m.translation}]`;
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      // Merge consecutive same-role messages
      last.parts[0].text = (last.parts[0].text ?? "") + "\n" + text;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  // Must start with user
  if (contents.length > 0 && contents[0].role !== "user") {
    contents = contents.slice(1);
  }
  if (contents.length === 0) {
    throw new Error("No user messages to generate reply for");
  }
  // Must end with user — if last is model, add prompt to force reply
  if (contents[contents.length - 1].role === "model") {
    contents.push({ role: "user", parts: [{ text: "(The customer is waiting for a response. Reply to their last message.)" }] });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;

  const systemText = [
    SYSTEM_PROMPT,
    learnedBlock,
    extraInstruction,
    useShopify ? shopifyInstruction(opts?.shopify?.customerEmail, opts?.shopify?.orderNumber) : "",
    actionsEnabled ? actionInstruction() : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Merge the enabled tool declarations into the single tools array Gemini wants.
  const functionDeclarations = [
    ...(useShopify ? SHOPIFY_TOOLS[0].functionDeclarations : []),
    ...(actionsEnabled ? ACTION_TOOLS[0].functionDeclarations : []),
  ];
  const tools = functionDeclarations.length ? [{ functionDeclarations }] : undefined;
  const toolsEnabled = !!tools;

  // Function-calling loop: the model may ask to look up an order, we run it and
  // feed the result back, then it produces the final reply. Cap the rounds so a
  // misbehaving model can't loop forever. Without Shopify this runs once.
  const MAX_TOOL_ROUNDS = 4;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents,
        ...(tools ? { tools } : {}),
        generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const candidates = data.candidates as GeminiCandidate[] | undefined;
    if (!candidates || candidates.length === 0) {
      throw new Error(`Gemini blocked response: ${JSON.stringify(data.promptFeedback)}`);
    }

    const content = candidates[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p): p is Required<Pick<GeminiPart, "functionCall">> => !!p.functionCall);

    // The model wants a tool — run lookups for real; for actions, record the
    // intent (NOT executed yet) and acknowledge so it finishes the reply.
    if (toolsEnabled && calls.length > 0 && round < MAX_TOOL_ROUNDS) {
      contents.push({ role: "model", parts });
      const responseParts: GeminiPart[] = [];
      for (const c of calls) {
        const name = c.functionCall.name;
        const fnArgs = c.functionCall.args || {};
        if (collectActions && ACTION_NAMES.has(name)) {
          collectActions.push(buildActionProposal(name, fnArgs));
          responseParts.push({
            functionResponse: {
              name,
              response: {
                proposed: true,
                note: "Noted — a team member will action this after confirming. Tell the customer you'll get it sorted; do not claim it is already done.",
              },
            },
          });
        } else {
          const result = await runShopifyTool(env, name, fnArgs, { orderNumber: opts?.shopify?.orderNumber });
          responseParts.push({ functionResponse: { name, response: result } });
        }
      }
      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    const text = parts.map((p) => p.text).filter(Boolean).join("");
    if (!text) {
      throw new Error(`Gemini empty response, finishReason: ${candidates[0]?.finishReason}`);
    }
    return text;
  }

  throw new Error("Gemini exceeded the tool-call round limit without a reply");
}

export async function detectLanguage(
  text: string,
  env: Env
): Promise<string | null> {
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: "Detect the language of the text. Reply with ONLY the ISO 639-1 two-letter language code in uppercase (e.g. EN, ES, AR, FR, DE, PT, ZH, JA, KO). Nothing else." }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
    if (!result || result.length > 5) return null;
    return result;
  } catch {
    return null;
  }
}

export async function translateMessage(
  text: string,
  env: Env
): Promise<string | null> {
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: "If the text is not in English, translate it to English. Reply with ONLY the translation, nothing else. If it is already in English, reply with exactly: ALREADY_ENGLISH" }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!result || result === "ALREADY_ENGLISH") return null;
  return result;
}

export interface ParsedAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

/** Parse a free-text address (as a customer typed it) into structured fields for
 *  the agent to review before we write it to Shopify/StarShipit. Best-effort:
 *  returns {} on any failure so the agent just fills the form manually. */
export async function parseAddress(text: string, env: Env): Promise<ParsedAddress> {
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text:
          "Parse the shipping address into JSON with keys: firstName, lastName, company, address1, address2, city, province, zip, country. " +
          "address1 = street number + name; address2 = unit/apt/suite if any; province = state/region/county; zip = postal/zip code; country = full country name. " +
          "ALWAYS provide province/state AND country. If the customer did not write them explicitly, INFER them from the city and postal/zip code using your geographic knowledge — e.g. 'Melbourne 3000' -> province 'Victoria', country 'Australia'; 'Manchester M1 2AB' -> country 'United Kingdom'; 'Toronto M5V 2T6' -> province 'Ontario', country 'Canada'; 'Brooklyn NY 11201' -> province 'New York', country 'United States'. Only leave province blank if the country genuinely has no states/regions (e.g. Singapore, Monaco). Never leave country blank when the city or postcode makes it identifiable. " +
          "Use the recipient name for firstName/lastName if present. Omit only the other keys you truly can't determine. Reply with ONLY the JSON object." }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!response.ok) return {};
    const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string).trim() || undefined : undefined);
    return {
      firstName: pick("firstName"), lastName: pick("lastName"), company: pick("company"),
      address1: pick("address1"), address2: pick("address2"), city: pick("city"),
      province: pick("province"), zip: pick("zip"), country: pick("country"), phone: pick("phone"),
    };
  } catch {
    return {};
  }
}
