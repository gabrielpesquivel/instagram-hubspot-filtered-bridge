# Instagram-HubSpot Filtered Bridge

## Project Specification

### Overview

A lightweight bridge service that receives Instagram DMs via webhook, applies filtering rules to identify high-value conversations, and forwards qualifying messages to HubSpot's Conversations Inbox. High-value senders (verified users, accounts with 5,000+ followers) are excluded from automation so they can be handled manually.

---

## Problem Statement

The existing Octopods integration forwards all Instagram DMs to HubSpot without discrimination. This results in:
- High-value conversations (verified accounts, influencers) being handled by automated responses
- Missed opportunities for personalized engagement with important contacts
- No control over which conversations get routed to automation

---

## Goals

1. **Selective Routing**: Only forward DMs from accounts that don't meet high-value criteria
2. **Manual Override for VIPs**: Verified users and accounts with 5,000+ followers bypass automation
3. **Minimal Hosting Costs**: Serverless architecture with generous free tier
4. **Simple Architecture**: HubSpot handles all agent behavior; bridge only filters and forwards

---

## Architecture

```
┌─────────────────┐     Webhook      ┌──────────────────────┐
│   Instagram     │ ───────────────> │   Cloudflare Worker  │
│   (Meta API)    │                  │   (Filter Logic)     │
└─────────────────┘                  └──────────┬───────────┘
                                                │
                                     ┌──────────▼───────────┐
                                     │  Fetch Sender Info   │
                                     │  - followers_count   │
                                     │  - is_verified       │
                                     │  - message_type      │
                                     └──────────┬───────────┘
                                                │
                              ┌─────────────────┴─────────────────┐
                              │                                   │
                    ┌─────────▼─────────┐             ┌───────────▼───────────┐
                    │  SKIP (Manual)    │             │  FORWARD TO HUBSPOT   │
                    │  - Verified       │             │  (Text messages only) │
                    │  - 5000+ followers│             └───────────┬───────────┘
                    │  - Media messages │                         │
                    └───────────────────┘             ┌───────────▼───────────┐
                                                      │   HubSpot Custom      │
                                                      │   Channel API         │
                                                      └───────────────────────┘
```

---

## Technical Components

### 1. Instagram Webhook Receiver

**Platform**: Meta Graph API (Instagram Messaging)

**Webhook Events**:
- `messages` - New incoming DM
- `messaging_postbacks` - Quick reply responses

**Webhook Payload** (simplified):
```json
{
  "object": "instagram",
  "entry": [{
    "id": "<PAGE_ID>",
    "time": 1234567890,
    "messaging": [{
      "sender": { "id": "<IGSID>" },
      "recipient": { "id": "<PAGE_ID>" },
      "timestamp": 1234567890,
      "message": {
        "mid": "<MESSAGE_ID>",
        "text": "Hello!"
      }
    }]
  }]
}
```

**Required Permissions**:
- `instagram_manage_messages` - Read and respond to DMs
- `instagram_basic` - Read profile info (followers, verified status)
- `pages_messaging` - For the connected Facebook Page

### 2. Sender Filtering Logic

**API Endpoint**: `GET /{ig-user-id}?fields=follower_count,is_verified,username`

**Filter Criteria** (configurable via environment variables):

| Condition | Action | Rationale |
|-----------|--------|-----------|
| `is_verified = true` | Skip (manual) | Blue checkmark = notable person |
| `follower_count >= 5000` | Skip (manual) | Potential influencer/partner |
| Message contains media (image/video/audio) | Skip (manual) | Special process for media messages |
| Text message from standard account | Forward to HubSpot | Standard customer inquiry |

