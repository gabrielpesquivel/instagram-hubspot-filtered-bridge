import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import {
  getPendingAmendments,
  getLearnedGuidelines,
  getGuidelinesLog,
  approveAmendment,
  rejectAmendment,
  deleteLearnedGuideline,
  clearLearnedGuidelines,
} from "../services/gemini-api";

/** Pending proposals + the live (approved) guidelines + the permanent log. */
export async function handleGetAmendments(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const [pending, learned, log] = await Promise.all([
    getPendingAmendments(env),
    getLearnedGuidelines(env),
    getGuidelinesLog(env),
  ]);
  // Newest first for review.
  return jsonResponse({
    pending: [...pending].reverse(),
    learned: [...learned].reverse(),
    log: [...log].reverse(),
  });
}

/** Approve / reject a proposal, remove a live guideline, or clear them all
 *  ("mark as merged" after folding into the base prompt). */
export async function handleAmendmentAction(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    rule?: string;
  };
  if (!body.action) return jsonResponse({ error: "Missing action" }, 400);

  switch (body.action) {
    case "approve":
      if (!body.id) return jsonResponse({ error: "Missing id" }, 400);
      await approveAmendment(env, body.id, body.rule);
      break;
    case "reject":
      if (!body.id) return jsonResponse({ error: "Missing id" }, 400);
      await rejectAmendment(env, body.id);
      break;
    case "delete":
      if (!body.id) return jsonResponse({ error: "Missing id" }, 400);
      await deleteLearnedGuideline(env, body.id);
      break;
    case "clear-learned":
      await clearLearnedGuidelines(env);
      break;
    default:
      return jsonResponse({ error: "Unknown action" }, 400);
  }
  return jsonResponse({ ok: true });
}
