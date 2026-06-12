# BootInk Internal Tools

A Cloudflare Worker hosting BootInk's internal tools behind a single login. After signing in, a tool picker offers:

- **Instagram DM Manager** (`#/bridge`) — receives Instagram DMs via webhook, filters messages based on sender characteristics (verified status, follower count, blocklist), and surfaces qualifying conversations in a dashboard. Agents reply directly — with optional AI-powered auto-replies via Google Gemini.
- **Gangsheet Generator** (`#/gangsheet`) — turns Shopify order CSVs into print-ready gangsheet PDF/AI files. Runs the desktop tool's exact Python code in the browser via Pyodide (WebAssembly); no server-side processing. Source of truth is `../BootinkGangsheetGenerator` — `scripts/build-gangsheet-bundle.sh` packages its `app/` code and `assets/` into `dashboard/public/gangsheet/bundle.zip` (run automatically by `npm run deploy`; rerun after changing the generator). The desktop tool's `rsvg-convert` dependency is replaced by canvas rasterization in the browser (see `gangsheet-web/web_runner.py` and `dashboard/src/gangsheet.worker.ts`).

## How It Works

```
Instagram DM → Cloudflare Worker → Signature Verify → Dedup → Profile Fetch → Filter
                                                                                  │
                    ┌─────────────────────────────────────────────────────────────┤
                    │                                                             │
              Blocklisted? ──yes──→ Skip                                          │
                    │                                                             │
              Verified? ──yes──→ Skip (handle in IG)                              │
                    │                                                             │
              High followers? ──yes──→ Skip (handle in IG)                        │
                    │                                                             │
              Known sender + auto-approve? ──yes──→ Conversation + AI auto-reply  │
                    │                                                             │
                    └──→ Pending Queue ──→ Agent approves/rejects via Dashboard
                                                    │
                                              Approved → Conversation
                                                    │
                                    Agent replies manually or AI generates reply
                                                    │
                                        Reply sent to Instagram via Graph API
```

## Architecture

- **Runtime**: Cloudflare Workers (free tier, no cold starts)
- **Storage**: Cloudflare KV (profiles, conversations, tokens, settings)
- **Frontend**: React 19 SPA served from Workers static assets
- **Instagram**: Meta Graph API v21.0
- **AI**: Google Gemini 2.5 Flash (reply generation + translation)
- **Auth**: Facebook OAuth for Meta account connection, session cookies for dashboard

## Setup

### Prerequisites

- Cloudflare account with Workers enabled
- Meta Developer App with Instagram Messaging permissions
- Node.js and npm
- Google Gemini API key (optional, for AI features)

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Cloudflare

```bash
npx wrangler login
npx wrangler kv:namespace create PROFILE_CACHE
```

Update `wrangler.toml` with the KV namespace ID.

### 3. Set Secrets

```bash
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put META_PAGE_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_PAGE_ID
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put META_ADMIN_PASSWORD
```

### 4. Deploy

```bash
npm run deploy
```

This builds the React dashboard and deploys the worker.

### 5. Configure Instagram Webhook

In your Meta App Dashboard, set the webhook callback URL to `https://<your-worker>.workers.dev/webhook/instagram` with your verify token. Subscribe to the `messages` field.

### 6. Connect Instagram Account

Open the dashboard at `https://<your-worker>.workers.dev`, log in, and click **Connect Instagram Account** to complete Facebook OAuth. This stores a long-lived page token in KV, replacing the env var fallback.

## Environment Variables

Set via `wrangler secret put` for secrets, or in `wrangler.toml` for config:

| Variable | Type | Description |
|----------|------|-------------|
| `META_APP_ID` | Secret | Facebook App ID for OAuth |
| `META_APP_SECRET` | Secret | Facebook App secret for token exchange |
| `INSTAGRAM_APP_SECRET` | Secret | Instagram App secret for webhook signature verification |
| `META_PAGE_ACCESS_TOKEN` | Secret | Page Access Token (fallback until OAuth connected) |
| `INSTAGRAM_PAGE_ID` | Secret | Instagram Business Account ID (fallback until OAuth connected) |
| `WEBHOOK_VERIFY_TOKEN` | Secret | Custom string for webhook verification |
| `GEMINI_API_KEY` | Secret | Google Gemini API key for AI replies and translation |
| `DASHBOARD_PASSWORD` | Secret | Password for dashboard login (user: `admin`) |
| `META_ADMIN_PASSWORD` | Secret | Alternative admin password (user: `metaadmin`) |
| `FILTER_MIN_FOLLOWERS` | Config | Follower threshold default (default: `5000`) |
| `CACHE_TTL_SECONDS` | Config | Profile cache duration in seconds (default: `86400`) |

> **Note:** This project uses two Meta apps. The Facebook app handles OAuth (Facebook Login) and the Instagram app handles webhook subscriptions. `META_APP_SECRET` is the Facebook app secret, `INSTAGRAM_APP_SECRET` is the Instagram app secret.

## Filter Logic

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Blocklisted user | Skip | Previously rejected or manually blocked |
| Verified account | Skip | Notable person — handle manually in IG |
| Followers ≥ threshold | Skip | Influencer/partner — handle manually in IG |
| Known sender + auto-approve | Auto-approve | Existing conversation, AI replies if enabled |
| Profile fetch fails | Forward | Fail-open for personal accounts |
| All other text messages | Pending queue | Awaits agent approval |

Filter settings (follower threshold and skip-verified toggle) are adjustable from the dashboard. Changes take effect immediately.

## Dashboard Features

