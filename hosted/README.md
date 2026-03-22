# Farmer Hosted — Cloudflare Workers

Hosted deployment of the Farmer permission dashboard on Cloudflare Workers + Durable Objects.

## Architecture

- **Worker** (`src/index.js`) — thin routing layer: JWT validation, CORS, Durable Object dispatch
- **SprintSession DO** (`src/sprint-session.js`) — one Durable Object per sprint token with WebSocket hibernation, SQLite state, alarm-based permission timeouts
- **JWT auth** (`src/jwt.js`) — ES256 via WebCrypto, zero dependencies
- **Dashboard** (`src/dashboard.js`) — inline HTML served by the Worker (no build step, no static assets)

### URL Routing

| Endpoint                      | Method        | Description                 |
| ----------------------------- | ------------- | --------------------------- |
| `/<token>`                    | GET           | Serve dashboard HTML        |
| `/<token>/ws`                 | GET (Upgrade) | WebSocket connection to DO  |
| `/<token>/hooks/permission`   | POST          | Permission request from CLI |
| `/<token>/hooks/activity`     | POST          | Activity event from CLI     |
| `/<token>/hooks/notification` | POST          | Notification from CLI       |
| `/<token>/hooks/lifecycle`    | POST          | Session start/end from CLI  |
| `/<token>/api/state`          | GET           | Full state snapshot         |
| `/<token>/api/decide`         | POST          | Approve/deny permission     |
| `/health`                     | GET           | Health check                |

### WebSocket Hibernation

The DO uses the Hibernatable WebSocket API so it can sleep while dashboard clients stay connected. `setWebSocketAutoResponse()` handles keepalive pings without waking the DO. This keeps duration charges near zero during idle periods.

### Cost

~$5-6/month for 10K sprints on the Workers Paid plan ($5 base). Hibernation keeps DO duration well under the 400K GB-s included allowance.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers Paid plan ($5/month)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v4+
- DNS for `grainulation.com` managed by Cloudflare (for custom domain)

## Setup

```bash
cd hosted
npm install
```

### Configure JWT (optional)

Without JWT configured, the URL token acts as a shared secret (anyone with the link has admin access). For production, set up ES256 JWT:

```bash
# Generate a key pair (Node.js 18+)
node -e "
import { generateKeyPair } from './src/jwt.js';
const kp = await generateKeyPair();
console.log('Public (set as secret):', JSON.stringify(kp.publicKeyJWK));
console.log('Private (keep in CLI):', JSON.stringify(kp.privateKeyJWK));
"

# Set the public key as a Worker secret
wrangler secret put JWT_PUBLIC_KEY
# Paste the JSON public key when prompted
```

## Development

```bash
npm run dev
# Opens local dev server at http://localhost:8787
# Test: http://localhost:8787/test-token
```

## Deploy

```bash
npm run deploy
```

This deploys to `farmer.grainulation.com` via the route configured in `wrangler.toml`.

### Custom Domain

The `wrangler.toml` routes to `farmer.grainulation.com/*`. To use a different domain:

1. Edit the `[routes]` section in `wrangler.toml`
2. Ensure the zone is managed by Cloudflare
3. Run `npm run deploy`

### Verify

```bash
curl https://farmer.grainulation.com/health
# → ok
```

## Connecting Claude Code

Point the Claude Code hooks at the hosted farmer:

```bash
# In your project's .claude/settings.json or hooks config:
{
  "hooks": {
    "PreToolUse": [{
      "type": "url",
      "url": "https://farmer.grainulation.com/<your-token>/hooks/permission"
    }],
    "PostToolUse": [{
      "type": "url",
      "url": "https://farmer.grainulation.com/<your-token>/hooks/activity"
    }],
    "Notification": [{
      "type": "url",
      "url": "https://farmer.grainulation.com/<your-token>/hooks/notification"
    }]
  }
}
```

Then open `https://farmer.grainulation.com/<your-token>` on your phone to see the dashboard.

## Logs

```bash
npm run tail
# Streams real-time logs from the deployed Worker
```
