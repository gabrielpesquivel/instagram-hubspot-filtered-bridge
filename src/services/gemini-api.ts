import type { Env, ConversationMessage } from "../types";

const GEMINI_SETTINGS_KEY = "gemini_settings";
const DEFAULT_MODEL = "gemini-2.5-flash";

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
12. If unsure whether we ship to a country, say: "For shipping availability to your location, please check the shipping policy on our website in our bio. If products appear as sold out, that indicates shipping is not currently available in your country."
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
- Australia & New Zealand: 3-6 business days
- USA, Canada: 6-10 business days
- United Kingdom: 6-10 business days
- EU Zone 1 (Austria, Belgium, Czechia, France, Germany, Hungary, Ireland, Italy, Luxembourg, Netherlands, Poland, Portugal, Spain, Sweden): 6-10 business days
- EU Zone 2 (Bulgaria, Croatia, Denmark, Estonia, Finland, Greece, Latvia, Lithuania, Romania, Slovakia, Slovenia): 6-10 business days
- Rest of Europe: 6-12 business days
- Asia & Rest of World (Japan, Hong Kong, Indonesia, Malaysia, Philippines, Singapore, South Korea, Taiwan, Thailand, Cyprus): 6-12 business days
- Processing time: 5 business days due to demand
- Business days: Monday-Friday (AEDT), excluding Australian public holidays
- We do NOT ship to: India, Mexico, or any country in South America.
- If a country is not listed above, we likely do not ship there. Say: "Sorry, it appears we do not ship to that location at this point in time. We are actively working to increase our shipping destinations and will put out an announcement when that is possible."`;

export interface GeminiSettings {
  model: string;
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

export async function generateReply(
  messages: ConversationMessage[],
  env: Env
): Promise<string> {
  const settings = await getGeminiSettings(env);

  // Gemini requires contents to start with "user" role and alternate roles
  let contents: { role: string; parts: { text: string }[] }[] = [];
  for (const m of messages) {
    const role = m.sender === "user" ? "user" : "model";
    // Include translation as context so Gemini understands non-English messages
    let text = m.text;
    if (m.translation && m.sender === "user") {
      text = `${m.text}\n[English translation: ${m.translation}]`;
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      // Merge consecutive same-role messages
      last.parts[0].text += "\n" + text;
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.7,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const candidates = data.candidates as { content?: { parts?: { text?: string }[] }; finishReason?: string }[] | undefined;

  if (!candidates || candidates.length === 0) {
    const blockReason = (data as Record<string, unknown>).promptFeedback;
    throw new Error(`Gemini blocked response: ${JSON.stringify(blockReason)}`);
  }

  const text = candidates[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini empty response, finishReason: ${candidates[0]?.finishReason}`);
  }

  return text;
}

export async function translateMessage(
  text: string,
  env: Env
): Promise<string | null> {
  const settings = await getGeminiSettings(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
