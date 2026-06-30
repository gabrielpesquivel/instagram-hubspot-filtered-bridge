import type { Env } from "../types";
import { isAuthenticated, jsonResponse } from "../utils/auth";

// SOTA background removal for the gangsheet tool's hard images (fine lines, low
// contrast, busy/weird backgrounds) — the cases the in-browser @imgly model and
// the flood-fill chroma key both struggle with.
//
// Flow: browser POSTs the customer image URL → WE fetch the image bytes and send
// them to fal.ai's BRIA RMBG-2.0 inline as a base64 data URI → fal returns a
// result URL → we fetch that PNG and stream the bytes back. The fal key never
// leaves the worker. When FAL_KEY is unset, we return 503 so the browser falls
// back to its local model.
//
// NOTE: we fetch the source image ourselves rather than handing fal the URL —
// fal's server-side downloader rejects most external hosts (verified: github,
// picsum, wikimedia all fail with file_download_error). The worker can reach the
// public/CORS-open customer CDN fine, so inlining the bytes is the reliable path.

const FAL_ENDPOINT = "https://fal.run/fal-ai/bria/background/remove";
const FAL_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB source cap

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// POST /api/remove-bg  body: { url: string }  → image/png bytes (transparent bg)
export async function handleRemoveBackground(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!env.FAL_KEY) {
    // Not configured — tell the browser to use its local fallback.
    return jsonResponse({ error: "Background removal not configured" }, 503);
  }

  let url = "";
  try {
    const body = (await request.json()) as { url?: string };
    url = body.url ?? "";
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return jsonResponse({ error: "Missing or invalid image url" }, 400);
  }

  // 1) Fetch the source image ourselves and inline it as a base64 data URI.
  let dataUri: string;
  try {
    const srcResp = await fetch(url, { signal: AbortSignal.timeout(FAL_TIMEOUT_MS) });
    if (!srcResp.ok) {
      return jsonResponse({ error: "Failed to fetch source image", status: srcResp.status }, 502);
    }
    const buf = await srcResp.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return jsonResponse({ error: "Source image too large (max 25 MB)" }, 413);
    }
    const contentType = srcResp.headers.get("Content-Type") || "image/png";
    dataUri = `data:${contentType};base64,${bytesToBase64(new Uint8Array(buf))}`;
  } catch (e) {
    return jsonResponse({ error: "Failed to fetch source image", detail: String(e) }, 502);
  }

  // 2) Ask fal to remove the background. Sync endpoint blocks until done.
  let falJson: { image?: { url?: string } };
  try {
    const falResp = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_url: dataUri }),
      signal: AbortSignal.timeout(FAL_TIMEOUT_MS),
    });
    if (!falResp.ok) {
      const detail = await falResp.text().catch(() => "");
      return jsonResponse(
        { error: "Background removal failed", status: falResp.status, detail: detail.slice(0, 500) },
        502,
      );
    }
    falJson = await falResp.json();
  } catch (e) {
    return jsonResponse({ error: "Background removal request failed", detail: String(e) }, 502);
  }

  const resultUrl = falJson.image?.url;
  if (!resultUrl) {
    return jsonResponse({ error: "Background removal returned no image" }, 502);
  }

  // 3) Fetch the processed PNG and stream it back to the browser.
  let imgResp: Response;
  try {
    imgResp = await fetch(resultUrl, { signal: AbortSignal.timeout(FAL_TIMEOUT_MS) });
  } catch (e) {
    return jsonResponse({ error: "Failed to fetch processed image", detail: String(e) }, 502);
  }
  if (!imgResp.ok || !imgResp.body) {
    return jsonResponse({ error: "Failed to fetch processed image", status: imgResp.status }, 502);
  }

  return new Response(imgResp.body, {
    headers: {
      "Content-Type": imgResp.headers.get("Content-Type") || "image/png",
      "Cache-Control": "no-store",
    },
  });
}
