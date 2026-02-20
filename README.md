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
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_PAGE_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_PAGE_ID
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put HUBSPOT_CLIENT_ID
npx wrangler secret put HUBSPOT_CLIENT_SECRET
npx wrangler secret put HUBSPOT_CUSTOM_CHANNEL_ID
```

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
| `GET` | `/` | Health check |
| `GET` | `/webhook/instagram` | Meta webhook verification |
| `POST` | `/webhook/instagram` | Incoming Instagram DMs |
| `POST` | `/webhook/hubspot` | Outbound replies from HubSpot |
| `GET` | `/auth/hubspot` | Initiate HubSpot OAuth |
| `GET` | `/auth/hubspot/callback` | OAuth token exchange |
| `GET` | `/connect/hubspot` | Channel account connection flow |

## Filter Logic

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Verified account | Skip | Notable person — handle manually |
| 5000+ followers | Skip | Influencer/partner — handle manually |
| Media message (image/video/audio) | Skip | Requires special handling |
| Text from standard account | Forward | Standard customer inquiry |
| Profile fetch fails (personal accounts) | Forward | Fail-open by design |

Follower count and verification status are only available for Instagram Business/Creator accounts. Personal accounts are forwarded by default.

## Environment Variables

Set via `wrangler secret put` for secrets, or in `wrangler.toml` for config:

| Variable | Type | Description |
|----------|------|-------------|
| `META_APP_SECRET` | Secret | Instagram App secret (not Facebook App — see note below) |
| `META_PAGE_ACCESS_TOKEN` | Secret | Long-lived Page Access Token (60-day expiry) |
| `INSTAGRAM_PAGE_ID` | Secret | Instagram Business Account ID |
| `WEBHOOK_VERIFY_TOKEN` | Secret | Custom string for webhook verification |
| `HUBSPOT_CLIENT_ID` | Secret | HubSpot Public App Client ID |
| `HUBSPOT_CLIENT_SECRET` | Secret | HubSpot Public App Client Secret |
| `HUBSPOT_CUSTOM_CHANNEL_ID` | Secret | From channel registration response |
| `FILTER_MIN_FOLLOWERS` | Config | Follower threshold (default: 5000) |
| `CACHE_TTL_SECONDS` | Config | Profile cache duration (default: 86400) |

> **Important:** This project uses two Meta apps. The `META_APP_SECRET` must come from the **Instagram App** (the one with the webhook subscription), not the Facebook App. You can verify which app owns the webhook by calling `GET /{app-id}/subscriptions` with the app access token (`app_id|app_secret`). An empty `data` array means that app has no subscriptions.

## Security

Both webhook endpoints enforce signature verification and reject unauthenticated requests with `401 Unauthorized`:

- **Instagram webhook** (`POST /webhook/instagram`): Verifies `X-Hub-Signature-256` header using HMAC-SHA256 with the Instagram App Secret.
- **HubSpot webhook** (`POST /webhook/hubspot`): Verifies `X-HubSpot-Signature-v2` header using SHA-256 of `clientSecret + httpMethod + httpUrl + requestBody`.

## Meta App Review

The use case has been **approved** by Meta. All permissions were rejected solely because the screencast didn't demonstrate the full end-to-end flow. The following features need to be implemented and shown in a re-submitted screencast.

### What needs to be built

| # | Task | Permissions it satisfies |
|---|------|--------------------------|
| 1 | **Facebook Login flow in dashboard** — Add a "Connect Instagram Account" button that initiates Facebook Login OAuth, shows the consent screen with all permissions, and stores the resulting token. | All — reviewers must see the Meta Login flow and a user granting permissions |
| 2 | **Display connected Page/IG account** — After login, show the connected Facebook Page name and Instagram Business account in the dashboard. | `pages_show_list`, `instagram_business_basic`, `pages_read_engagement`, `business_management` |
| 3 | **"Send Test Message" UI** — Add a section in the dashboard to send a message to an Instagram user and show it delivered in the native app. | `instagram_business_manage_messages`, `pages_messaging`, `instagram_manage_messages` |
| 4 | **Webhook subscription management** — Show/manage webhook subscriptions from the dashboard. | `pages_manage_metadata` |
| 5 | **Record end-to-end screencast** — Demonstrate the full flow per Meta's requirements (see below). | All |

### Screencast requirements

The screencast must show:

1. **Complete Meta Login flow** — Open dashboard, click connect, show Facebook Login dialog with all permissions, grant access
2. **Connected assets visible** — After login, show the connected Facebook Page and Instagram account
3. **Incoming message flow** — Send a DM from a test Instagram account, show it arriving in the dashboard activity log and in HubSpot inbox
4. **Outgoing message flow** — Use the "Send Test Message" UI to send a message, then show it appearing in the native Instagram app
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
| `pages_read_engagement` | Read Page engagement data for connected account display |
| `instagram_business_basic` | Access Instagram Business account info (username, followers) |
| `instagram_business_manage_messages` | Receive and read Instagram DMs via webhook |
| `pages_show_list` | List Facebook Pages the user manages |
| `pages_manage_metadata` | Subscribe Pages to webhook events |
| `pages_messaging` | Send messages on behalf of a Page |
| `business_management` | Access Business Manager assets |
| `instagram_manage_messages` | Send messages via Instagram |
| `instagram_basic` | Basic Instagram account access |

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

- **Page Access Token** expires every 60 days. Regenerate and update with `npx wrangler secret put META_PAGE_ACCESS_TOKEN`.
- **HubSpot OAuth** tokens auto-refresh. If the refresh token is revoked (app uninstalled/scopes changed), re-authorize at `/auth/hubspot`.
- **Profile cache** expires after 24 hours (configurable via `CACHE_TTL_SECONDS`).
