import type { Env } from "../types";
import { getDMState } from "../dm-state";

export interface LogEntry {
  timestamp: string;
  type: "forwarded" | "skipped" | "replied" | "error" | "pending";
  message: string;
}

export interface StatsData {
  pending: { total: number; today: number };
  forwarded: { total: number; today: number };
  skipped_verified: { total: number; today: number };
  skipped_high_followers: { total: number; today: number };
  skipped_blocklisted: { total: number; today: number };
  replied: { total: number; today: number };
  errors: { total: number; today: number };
}

// Counters and logs live in the DMState Durable Object — increments are
// serialized, so concurrent webhooks can't lose counts anymore.

export async function appendLog(
  entry: Omit<LogEntry, "timestamp">,
  env: Env
): Promise<void> {
  try {
    await getDMState(env).appendEventLog(entry);
  } catch {
    // Don't let logging failures break the pipeline
  }
}

export async function getRecentLogs(env: Env): Promise<LogEntry[]> {
  return getDMState(env).getEventLogs();
}

export async function incrementStat(key: string, env: Env): Promise<void> {
  try {
    await getDMState(env).incrementStat(key);
  } catch {
    // Stats are best-effort
  }
}

export async function getAllStats(env: Env): Promise<StatsData> {
  return getDMState(env).getAllStats();
}
