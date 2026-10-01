import type { Env, ConversationMessage } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import { generateReply, getGeminiSettings } from "../services/gemini-api";
import type { ActionProposal } from "../services/gemini-api";
import { EVAL_SCENARIOS, EVAL_MODELS } from "../services/support-eval";
import { getGoogleConnection, getValidGoogleToken } from "../services/google-oauth";
import { buildEmailSuggestion } from "./email";

/**
 * Prompt test bench (Settings → "Test prompt"). Runs the live prompt against
 * fixed scenarios or real unread threads on a chosen model. Read-only: nothing
 * is sent, no drafts or KV are written — proposed actions are only summarised.
 */

/** Scenario list + model choices for the modal. */
export async function handleGetEvalScenarios(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  try {
    const saved = (await getGeminiSettings(env)).model;
    const models = EVAL_MODELS.includes(saved) ? EVAL_MODELS : [saved, ...EVAL_MODELS];
    return jsonResponse({ scenarios: EVAL_SCENARIOS, models, savedModel: saved });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

/** One generation: a scenario or a real Gmail thread, on one model. */
export async function handleRunEval(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  let body: { scenarioId?: string; threadId?: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const model = (body.model || "").trim();
  if (!model) return jsonResponse({ error: "model is required" }, 400);

  const started = Date.now();
  try {
    if (body.scenarioId) {
      const sc = EVAL_SCENARIOS.find((s) => s.id === body.scenarioId);
      if (!sc) return jsonResponse({ error: `Unknown scenario ${body.scenarioId}` }, 404);
      const now = new Date().toISOString();
      const messages: ConversationMessage[] = sc.messages.map((m) => ({
        id: crypto.randomUUID(),
        sender: m.sender,
        text: m.text,
        timestamp: now,
      }));
      const actions: ActionProposal[] = [];
      const suggestion = await generateReply(messages, env, undefined, {
        shopify: { customerEmail: sc.customerEmail, orderNumber: sc.orderNumber },
        collectActions: actions,
        channel: sc.channel,
        customerName: sc.customerName,
        model,
      });
      return jsonResponse({ suggestion, actions: actions.map((a) => a.summary), ms: Date.now() - started });
    }

    if (body.threadId) {
      const conn = await getGoogleConnection(env);
      const token = await getValidGoogleToken(env);
      if (!conn || !token) return jsonResponse({ error: "Gmail not connected" }, 409);
      const result = await buildEmailSuggestion(env, token, conn.email, body.threadId, undefined, model);
      if (!result) return jsonResponse({ error: "Thread not found or no customer message to reply to" }, 404);
      return jsonResponse({
        suggestion: result.suggestion,
        actions: result.actions.map((a) => a.summary),
        ms: Date.now() - started,
      });
    }

    return jsonResponse({ error: "scenarioId or threadId is required" }, 400);
  } catch (error) {
    // Surface the real cause (bad model name, Gemini 4xx…) — it's an admin tool.
    return jsonResponse({ error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }, 502);
  }
}
