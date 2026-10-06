-- One row per storefront session (Essence theme, snippets/bundle-test-head.liquid):
-- a session starts on the first page view or after 30 min without one.
CREATE TABLE IF NOT EXISTS sessions (
  sid      TEXT PRIMARY KEY,   -- random session id (browser)
  vid      TEXT NOT NULL,      -- random visitor id (browser, kept a year)
  ts       INTEGER NOT NULL,   -- received, epoch ms
  day      TEXT NOT NULL,      -- YYYY-MM-DD in AEST (same as the order buckets)
  grp      TEXT NOT NULL,      -- 'kit' | 'tier' (GB is always 'kit')
  country  TEXT NOT NULL,      -- storefront country (Shopify.country)
  currency TEXT,
  landing  TEXT,               -- landing path
  referrer TEXT,               -- referrer host
  mobile   INTEGER             -- 1 = narrow screen
);
CREATE INDEX IF NOT EXISTS sessions_day ON sessions (day);
