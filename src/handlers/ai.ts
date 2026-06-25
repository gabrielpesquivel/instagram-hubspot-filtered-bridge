import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";
import {
  getPendingCorrections,
  getApprovedCorrections,
  approveCorrection,
  rejectCorrection,
  deleteApprovedCorrection,
} from "../services/gemini-api";

/** Pending (awaiting approval) + approved (active) AI lessons. */
export async function handleGetCorrections(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const [pending, approved] = await Promise.all([
    getPendingCorrections(env),
    getApprovedCorrections(env),
  ]);
  // Newest first for review.
  return jsonResponse({ pending: [...pending].reverse(), approved: [...approved].reverse() });
}

/** Approve / reject a pending lesson, or remove an approved one. */
export async function handleCorrectionAction(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return jsonResponse({ error: "Unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!body.id || !body.action) return jsonResponse({ error: "Missing id or action" }, 400);

  switch (body.action) {
    case "approve":
      await approveCorrection(env, body.id);
      break;
    case "reject":
      await rejectCorrection(env, body.id);
      break;
    case "delete":
      await deleteApprovedCorrection(env, body.id);
      break;
    default:
      return jsonResponse({ error: "Unknown action" }, 400);
  }
  return jsonResponse({ ok: true });
}
