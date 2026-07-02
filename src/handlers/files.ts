import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";

// Daily gangsheet uploads stored in R2 under: gangsheets/<YYYY-MM-DD>/<filename>

const PREFIX = "gangsheets/";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB per file

function keyFor(date: string, name: string): string {
  return `${PREFIX}${date}/${name}`;
}

// Strip path separators / leading dots so a filename can't escape its day prefix
function sanitizeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() || "";
  return base.replace(/^\.+/, "").trim();
}

// GET /api/files?date=YYYY-MM-DD  → list files uploaded for that day
export async function handleListFiles(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const date = new URL(request.url).searchParams.get("date") || "";
  if (!DATE_RE.test(date)) {
    return jsonResponse({ error: "Invalid or missing date (YYYY-MM-DD)" }, 400);
  }

  const prefix = `${PREFIX}${date}/`;
  const listed = await env.GANGSHEET_FILES.list({ prefix });
  const files = listed.objects.map((o) => ({
    key: o.key,
    name: o.key.slice(prefix.length),
    size: o.size,
    uploaded: o.uploaded.toISOString(),
  }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse({ date, files });
}

// PUT /api/files?date=YYYY-MM-DD&name=<filename>  → upload / replace (overwrites same name)
export async function handleUploadFile(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const params = new URL(request.url).searchParams;
  const date = params.get("date") || "";
  const name = sanitizeName(params.get("name") || "");
  if (!DATE_RE.test(date)) {
    return jsonResponse({ error: "Invalid or missing date (YYYY-MM-DD)" }, 400);
  }
  if (!name) {
    return jsonResponse({ error: "Missing or invalid file name" }, 400);
  }
  if (!request.body) {
    return jsonResponse({ error: "Empty body" }, 400);
  }

  // Stream straight to R2 — buffering a 200 MB body would exceed the Worker's
  // 128 MB memory limit. R2 needs a known length, so require Content-Length
  // (browsers set it automatically for File/Blob bodies).
  const size = Number(request.headers.get("Content-Length"));
  if (!Number.isFinite(size) || size <= 0) {
    return jsonResponse({ error: "Missing Content-Length" }, 411);
  }
  if (size > MAX_BYTES) {
    return jsonResponse({ error: "File too large (max 200 MB)" }, 413);
  }

  await env.GANGSHEET_FILES.put(keyFor(date, name), request.body, {
    httpMetadata: {
      contentType: request.headers.get("Content-Type") || "application/octet-stream",
    },
  });

  return jsonResponse({ ok: true, name, size });
}

// GET /api/files/get?key=gangsheets/<date>/<name>  → stream the file for download/view
export async function handleGetFile(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!key.startsWith(PREFIX)) {
    return jsonResponse({ error: "Invalid key" }, 400);
  }

  const obj = await env.GANGSHEET_FILES.get(key);
  if (!obj) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const name = key.slice(key.lastIndexOf("/") + 1);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Length", String(obj.size));
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(name)}"`);
  return new Response(obj.body, { headers });
}

// DELETE /api/files?key=gangsheets/<date>/<name>  → delete one file
export async function handleDeleteFile(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!key.startsWith(PREFIX)) {
    return jsonResponse({ error: "Invalid key" }, 400);
  }
  await env.GANGSHEET_FILES.delete(key);
  return jsonResponse({ ok: true });
}
