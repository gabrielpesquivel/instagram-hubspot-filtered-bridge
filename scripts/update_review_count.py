#!/usr/bin/env python3
"""Sync BootInk's Shop (shop.app) review stats to the internal-tools worker.

shop.app blocks datacenter IPs (Cloudflare Browser Rendering and GitHub
runners both get the challenge page), so this runs on a local machine:
scrape shop.app with real headless Chrome — which only gets through with a
spoofed NON-headless User-Agent — then log in to the worker and POST the
numbers to /api/reviews, where they land in KV for the home-page card.

Env:
  DASHBOARD_PASSWORD  worker login (falls back to .dev.vars next to this repo)
  BOOTINK_HOST        worker host (default: production workers.dev host)

Without a password the script dry-runs: scrape + print only.
Stdlib only, no dependencies. Scheduled via launchd (see
~/Library/LaunchAgents/com.bootink.review-sync.plist).
"""

import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

SHOP_APP_URL = "https://shop.app/m/an6exp15u0"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
)
DEFAULT_HOST = "bootink-internal-tools.soft-smoke-9baf.workers.dev"

# Refuse to sync an implausibly low parse (the worker rejects it too).
# The store had 1055 ratings on 2026-08-26; counts only grow.
MIN_PLAUSIBLE_COUNT = 1000

CHROME_CANDIDATES = [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome():
    for candidate in CHROME_CANDIDATES:
        path = shutil.which(candidate) or (candidate if os.path.exists(candidate) else None)
        if path:
            return path
    sys.exit("ERROR: no Chrome/Chromium binary found")


def scrape():
    result = subprocess.run(
        [
            find_chrome(),
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--user-agent=" + USER_AGENT,
            "--virtual-time-budget=20000",
            "--dump-dom",
            SHOP_APP_URL,
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    dom = result.stdout

    # Exact totals live in the escaped RSC data blob, hence the \" in the
    # pattern. totalProductRatings is the count shown as "X Reviews";
    # totalProductReviews (written-text reviews only) is NOT what we want.
    count_match = re.search(r'totalProductRatings\\",(\d+)', dom)
    avg_match = re.search(r'averageRating\\",([\d.]+)', dom)

    if not count_match:
        if "We ran into an issue" in dom:
            sys.exit("ERROR: shop.app served its challenge page (blocked IP or UA)")
        sys.exit(
            "ERROR: totalProductRatings not found in DOM "
            "(%d bytes) — shop.app page structure may have changed" % len(dom)
        )

    count = int(count_match.group(1))
    avg = float(avg_match.group(1)) if avg_match else None
    if count < MIN_PLAUSIBLE_COUNT:
        sys.exit("ERROR: parsed count %d below plausibility floor %d" % (count, MIN_PLAUSIBLE_COUNT))
    return count, avg


def load_password():
    password = os.environ.get("DASHBOARD_PASSWORD")
    if password:
        return password
    dev_vars = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".dev.vars")
    try:
        with open(dev_vars) as f:
            for line in f:
                if line.startswith("DASHBOARD_PASSWORD="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return None


def sync(host, password, count, avg):
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def post(path, payload):
        request = urllib.request.Request(
            "https://%s%s" % (host, path),
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        with opener.open(request, timeout=30) as response:
            return json.load(response)

    login = post("/api/login", {"password": password})
    if not login.get("ok"):
        sys.exit("ERROR: worker login failed: %s" % login)
    result = post("/api/reviews", {"count": count, "avgRating": avg})
    print("synced:", result)


def main():
    count, avg = scrape()
    print("scraped: %d reviews, average rating %s" % (count, avg))

    password = load_password()
    if not password:
        print("DASHBOARD_PASSWORD unset and .dev.vars unreadable — dry run, nothing synced")
        return
    sync(os.environ.get("BOOTINK_HOST", DEFAULT_HOST), password, count, avg)


if __name__ == "__main__":
    main()
