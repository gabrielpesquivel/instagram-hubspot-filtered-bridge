import type { Env } from "../types";

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

export async function isAuthenticated(
  request: Request,
  env: Env
): Promise<boolean> {
  const token = getCookie(request, "session");
  if (!token) return false;
  const session = await env.PROFILE_CACHE.get(`session:${token}`);
  return session === "valid";
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
