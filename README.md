# Instagram-HubSpot Filtered Bridge

A Cloudflare Worker that receives Instagram DMs via webhook, filters out high-value conversations (verified accounts, 5000+ followers, media messages), and forwards qualifying text messages to HubSpot's Conversations Inbox via the Custom Channels API.

## How It Works

```
Instagram DM → Cloudflare Worker → Filter → HubSpot Inbox
                                      │
                                      ├─ Verified account? → Skip (handle manually in IG)
                                      ├─ 5000+ followers?  → Skip (handle manually in IG)
                                      ├─ Media message?    → Skip (handle manually in IG)
                                      └─ Text from normal account → Forward to HubSpot
```

HubSpot agents can reply directly from the inbox — replies are sent back to Instagram via the outbound webhook.

## Architecture

- **Runtime**: Cloudflare Workers (free tier, no cold starts)
- **Storage**: Cloudflare KV (profile cache + OAuth tokens)
- **Instagram**: Meta Graph API v21.0 via `graph.facebook.com`
- **HubSpot**: Custom Channels API with OAuth 2.0 (Public App)

## Setup

### Prerequisites

- Cloudflare account with Workers enabled
- Meta Developer App with Instagram Messaging
- HubSpot Professional or Enterprise (Sales or Service Hub)
- Node.js and npm

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

### 3. Create HubSpot Public App

