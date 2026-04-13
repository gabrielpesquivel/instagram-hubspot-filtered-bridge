import type { Env, ConversationMessage } from "../types";

const GUIDELINES_KEY = "agent_guidelines";
const GEMINI_SETTINGS_KEY = "gemini_settings";
const DEFAULT_MODEL = "gemini-2.0-flash";

export interface GeminiSettings {
  model: string;
}

export async function getAgentGuidelines(env: Env): Promise<string> {
  const raw = await env.PROFILE_CACHE.get(GUIDELINES_KEY);
  return raw || "";
}

export async function saveAgentGuidelines(
  text: string,
  env: Env
): Promise<void> {
  await env.PROFILE_CACHE.put(GUIDELINES_KEY, text);
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
  const [guidelines, settings] = await Promise.all([
    getAgentGuidelines(env),
    getGeminiSettings(env),
  ]);

  const systemPrompt = guidelines || "You are a helpful customer service agent. Reply concisely and professionally.";

  const contents = messages.map((m) => ({
    role: m.sender === "user" ? "user" : "model",
    parts: [{ text: m.text }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
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

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");

  return text;
}
