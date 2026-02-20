import type { Env } from "../types";

const DAILY_TTL = 90 * 24 * 60 * 60; // 90 days in seconds
const LOG_KEY = "event_log";
const MAX_LOG_ENTRIES = 50;

export interface LogEntry {
  timestamp: string;
  type: "forwarded" | "skipped" | "replied" | "error";
  message: string;
}

export async function appendLog(
  entry: Omit<LogEntry, "timestamp">,
  env: Env
): Promise<void> {
  try {
    const raw = await env.PROFILE_CACHE.get(LOG_KEY);
    const entries: LogEntry[] = raw ? JSON.parse(raw) : [];
    entries.push({ ...entry, timestamp: new Date().toISOString() });
    // Keep only the most recent entries
    const trimmed = entries.slice(-MAX_LOG_ENTRIES);
    await env.PROFILE_CACHE.put(LOG_KEY, JSON.stringify(trimmed));
  } catch {
    // Don't let logging failures break the pipeline
  }
}

export async function getRecentLogs(env: Env): Promise<LogEntry[]> {
  const raw = await env.PROFILE_CACHE.get(LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function incrementStat(key: string, env: Env): Promise<void> {
  const totalKey = `stats:${key}`;
  const dailyKey = `stats:${key}:${todayKey()}`;

  const [totalVal, dailyVal] = await Promise.all([
    env.PROFILE_CACHE.get(totalKey),
    env.PROFILE_CACHE.get(dailyKey),
  ]);

  const newTotal = (parseInt(totalVal || "0", 10) + 1).toString();
  const newDaily = (parseInt(dailyVal || "0", 10) + 1).toString();

  await Promise.all([
    env.PROFILE_CACHE.put(totalKey, newTotal),
    env.PROFILE_CACHE.put(dailyKey, newDaily, { expirationTtl: DAILY_TTL }),
  ]);
}

export interface StatsData {
  forwarded: { total: number; today: number };
  skipped_verified: { total: number; today: number };
  skipped_high_followers: { total: number; today: number };
  skipped_media: { total: number; today: number };
  replied: { total: number; today: number };
  errors: { total: number; today: number };
}

export async function getAllStats(env: Env): Promise<StatsData> {
  const keys = [
    "forwarded",
    "skipped:verified",
    "skipped:high_followers",
    "skipped:media",
    "replied",
    "errors",
  ];

  const today = todayKey();

  const results = await Promise.all(
    keys.flatMap((key) => [
      env.PROFILE_CACHE.get(`stats:${key}`),
      env.PROFILE_CACHE.get(`stats:${key}:${today}`),
    ])
  );

  const parse = (i: number) => parseInt(results[i] || "0", 10);

  return {
    forwarded: { total: parse(0), today: parse(1) },
    skipped_verified: { total: parse(2), today: parse(3) },
    skipped_high_followers: { total: parse(4), today: parse(5) },
    skipped_media: { total: parse(6), today: parse(7) },
    replied: { total: parse(8), today: parse(9) },
    errors: { total: parse(10), today: parse(11) },
  };
}