**Message Type Handling**:
- **Text messages**: Forward message content to HubSpot
- **Image/Video/Audio**: Do NOT forward. Skip entirely (no response = human handles manually in Instagram)
- **Stickers/Reactions**: Ignore (don't forward)

**Edge Cases**:
- **Unable to fetch profile**: Forward to HubSpot (fail-open) - can be adjusted later
- **Private account**: Limited data available; forward to HubSpot
- **Business/Creator account**: Full data available

### 3. HubSpot Integration

**API**: HubSpot Custom Channels API (GA as of April 2025)

**Endpoint**: `POST /conversations/v3/custom-channels/{channelId}/messages`

**Payload**:
```json
{
  "messageDirection": "INCOMING",
  "text": "Message content here",
  "richText": "<p>Message content here</p>",
  "integrationThreadId": "<INSTAGRAM_CONVERSATION_ID>",
  "channelAccountId": "<IG_PAGE_ID>",
  "senders": [{
    "deliveryIdentifier": {
      "type": "HS_CUSTOM_CHANNEL_ACCOUNT",
      "value": "<SENDER_IGSID>"
    },
    "name": "@username"
  }]
}
```

**Reply Handling** (outbound):
- HubSpot webhook notifies bridge of outbound messages
- Bridge calls Instagram Send API to deliver reply

### 4. Hosting: Cloudflare Workers

**Why Cloudflare Workers**:
- **Free Tier**: 100,000 requests/day (more than sufficient)
- **No Cold Starts**: Sub-millisecond startup via V8 isolates
- **Global Edge**: 300+ locations worldwide
- **Simple Deployment**: `wrangler deploy`
- **Built-in KV**: For caching sender profiles

**Limitations**:
- 10ms CPU time limit on free tier (sufficient for API proxying)
- 1MB code size limit per script
- No native Node.js modules (but not needed for this use case)

**Alternative** (if needed): AWS Lambda via API Gateway
- 1M free requests/month
- More complex setup, cold starts

---

## Data Flow

### Incoming Message (Instagram -> HubSpot)

```
1. Instagram sends webhook to Worker
2. Worker extracts sender IGSID and message type
3. Worker checks KV cache for sender profile
4. If not cached:
   a. Call Instagram Graph API for follower_count, is_verified
   b. Cache result in KV (TTL: 24 hours)
5. Apply filter rules:
   - If verified OR followers >= 5000: Log and exit (no forward)
   - If message contains media (image/video/audio): Log and exit (manual handling)
   - Otherwise: Continue
6. Transform text message to HubSpot format
7. POST to HubSpot Custom Channel API
8. Return 200 OK to Instagram
```

### Outgoing Reply (HubSpot -> Instagram)

```
1. HubSpot sends webhook to Worker (reply event)
2. Worker extracts recipient IGSID and message
3. Worker calls Instagram Send API
4. Return 200 OK to HubSpot
```

---

## Configuration

### Environment Variables

```bash
# Instagram / Meta
META_APP_SECRET=xxx                    # For webhook signature verification
META_PAGE_ACCESS_TOKEN=xxx             # Long-lived page token
INSTAGRAM_PAGE_ID=xxx                  # Connected IG page ID
WEBHOOK_VERIFY_TOKEN=xxx               # Custom token for webhook setup

# HubSpot
HUBSPOT_ACCESS_TOKEN=xxx               # Private app token
HUBSPOT_CUSTOM_CHANNEL_ID=xxx          # Channel ID from HubSpot setup

# Filtering
FILTER_VERIFIED=true                   # Skip verified accounts
FILTER_MIN_FOLLOWERS=5000              # Minimum followers to skip

# Optional
LOG_LEVEL=info                         # debug, info, warn, error
CACHE_TTL_SECONDS=86400                # Profile cache TTL (24h default)
```

### Cloudflare KV Namespace

Used for caching Instagram user profiles to reduce API calls:

```
Key: ig_profile:{IGSID}
Value: { "follower_count": 1234, "is_verified": false, "username": "example", "cached_at": 1234567890 }
TTL: 24 hours
```

---

## API Rate Limits

| Service | Limit | Strategy |
|---------|-------|----------|
| Instagram Graph API | 200 calls/hour per IG account | Cache profiles in KV |
| Instagram Send API | 200 DMs/hour | Queue if hitting limits |
| HubSpot API | 100 requests/10 seconds | Unlikely to hit with DM volume |
| Cloudflare Workers (Free) | 100K requests/day | Generous for DM volume |

---

## Security Considerations

1. **Webhook Signature Verification**: Validate `X-Hub-Signature-256` header using `META_APP_SECRET`
2. **Token Storage**: All tokens stored as Cloudflare Worker secrets (encrypted at rest)
3. **HTTPS Only**: Cloudflare Workers enforce HTTPS by default
4. **No PII Logging**: Only log IGSID hashes and filter decisions, never message content
5. **Fail-Open**: If profile fetch fails, forward to HubSpot (don't block messages)

---

## Setup Steps

### Phase 1: Meta App Setup
1. Create Meta Developer App (or use existing)
2. Add Instagram Messaging product
3. Configure webhook subscription for `messages` field
4. Generate long-lived Page Access Token
5. Submit for App Review (required permissions)

### Phase 2: HubSpot Setup
1. Create Private App with `conversations.read` and `conversations.write` scopes
2. Create Custom Channel in Conversations settings
3. Note the Channel ID
4. Configure webhook for outbound message events

### Phase 3: Cloudflare Worker Deployment
1. Install Wrangler CLI
2. Create Worker and KV namespace
3. Set secrets via `wrangler secret put`
4. Deploy with `wrangler deploy`
5. Update Meta and HubSpot webhooks with Worker URL

### Phase 4: Testing
1. Test with Meta Test Users first (webhook only fires for testers until live)
2. Verify filter logic with known accounts
3. Confirm HubSpot thread creation
4. Test reply flow back to Instagram

---

## Project Structure

```
instagram-hubspot-filtered-bridge/
├── src/
│   ├── index.ts              # Worker entry point
│   ├── handlers/
│   │   ├── instagram.ts      # Instagram webhook handler
│   │   └── hubspot.ts        # HubSpot webhook handler
│   ├── services/
│   │   ├── instagram-api.ts  # Instagram Graph API client
│   │   ├── hubspot-api.ts    # HubSpot Conversations API client
│   │   └── filter.ts         # Filtering logic
│   ├── utils/
│   │   ├── crypto.ts         # Signature verification
│   │   └── logger.ts         # Structured logging
│   └── types.ts              # TypeScript interfaces
├── wrangler.toml             # Cloudflare Worker config
├── package.json
├── tsconfig.json
└── README.md
```

---

## Estimated Costs

| Component | Free Tier | Paid (if exceeded) |
|-----------|-----------|-------------------|
| Cloudflare Workers | 100K req/day | $5/mo for 10M req |
| Cloudflare KV | 100K reads/day, 1K writes/day | $0.50/M reads |
| Meta API | Free | Free |
| HubSpot API | Included with subscription | Included |

**Expected Monthly Cost**: $0 (for typical DM volumes)

---

## Future Enhancements (Out of Scope)

- [ ] Dashboard for viewing filtered vs forwarded stats
- [ ] Additional filter criteria (account age, engagement rate)
- [ ] Allowlist/blocklist for specific accounts
- [ ] Slack notifications for high-value conversations
- [ ] Multi-account support

---

## References

- [Instagram Messaging Webhooks Guide](https://innocentanyaele.medium.com/setup-meta-webhooks-for-instagram-messaging-and-respond-to-message-4575bc95c7a2)
- [HubSpot Conversations Inbox and Messages APIs](https://developers.hubspot.com/docs/guides/api/conversations/inbox-and-messages)
- [HubSpot Custom Channels API](https://community.n8n.io/t/add-support-for-hubspot-custom-channels-api-in-n8n/143508)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers Pricing](https://www.cloudflare.com/plans/developer-platform/)
- [Instagram Graph API Guide 2026](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/)
- [Instagram Rate Limits](https://www.getphyllo.com/post/how-to-use-instagram-api-to-get-followers)

---

## Decisions

| Question | Decision |
|----------|----------|
| Profile access for personal accounts | Fail-open: if we can't fetch data, forward to HubSpot anyway |
| Historical conversation sync | New messages only, no historical sync |
| Media messages (image/video/audio) | Don't forward - skip entirely so team handles manually in Instagram |
| HubSpot ticket creation | Use HubSpot's default behavior (configurable in inbox settings) |

## Open Questions

None - all questions resolved.

---

*Document Version: 1.1*
*Created: 2026-02-10*
*Updated: 2026-02-10 - Added media handling rules, clarified decisions*
