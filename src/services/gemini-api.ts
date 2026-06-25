import type { Env, ConversationMessage } from "../types";
import { findOrderByName, findOrdersByEmail, shopifyConfigured } from "./shopify-api";

const GEMINI_SETTINGS_KEY = "gemini_settings";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_CONTEXT_MESSAGES = 30;

const SYSTEM_PROMPT = `About BootInk:
BootInk creates custom transfers for personalising football boots — flags, names, numbers, symbols, and emojis. Over 11,000 happy customers. Based in Australia. Each order comes with alcohol towels for application.

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
7. CRITICAL: You MUST reply in the SAME LANGUAGE the customer is writing in. If they write in Arabic, reply in Arabic. If they write in Spanish, reply in Spanish. If they write in French, reply in French. NEVER reply in English unless the customer is writing in English. This overrides all other instructions — even scripted responses should be translated to match the customer's language.

Guardrails:
1. Do not declare yourself as an AI agent or present yourself with a name.
2. Do not send long messages. Keep it concise.
3. Do not share links — only reference "our website in our bio".
4. Wholesale or bulk orders → direct to sales@bootink.com. Do not make offers or over-engage.
5. Affiliates or ambassadors → direct to athletes@bootink.com. Do not make offers or over-engage.
6. Requests for free items or follows → apologise and say it is against our internal policy.
7. Order issues, package tracking, or damaged orders → tell them to email info@bootink.com.
8. Customer sends an image/reel saying "I want this one" or similar → tell them all orders can be placed on our website found in our bio.
9. Customer tags us in a story or post → thank them, show appreciation for their support, then tell them we will be in touch shortly to give them a discount code.
10. "Are you a scam?" or trust concerns → reassure them about our 11,000+ happy customers and our track record.
11. Copyrighted material requests (logos, brand designs, etc.) → tell them they must own the rights to any design they want applied.
12. Shipping availability is defined by the ship-to country list further below — answer directly from it. If the customer's country is on the list, confirm we ship there (and give the delivery estimate if asked). If it is NOT on the list, use the not-available message below. Do not tell customers to "check the website" to find out if we ship to them.
13. Discount requests → NEVER offer, promise, or agree to any discount. Reply with something like: "Sorry, we're unable to offer discounts on individual orders. For bulk or wholesale pricing, feel free to reach out to sales@bootink.com." Do not bend this rule regardless of how the customer asks.
14. Alternative product questions (e.g. "Will this work on shin pads / helmets / other items?") → confirm that our transfers will work on any product as long as the material is not fabric.

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
- Processing time: 5 business days due to demand
- Business days: Monday-Friday (AEDT), excluding Australian public holidays

For ANY country not on the ship-to list above, we do not ship there. Reply: "Sorry, it appears we do not ship to that location at this point in time. We are actively working to increase our shipping destinations and will put out an announcement when that is possible."`;

export interface GeminiSettings {
  model: string;
}

// ── Self-improving loop ──────────────────────────────────────────────────────
// When an agent edits an Auto Draft before sending, we capture the (draft →
// corrected) pair as a PENDING lesson. Pending lessons do nothing until the
// agent approves them in Settings → AI; approved lessons are fed back into the
// prompt so the model mirrors the agent's preferred wording over time.
const PENDING_KEY = "ai_corrections_pending";
const APPROVED_KEY = "ai_corrections_approved";
const MAX_PENDING = 50;
const MAX_APPROVED = 40;
const MAX_PROMPT_CORRECTIONS = 12;
const CORRECTION_FIELD_CHARS = 280;

export interface Correction {
  id: string;
  at: string;
  customer: string;
  draft: string;
  corrected: string;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > CORRECTION_FIELD_CHARS ? t.slice(0, CORRECTION_FIELD_CHARS) + "…" : t;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export async function getPendingCorrections(env: Env): Promise<Correction[]> {
  return ((await env.PROFILE_CACHE.get(PENDING_KEY, "json")) as Correction[]) || [];
}

export async function getApprovedCorrections(env: Env): Promise<Correction[]> {
  return ((await env.PROFILE_CACHE.get(APPROVED_KEY, "json")) as Correction[]) || [];
}

/** Capture an agent edit as a pending lesson (awaits approval before use). */
export async function recordCorrection(
  env: Env,
  customer: string,
  draft: string,
  corrected: string
): Promise<void> {
  if (!draft || !corrected) return;
  if (normalize(draft) === normalize(corrected)) return; // unedited — nothing to learn

  const list = await getPendingCorrections(env);
  list.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    customer: clip(customer),
    draft: clip(draft),
    corrected: clip(corrected),
  });
  await env.PROFILE_CACHE.put(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
}

