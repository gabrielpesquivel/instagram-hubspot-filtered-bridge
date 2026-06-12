import type { Env } from "../types";
import { getDMState } from "../dm-state";

export interface ConsoleLogEntry {
  timestamp: string;
  level: "log" | "error";
  message: string;
}

function stringify(...args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export async function clog(env: Env, ...args: unknown[]): Promise<void> {
  const message = stringify(...args);
  console.log(...args);
  await persist({ level: "log", message }, env);
}

export async function cerr(env: Env, ...args: unknown[]): Promise<void> {
  const message = stringify(...args);
  console.error(...args);
  await persist({ level: "error", message }, env);
}

async function persist(
  entry: Omit<ConsoleLogEntry, "timestamp">,
  env: Env
): Promise<void> {
  try {
    await getDMState(env).appendConsoleLog(entry);
  } catch {
    // Don't let logging failures break the pipeline
  }
}

export async function getConsoleLogs(env: Env): Promise<ConsoleLogEntry[]> {
  return getDMState(env).getConsoleLogs();
}
