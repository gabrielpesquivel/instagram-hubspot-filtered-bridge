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
| `META_APP_SECRET` | Secret | Meta App Dashboard > Settings > Basic |
| `META_PAGE_ACCESS_TOKEN` | Secret | Long-lived Page Access Token (60-day expiry) |
| `INSTAGRAM_PAGE_ID` | Secret | Instagram Business Account ID |
| `WEBHOOK_VERIFY_TOKEN` | Secret | Custom string for webhook verification |
| `HUBSPOT_CLIENT_ID` | Secret | HubSpot Public App Client ID |
| `HUBSPOT_CLIENT_SECRET` | Secret | HubSpot Public App Client Secret |
| `HUBSPOT_CUSTOM_CHANNEL_ID` | Secret | From channel registration response |
| `FILTER_MIN_FOLLOWERS` | Config | Follower threshold (default: 5000) |
| `CACHE_TTL_SECONDS` | Config | Profile cache duration (default: 86400) |

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
