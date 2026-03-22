import type { Env } from "../types";

const KV_KEY = "blocklist";

export interface BlocklistEntry {
  senderId: string;
  username: string;
  blockedAt: string;
}

export async function addToBlocklist(
  entry: Omit<BlocklistEntry, "blockedAt">,
  env: Env
): Promise<void> {
  const list = await getBlocklist(env);
  if (list.some((e) => e.senderId === entry.senderId)) return;
  list.push({ ...entry, blockedAt: new Date().toISOString() });
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(list));
}

export async function removeFromBlocklist(
  senderId: string,
  env: Env
): Promise<void> {
  const list = await getBlocklist(env);
  const filtered = list.filter((e) => e.senderId !== senderId);
  await env.PROFILE_CACHE.put(KV_KEY, JSON.stringify(filtered));
}

export async function getBlocklist(env: Env): Promise<BlocklistEntry[]> {
  const raw = await env.PROFILE_CACHE.get(KV_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function isBlocklisted(
  senderId: string,
  env: Env,
  username?: string
): Promise<boolean> {
  const list = await getBlocklist(env);
  return list.some(
    (e) =>
      e.senderId === senderId ||
      (username && e.username.toLowerCase() === username.toLowerCase())
  );
}
