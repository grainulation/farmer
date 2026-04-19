<p align="center">
  <img src="site/wordmark.svg" alt="Farmer" width="400">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@grainulation/farmer"><img src="https://img.shields.io/npm/v/@grainulation/farmer?label=%40grainulation%2Ffarmer" alt="npm version"></a> <a href="https://www.npmjs.com/package/@grainulation/farmer"><img src="https://img.shields.io/npm/dm/@grainulation/farmer" alt="npm downloads"></a> <a href="https://github.com/grainulation/farmer/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a> <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@grainulation/farmer" alt="node"></a> <a href="https://github.com/grainulation/farmer/actions"><img src="https://github.com/grainulation/farmer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://deepwiki.com/grainulation/farmer"><img src="https://deepwiki.com/badge.svg" alt="Explore on DeepWiki"></a>
</p>

<p align="center"><strong>Approve AI agent tool calls from anywhere.</strong></p>

Farmer sits between your AI coding agent and your terminal, giving you a visual dashboard to approve, deny, or respond to tool calls in real time. Desktop and mobile.

## Install

```bash
npm install -g @grainulation/farmer
```

## Quick start

```bash
# 1. Install hooks (once)
farmer connect --global   # all projects, or:
farmer connect            # current project only

# 2. Start the dashboard
farmer start

# 3. Open the token URL printed to the terminal

# 4. Start claude in any project -- hooks route automatically
```

## Features

- **Desktop + mobile dashboard** -- session sidebar, permission cards with syntax-highlighted code, activity feed, mobile swipe card view
- **Agent-agnostic hook protocol** -- Claude Code adapter ships first; write your own for other agents
- **Multi-session** -- manage multiple AI sessions from one dashboard
- **Multi-user roles** -- admin and viewer tokens with separate permissions; viewers see read-only cards with "Waiting for admin" labels, admin controls hidden
- **Trust tiers** -- paranoid (approve everything, overrides session-level rules), standard (auto-approve reads), autonomous (auto-approve most)
- **AskUserQuestion** -- deny-to-respond pattern lets you answer agent questions from the dashboard
- **Security** -- three-token auth (admin + viewer + hook), HMAC-signed invite links with expiry, CSRF protection, CSP headers, opportunistic Bearer auth on `/hooks/*` (see below), audit logging
- **Data persistence** -- activity and messages survive server restarts
- **Stale server guard** -- auto-approves when no dashboard is connected (prevents CLI blocking)

## CLI

```bash
farmer start [--port 9090] [--token <secret>] [--viewer-token <secret>] [--trust-proxy] [--data-dir <path>]
farmer stop
farmer status
```

Tokens are persisted in a JSON token file (`.farmer-token` in the data directory). The file stores three tokens:

- `admin` -- full dashboard access
- `viewer` -- read-only dashboard access
- `hook` -- narrow-scope token for `/hooks/*` Bearer auth; never grants dashboard access

The file is generated automatically on first startup (mode `0600`) and is backwards compatible with the legacy plain-text format. When upgrading from a pre-bs-19 farmer, a fresh `hook` token is generated and appended on first boot.

## Hook protocol

Farmer exposes the following hook endpoints. All accept POST with JSON body, localhost only:

| Endpoint               | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `/hooks/permission`    | Tool permission requests (blocking -- waits for approve/deny) |
| `/hooks/activity`      | Tool completion events (non-blocking)                         |
| `/hooks/notification`  | Messages, questions, agent events (non-blocking)              |
| `/hooks/lifecycle`     | Session start/end events                                      |
| `/hooks/stop`          | Graceful shutdown signal                                      |
| `/hooks/sprint-status` | Sprint state push from grainulator notifier                   |
| `/hooks/harvest`       | Harvest analytics events                                      |

### Hook authentication (opportunistic Bearer)

On a shared host (Citrix / multi-user Linux), anything on `127.0.0.1` is reachable by other local users. Without auth, any local process could forge sprint-status POSTs and pollute another user's dashboard. Farmer uses an **opportunistic Bearer auth** scheme to fix this without breaking pre-upgrade users:

- If `.farmer-token` contains a `hook` field at server start, every `/hooks/*` POST MUST include `Authorization: Bearer <hookToken>`. Missing or wrong token => `401 {"error":"unauthorized"}`.
- If the `hook` field is absent (pre-bs-19 file format), farmer logs a one-time stderr warning (`hook auth disabled — create .farmer-token to enable ...`) and accepts loopback POSTs for backward compat.
- The admin/viewer tokens are intentionally NOT accepted here; a leaked admin token cannot be used to spam `/hooks/*`, and a leaked hook token cannot log into the dashboard.

Local hook scripts (e.g. grainulator's `sprint-status-notifier.cjs`) read the `hook` token from the farmer data dir (`FARMER_DATA_DIR` env var or `~/.farmer`) and attach the Bearer header automatically. Override with the `FARMER_TOKEN` env var for tests or CI.

## Writing an adapter

To support a new AI agent, extend `BaseAdapter` in `lib/adapters/base.js`:

```js
import { BaseAdapter } from "@grainulation/farmer/lib/adapters/base.js";

class MyAgentAdapter extends BaseAdapter {
  get name() {
    return "My Agent";
  }
  parseRequest(body) {
    /* ... */
  }
  formatResponse(decision, context) {
    /* ... */
  }
  getToolName(body) {
    /* ... */
  }
  isQuestion(body) {
    /* ... */
  }
  parseNotification(body) {
    /* ... */
  }
}
```

## Architecture

```
bin/farmer.js          CLI entry point (start/stop/status)
lib/server.js          Core HTTP + SSE server
lib/adapters/          Agent adapter interface + Claude Code adapter
lib/persistence.js     State persistence (atomic write, debounced)
lib/connect.js         One-step hook installation and settings.json management
lib/security.js        Token auth, CSRF, CSP, PID lock, audit log
public/index.html      Dashboard (inline JS, no build step)
```

## Zero third-party dependencies

Farmer has zero third-party runtime dependencies — depends only on `@grainulation/barn` (internal ecosystem utilities). SSE for real-time streaming, polling as fallback. Everything else is Node built-ins.

## Part of the grainulation ecosystem

| Tool                                                         | Role                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| [wheat](https://github.com/grainulation/wheat)               | Research engine -- grow structured evidence                 |
| **farmer**                                                   | Permission dashboard -- approve AI actions in real time     |
| [barn](https://github.com/grainulation/barn)                 | Shared tools -- templates, validators, sprint detection     |
| [mill](https://github.com/grainulation/mill)                 | Format conversion -- export to PDF, CSV, slides, 26 formats |
| [silo](https://github.com/grainulation/silo)                 | Knowledge storage -- reusable claim libraries and packs     |
| [harvest](https://github.com/grainulation/harvest)           | Analytics -- cross-sprint patterns and prediction scoring   |
| [orchard](https://github.com/grainulation/orchard)           | Orchestration -- multi-sprint coordination and dependencies |
| [grainulation](https://github.com/grainulation/grainulation) | Unified CLI -- single entry point to the ecosystem          |

## Releases

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

MIT
