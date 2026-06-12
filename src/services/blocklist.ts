import type { Env } from "../types";
import { getDMState } from "../dm-state";

export interface BlocklistEntry {
  senderId: string;
  username: string;
  blockedAt: string;
}

export async function addToBlocklist(
  entry: Omit<BlocklistEntry, "blockedAt">,
  env: Env
): Promise<void> {
  return getDMState(env).addBlock(entry);
}

export async function removeFromBlocklist(
  senderId: string,
  env: Env
): Promise<void> {
  return getDMState(env).removeBlock(senderId);
}

export async function getBlocklist(env: Env): Promise<BlocklistEntry[]> {
  return getDMState(env).listBlocklist();
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