/** Approve a pending lesson — move it into the active (approved) set. */
export async function approveCorrection(env: Env, id: string): Promise<void> {
  const pending = await getPendingCorrections(env);
  const item = pending.find((c) => c.id === id);
  if (!item) return;
  await env.PROFILE_CACHE.put(PENDING_KEY, JSON.stringify(pending.filter((c) => c.id !== id)));
  const approved = await getApprovedCorrections(env);
  approved.push(item);
  await env.PROFILE_CACHE.put(APPROVED_KEY, JSON.stringify(approved.slice(-MAX_APPROVED)));
}

/** Reject a pending lesson — discard it. */
export async function rejectCorrection(env: Env, id: string): Promise<void> {
  const pending = await getPendingCorrections(env);
  await env.PROFILE_CACHE.put(PENDING_KEY, JSON.stringify(pending.filter((c) => c.id !== id)));
}

/** Remove an already-approved lesson (e.g. if it turned out to be a bad one). */
export async function deleteApprovedCorrection(env: Env, id: string): Promise<void> {
  const approved = await getApprovedCorrections(env);
  await env.PROFILE_CACHE.put(APPROVED_KEY, JSON.stringify(approved.filter((c) => c.id !== id)));
}

/** Build the prompt section that teaches the model from APPROVED lessons. */
function buildLearnedBlock(corrections: Correction[]): string {
  if (corrections.length === 0) return "";
  const recent = corrections.slice(-MAX_PROMPT_CORRECTIONS);
  const examples = recent
    .map(
      (c) =>
        `Customer said: "${c.customer}"\nRejected draft: "${c.draft}"\nPreferred reply: "${c.corrected}"`
    )
    .join("\n---\n");
  return `LEARNED FROM AGENT EDITS — A human reviewed and APPROVED these corrections to past AI drafts. The "Preferred reply" is the gold standard for tone, length, wording, and policy. When a similar situation comes up, answer in the style of the Preferred replies and avoid the patterns in the Rejected drafts. These corrections OVERRIDE the general guidance above when they conflict.\n\n${examples}`;
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

// Execute a tool call and return a plain object for the functionResponse.
async function runShopifyTool(
  env: Env,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (name === "lookup_order_by_number") {
    const order = await findOrderByName(env, String(args.order_number ?? ""));
    return { found: !!order, order: order ?? null };
  }
  if (name === "lookup_orders_by_email") {
    const orders = await findOrdersByEmail(env, String(args.email ?? ""));
    return { count: orders.length, orders };
  }
  return { error: `unknown function: ${name}` };
}

function shopifyInstruction(customerEmail?: string): string {
  const emailLine = customerEmail
    ? `The customer's email is ${customerEmail} — use lookup_orders_by_email with it unless they give a specific order number.`
    : `Ask for or infer the order number or email from the conversation.`;
  return `LIVE ORDER LOOKUP (this OVERRIDES guardrail 7 about emailing info@bootink.com for this email):
You have tools to fetch real Shopify order and tracking data. When the customer asks about their order status, shipping, tracking, delivery, or a damaged/missing item, CALL the appropriate tool and answer directly from the result instead of deflecting to info@bootink.com. ${emailLine}
If a lookup returns no order, then (and only then) fall back to asking them to confirm their order number or email.
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
  opts?: { shopify?: { customerEmail?: string } }
): Promise<string> {
  const settings = await getGeminiSettings(env);
  const learnedBlock = buildLearnedBlock(await getApprovedCorrections(env));
  const useShopify = !!opts?.shopify && shopifyConfigured(env);

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
    useShopify ? shopifyInstruction(opts?.shopify?.customerEmail) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

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
        ...(useShopify ? { tools: SHOPIFY_TOOLS } : {}),
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

    // The model wants order data — run each call, append the results, loop.
    if (useShopify && calls.length > 0 && round < MAX_TOOL_ROUNDS) {
      contents.push({ role: "model", parts });
      const responseParts: GeminiPart[] = [];
      for (const c of calls) {
        const result = await runShopifyTool(env, c.functionCall.name, c.functionCall.args || {});
        responseParts.push({ functionResponse: { name: c.functionCall.name, response: result } });
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
        generationConfig: { maxOutputTokens: 4, temperature: 0 },
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
      generationConfig: { maxOutputTokens: 200, temperature: 0 },
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