1. Go to [developers.hubspot.com](https://developers.hubspot.com)
2. Create a Public App with scopes:
   - `conversations.custom_channels.read`
   - `conversations.custom_channels.write`
   - `conversations.read`
   - `conversations.write`
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
3. Set redirect URL to `https://<your-worker>.workers.dev/auth/hubspot/callback`

### 4. Register Custom Channel

```bash
curl -X POST 'https://api.hubapi.com/conversations/v3/custom-channels?hapikey=<DEV_API_KEY>&appId=<APP_ID>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Instagram DM Bridge","webhookUrl":"https://<your-worker>.workers.dev/webhook/hubspot","capabilities":{"deliveryIdentifierTypes":["CHANNEL_SPECIFIC_OPAQUE_ID"],"richText":["BOLD","ITALIC","HYPERLINK"],"allowOutgoingMessages":true,"allowConversationStart":false,"maxFileAttachmentCount":0,"maxFileAttachmentSizeBytes":0,"threadingModel":"INTEGRATION_THREAD_ID"}}'
```

### 5. Set Secrets

```bash
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put META_PAGE_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_PAGE_ID
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put HUBSPOT_CLIENT_ID
npx wrangler secret put HUBSPOT_CLIENT_SECRET
npx wrangler secret put HUBSPOT_CUSTOM_CHANNEL_ID
npx wrangler secret put DASHBOARD_PASSWORD
```

- `META_APP_ID` / `META_APP_SECRET` — from the **Facebook app** (used for Facebook Login OAuth). Find the App ID at the top of your app dashboard on [developers.facebook.com](https://developers.facebook.com/apps/).
- `INSTAGRAM_APP_SECRET` — from the **Instagram app** (used for webhook signature verification). This is a separate app from the Facebook Login app.

### 6. Deploy

```bash
npm run deploy
```

### 7. Authorize HubSpot OAuth

Visit `https://<your-worker>.workers.dev/auth/hubspot` and authorize the app.

### 8. Connect Channel in HubSpot

Go to **HubSpot Settings > Inbox & Help Desk > Channels > Connect a channel** and select your custom channel.

### 9. Configure Instagram Webhook

In your Meta App Dashboard, set the webhook callback URL to `https://<your-worker>.workers.dev/webhook/instagram` with your verify token. Subscribe to the `messages` field.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard (SPA) |
| `GET` | `/webhook/instagram` | Meta webhook verification |
| `POST` | `/webhook/instagram` | Incoming Instagram DMs |
| `POST` | `/webhook/hubspot` | Outbound replies from HubSpot |
| `GET` | `/auth/hubspot` | Initiate HubSpot OAuth |
| `GET` | `/auth/hubspot/callback` | OAuth token exchange |
| `GET` | `/connect/hubspot` | Channel account connection flow |
| `GET` | `/auth/facebook` | Initiate Facebook Login OAuth (redirects to FB) |
| `GET` | `/auth/facebook/callback` | Facebook OAuth callback (stores tokens in KV) |
| `GET` | `/api/meta/connection` | Get connected Instagram account status |
| `POST` | `/api/meta/disconnect` | Disconnect Instagram account (clear KV tokens) |
| `POST` | `/api/meta/test-message` | Send a test Instagram DM |
| `GET` | `/api/meta/webhooks` | Get page webhook subscription status |
| `POST` | `/api/meta/webhooks` | Subscribe page to webhook fields |
| `GET` | `/api/settings/filter` | Get current filter settings |
| `POST` | `/api/settings/filter` | Update filter settings (follower threshold, skip verified) |

## Filter Logic

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Verified account | Skip | Notable person — handle manually |
| 5000+ followers | Skip | Influencer/partner — handle manually |
| Media message (image/video/audio) | Skip | Requires special handling |
| Text from standard account | Forward | Standard customer inquiry |
| Profile fetch fails (personal accounts) | Forward | Fail-open by design |

Follower count and verification status are only available for Instagram Business/Creator accounts. Personal accounts are forwarded by default.

Filter settings (follower threshold and skip-verified toggle) are adjustable from the dashboard and stored in KV. Changes take effect immediately.

## Environment Variables

Set via `wrangler secret put` for secrets, or in `wrangler.toml` for config:

| Variable | Type | Description |
|----------|------|-------------|
| `META_APP_ID` | Secret | Facebook App ID — used for Facebook Login OAuth |
| `META_APP_SECRET` | Secret | Facebook App secret — used for OAuth token exchange |
| `INSTAGRAM_APP_SECRET` | Secret | Instagram App secret — used for webhook signature verification |
| `META_PAGE_ACCESS_TOKEN` | Secret | Long-lived Page Access Token — fallback only, replaced by Facebook Login |
| `INSTAGRAM_PAGE_ID` | Secret | Instagram Business Account ID — fallback only, replaced by Facebook Login |
| `WEBHOOK_VERIFY_TOKEN` | Secret | Custom string for webhook verification |
| `HUBSPOT_CLIENT_ID` | Secret | HubSpot Public App Client ID |
| `HUBSPOT_CLIENT_SECRET` | Secret | HubSpot Public App Client Secret |
| `HUBSPOT_CUSTOM_CHANNEL_ID` | Secret | From channel registration response |
| `DASHBOARD_PASSWORD` | Secret | Password for the dashboard login |
| `FILTER_MIN_FOLLOWERS` | Config | Follower threshold default (default: 5000, adjustable via dashboard) |
| `CACHE_TTL_SECONDS` | Config | Profile cache duration (default: 86400) |

> **Important:** This project uses two Meta apps. The Facebook app handles OAuth (Facebook Login) and the Instagram app handles webhook subscriptions. `META_APP_SECRET` is the Facebook app secret, `INSTAGRAM_APP_SECRET` is the Instagram app secret. You can verify which app owns the webhook by calling `GET /{app-id}/subscriptions` with the app access token (`app_id|app_secret`).

## Security

Webhook endpoints enforce signature verification:

- **Instagram webhook** (`POST /webhook/instagram`): Verifies `X-Hub-Signature-256` header using HMAC-SHA256 with the Instagram App Secret (`INSTAGRAM_APP_SECRET`).
- **HubSpot webhook** (`POST /webhook/hubspot`): Verifies `X-HubSpot-Signature-v3` header using HMAC-SHA256 with the HubSpot Client Secret, with v2 fallback.

## Facebook Login & Meta Connection

The dashboard includes a full Facebook Login OAuth flow. This replaces the manual `META_PAGE_ACCESS_TOKEN` setup — once connected, the bridge uses the OAuth token stored in KV.

### How it works

1. Click **"Connect Instagram Account"** in the dashboard
2. Redirects to Facebook Login dialog requesting all required permissions
3. On approval, exchanges the code for a long-lived token (~60 days)
4. Fetches the user's Facebook Pages and finds the one with an Instagram Business Account
5. Stores the page access token and IG account info in KV

The stored KV token becomes the live token used by the bridge pipeline. `META_PAGE_ACCESS_TOKEN` and `INSTAGRAM_PAGE_ID` env vars serve as fallback until the first Facebook Login is completed.

### Dashboard features

- **Instagram Connection** — Shows connected Page/IG account, profile picture, token expiry. Warns when token expires within 7 days. Disconnect button to revert to env var fallback.
- **Filter Settings** — Adjustable follower threshold slider (0–100K) and verified user toggle, saved to KV and applied in real-time.
- **Webhook Subscriptions** — Check and manage page webhook subscriptions (subscribe to `messages` field).

### OAuth scopes requested

`public_profile`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`, `business_management`, `instagram_basic`, `instagram_manage_messages`

## Meta App Review

The use case has been **approved** by Meta. All permissions were rejected solely because the screencast didn't demonstrate the full end-to-end flow. The features below have been built and need to be demonstrated in a re-submitted screencast.

### Implemented features

| # | Feature | Status | Permissions it satisfies |
|---|---------|--------|--------------------------|
| 1 | **Facebook Login flow** — "Connect Instagram Account" button initiates OAuth, shows consent screen, stores token in KV | Done | All — reviewers must see the Meta Login flow |
| 2 | **Display connected Page/IG account** — Shows Facebook Page name, IG username, profile pic, token expiry | Done | `pages_show_list`, `instagram_basic`, `pages_read_engagement`, `business_management` |
| 3 | **Bidirectional messaging** — Incoming DMs forwarded to HubSpot, replies from HubSpot sent back to Instagram | Done | `instagram_manage_messages`, `pages_messaging` |
| 4 | **Webhook subscription management** — View/manage webhook subscriptions from dashboard | Done | `pages_manage_metadata` |
| 5 | **Filter settings UI** — Adjustable follower threshold and verified user toggle | Done | — |
| 6 | **Record end-to-end screencast** — Demonstrate the full flow per Meta's requirements | TODO | All |

### Screencast requirements

The screencast must show:

1. **Complete Meta Login flow** — Open dashboard, click connect, show Facebook Login dialog with all permissions, grant access
2. **Connected assets visible** — After login, show the connected Facebook Page and Instagram account
3. **Incoming message flow** — Send a DM from a test Instagram account, show it arriving in the dashboard activity log and in HubSpot inbox
4. **Outgoing message flow** — Reply from HubSpot and show it appearing in the native Instagram app
5. **Webhook management** — Show the webhook subscription status

Additional:
- Use English in all UI
- Add captions/tooltips explaining each step
- Note in submission that this is a server-to-server app using system user tokens for the background bridge, but includes Facebook Login for account connection
- Follow [Meta's Screen Recording Guide](https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings/)

### Permissions requested

| Permission | Purpose |
|------------|---------|
| `public_profile` | Approved |
| `pages_show_list` | List Facebook Pages the user manages |
| `pages_read_engagement` | Read Page engagement data for connected account display |
| `pages_manage_metadata` | Subscribe Pages to webhook events |
| `pages_messaging` | Send messages on behalf of a Page |
| `business_management` | Access Business Manager assets |
| `instagram_basic` | Access Instagram Business account info (username, followers) |
| `instagram_manage_messages` | Send and receive Instagram DMs |

## Development

```bash
# Local dev (uses .dev.vars for secrets)
npm run dev

# Type check
npm run typecheck

# Deploy
npm run deploy

# View logs
npx wrangler tail --format pretty
```

## Maintenance

- **Meta connection token** — Page tokens obtained via Facebook Login (from a long-lived user token) are effectively permanent. The dashboard warns when the user token approaches expiry (~60 days). Reconnect via the dashboard to refresh. The env var `META_PAGE_ACCESS_TOKEN` is only used as fallback if no Facebook Login has been completed.
- **HubSpot OAuth** tokens auto-refresh. If the refresh token is revoked (app uninstalled/scopes changed), re-authorize at `/auth/hubspot`.
- **Profile cache** expires after 24 hours (configurable via `CACHE_TTL_SECONDS`).
