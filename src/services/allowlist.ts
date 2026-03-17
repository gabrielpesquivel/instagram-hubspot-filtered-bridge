import type { Env } from "../types";

const KV_KEY = "allowlist";

export interface AllowlistEntry {
  senderId: string;
  username: string;
  approvedAt: string;
}

export async function addToAllowlist(
  entry: Omit<AllowlistEntry, "approvedAt">,
  env: Env
): Promise<void> {
  const list = await getAllowlist(env);
  if (list.some((e) => e.senderId === entry.senderId)) return;
  list.push({ ...entry, approvedAt: new Date().toISOString() });
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(list));
}

export async function getAllowlist(env: Env): Promise<AllowlistEntry[]> {
  const raw = await env.PROFILE_CACHE.get(KV_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function isAllowlisted(
  senderId: string,
  env: Env
): Promise<boolean> {
  const list = await getAllowlist(env);
  return list.some((e) => e.senderId === senderId);
}