- **Conversations** — View all active conversations, send replies, archive threads
- **Pending Queue** — Approve, reject, or dismiss incoming messages from new senders
- **AI Replies** — Generate and send Gemini-powered replies; per-conversation auto-reply toggle
- **Translation** — Non-English messages are translated for AI context; replies match the customer's language
- **Blocklist** — Block/unblock users by username or sender ID
- **Instagram Connection** — OAuth-based account connection with token expiry warnings
- **Filter Settings** — Adjustable follower threshold slider and verified-user toggle
- **Webhook Management** — View and subscribe page webhook subscriptions
- **Stats & Logs** — Message statistics (cumulative + daily) and activity/console logs

## API Endpoints

### Webhook

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webhook/instagram` | Meta webhook verification |
| `POST` | `/webhook/instagram` | Incoming Instagram DMs |

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Dashboard login |
| `POST` | `/api/logout` | Logout |
| `GET` | `/auth/facebook` | Initiate Facebook OAuth |
| `GET` | `/auth/facebook/callback` | OAuth callback |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/conversations` | List all conversations |
| `GET` | `/api/conversations/:senderId` | Get single conversation |
| `POST` | `/api/conversations/:senderId/reply` | Send reply |
| `POST` | `/api/conversations/:senderId/generate` | AI-generate and send reply |
| `POST` | `/api/conversations/:senderId/archive` | Archive conversation |
| `POST` | `/api/conversations/:senderId/auto-reply` | Toggle auto-reply |
| `DELETE` | `/api/conversations/:senderId/messages/:messageId` | Delete message |

### Pending Queue

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pending` | Get pending messages |
| `POST` | `/api/pending/approve` | Approve message → conversation |
| `POST` | `/api/pending/reject` | Reject and block sender |
| `POST` | `/api/pending/dismiss` | Dismiss without blocking |

### Blocklist

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/blocklist` | Get blocked users |
| `POST` | `/api/blocklist` | Block user |
| `POST` | `/api/blocklist/unblock` | Unblock user |

### Settings & Meta

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/settings/filter` | Get/update filter settings |
| `GET/POST` | `/api/settings/agent` | Get/update AI agent settings |
| `GET` | `/api/meta/connection` | Connected Instagram account info |
| `POST` | `/api/meta/disconnect` | Disconnect Instagram account |
| `POST` | `/api/meta/test-message` | Send test DM |
| `GET/POST` | `/api/meta/webhooks` | Get/subscribe webhook subscriptions |

### Dashboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats` | Message statistics |
| `GET` | `/api/logs` | Activity logs |
| `GET` | `/api/console-logs` | Console/error logs |
| `GET` | `/api/health` | System health |
| `GET` | `/` | Dashboard SPA |

## Security

- **Webhook signature verification** — Instagram webhook verifies `X-Hub-Signature-256` using HMAC-SHA256 with `INSTAGRAM_APP_SECRET`
- **Session authentication** — All `/api/*` endpoints (except login) require a valid session cookie
- **Sessions** — HttpOnly, Secure, SameSite=Strict cookies with 24-hour TTL stored in KV
- **CSRF protection** — OAuth state tokens with 10-minute TTL
- **Message deduplication** — Message ID cache with 1-hour TTL prevents webhook retry duplicates

## Facebook OAuth Flow

1. Click **Connect Instagram Account** in the dashboard
2. Redirects to Facebook Login with all required permissions
3. Exchanges code for long-lived token (~60 days)
4. Fetches user's Facebook Pages, finds the one with an Instagram Business Account
5. Stores page access token + IG account info in KV

The KV token becomes the live token. `META_PAGE_ACCESS_TOKEN` and `INSTAGRAM_PAGE_ID` env vars serve as fallback only.

### OAuth Scopes

`public_profile`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`, `business_management`, `instagram_basic`, `instagram_manage_messages`

## Project Structure

```
├── src/
│   ├── index.ts              # Worker entry point & routing
│   ├── types.ts              # TypeScript types
│   ├── handlers/
│   │   ├── instagram.ts      # Webhook handler (receive DMs)
│   │   ├── conversations.ts  # Conversation CRUD + AI replies
│   │   ├── dashboard.ts      # Stats, logs, pending, blocklist
│   │   ├── facebook-auth.ts  # Facebook OAuth flow
│   │   └── meta-api.ts       # Meta API operations
│   ├── services/
│   │   ├── filter.ts         # Message filtering logic
│   │   ├── instagram-api.ts  # Graph API calls
│   │   ├── facebook-oauth.ts # Token management
│   │   ├── conversations.ts  # Conversation storage
│   │   ├── gemini-api.ts     # AI reply generation + translation
│   │   ├── pending.ts        # Pending message queue
│   │   ├── blocklist.ts      # User blocklist
│   │   ├── stats.ts          # Statistics tracking
│   │   └── logger.ts         # Logging with KV persistence
│   └── utils/
│       ├── auth.ts           # Session authentication
│       └── crypto.ts         # Webhook signature verification
├── dashboard/
│   └── src/                  # React SPA (Vite + TypeScript)
├── public/                   # Static assets (built dashboard output)
├── wrangler.toml             # Cloudflare Workers config
├── package.json              # Dependencies & scripts
└── tsconfig.json             # TypeScript config
```

## Development

```bash
# Local dev (uses .dev.vars for secrets)
npm run dev

# Type check
npm run typecheck

# Build dashboard only
npm run build:dashboard

# Deploy (builds dashboard + deploys worker)
npm run deploy

# View logs
npx wrangler tail --format pretty
```

## Maintenance

- **Meta connection token** — Page tokens from Facebook Login are effectively permanent. Dashboard warns when the user token approaches expiry (~60 days). Reconnect via dashboard to refresh.
- **Profile cache** — Expires after 24 hours (configurable via `CACHE_TTL_SECONDS`).
- **Gemini model** — Configurable via dashboard Agent Settings. Default: `gemini-2.5-flash`.
