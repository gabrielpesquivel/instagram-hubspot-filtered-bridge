import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../types";
import { clog, cerr } from "../services/logger";
import { aestDate, DAILY_PREFIX } from "./gangsheet-orders";

// Fully automatic daily gangsheet: after the 23:00 UTC (~9am AEST) order pull
// is stored, Browser Rendering opens the dashboard's own gangsheet page in
// headless Chrome with ?autogen=<date>. The page runs the SAME in-browser
// Pyodide pipeline as a manual run (so output is identical), uploads the
// finished sheet to R2 as gangsheets/<date>/<orderStart>-<orderEnd>.ai, and
// reports back through window.__gangsheetAutoResult.

const RENDER_TIMEOUT_MS = 8 * 60_000; // Pyodide boot (~60 MB) + render + upload

interface AutoResult {
  ok: boolean;
  uploaded?: string;
  skipped?: string;
  error?: string;
  items?: number;
  errors?: number;
}

/** Cron entry (chained after storeDailyOrders). Fail-soft — logs and returns. */
export async function renderDailyGangsheet(env: Env): Promise<void> {
  const date = aestDate();
  const stored = await env.GANGSHEET_FILES.get(`${DAILY_PREFIX}${date}.csv`);
  if (!stored) {
    await clog(env, `Auto gangsheet skipped: no stored pull for ${date}`);
    return;
  }
  if (!Number(stored.customMetadata?.items || 0)) {
    await clog(env, `Auto gangsheet skipped: ${date} pull has no printable items`);
    return;
  }

  // One-time session so the headless page passes dashboard auth — same KV
  // check as a real login (utils/auth.ts), short TTL, deleted in finally.
  const token = crypto.randomUUID();
  await env.PROFILE_CACHE.put(`session:${token}`, "valid", { expirationTtl: 1800 });

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    // Browser Rendering kills the session after 60s idle by default — far too
    // short for the Pyodide boot (~60 MB WASM). Extend to the render timeout.
    // protocolTimeout too: waitForFunction is one long CDP call, and the 180s
    // default killed Monday-sized (72h window) renders before completion.
    browser = await puppeteer.launch(env.BROWSER, {
      keep_alive: RENDER_TIMEOUT_MS,
      protocolTimeout: RENDER_TIMEOUT_MS,
    });
    const page = await browser.newPage();
    await page.setCookie({
      name: "session",
      value: token,
      domain: env.SELF_HOST,
      path: "/",
      httpOnly: true,
      secure: true,
    });
    await page.goto(`https://${env.SELF_HOST}/?autogen=${date}#/gangsheet`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction("window.__gangsheetAutoResult !== undefined", {
      timeout: RENDER_TIMEOUT_MS,
      polling: 2000,
    });
    const result = (await page.evaluate("window.__gangsheetAutoResult")) as AutoResult;

    if (result.ok && result.uploaded) {
      await clog(
        env,
        `Auto gangsheet stored: ${date}/${result.uploaded} — ${result.items} items` +
          (result.errors ? ` (${result.errors} errors in yellow)` : "")
      );
    } else if (result.ok) {
      await clog(env, `Auto gangsheet skipped: ${result.skipped || "nothing to render"}`);
    } else {
      await cerr(env, `Auto gangsheet failed: ${result.error || "unknown error"}`);
    }
  } catch (error) {
    await cerr(env, "Auto gangsheet render error:", error);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await env.PROFILE_CACHE.delete(`session:${token}`);
  }
}
