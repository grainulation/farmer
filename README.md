<p align="center">
  <img src="site/wordmark.svg" alt="Farmer" width="400">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@grainulation/farmer"><img src="https://img.shields.io/npm/v/@grainulation/farmer" alt="npm version"></a> <a href="https://www.npmjs.com/package/@grainulation/farmer"><img src="https://img.shields.io/npm/dm/@grainulation/farmer" alt="npm downloads"></a> <a href="https://github.com/grainulation/farmer/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@grainulation/farmer" alt="license"></a> <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@grainulation/farmer" alt="node"></a> <a href="https://github.com/grainulation/farmer/actions"><img src="https://github.com/grainulation/farmer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center"><strong>Approve AI agent tool calls from anywhere.</strong></p>

Farmer sits between your AI coding agent and your terminal, giving you a visual dashboard to approve, deny, or respond to tool calls in real time. Desktop and mobile.

## Install

```bash
npm install -g @grainulation/farmer
```

## Quick start

```bash
# Start the dashboard
farmer start --port 9090

# The token URL is printed to the terminal -- open it in your browser
# Configure Claude Code hooks to point at Farmer:
farmer start  # prints hook configuration instructions
```

## Features

- **Desktop + mobile dashboard** -- session sidebar, permission cards, activity feed
- **Agent-agnostic hook protocol** -- Claude Code adapter ships first; write your own for other agents
- **Multi-session** -- manage multiple AI sessions from one dashboard
- **Trust tiers** -- paranoid (approve everything), standard (auto-approve reads), autonomous (auto-approve most)
- **AskUserQuestion** -- deny-to-respond pattern lets you answer agent questions from the dashboard
- **Security** -- token auth, CSRF protection, CSP headers, audit logging
- **Data persistence** -- activity and messages survive server restarts
- **Stale server guard** -- auto-approves when no dashboard is connected (prevents CLI blocking)

## CLI

```bash
farmer start [--port 9090] [--token <secret>] [--trust-proxy] [--data-dir <path>]
farmer stop
farmer status
```

## Hook protocol

Farmer exposes four hook endpoints. All accept POST with JSON body, localhost only:

| Endpoint | Purpose |
|---|---|
| `/hooks/permission` | Tool permission requests (blocking -- waits for approve/deny) |
| `/hooks/activity` | Tool completion events (non-blocking) |
| `/hooks/notification` | Messages, questions, agent events (non-blocking) |
| `/hooks/lifecycle` | Session start/end events |

## Writing an adapter

To support a new AI agent, extend `BaseAdapter` in `lib/adapters/base.js`:

```js
import { BaseAdapter } from '@grainulation/farmer/lib/adapters/base.js';

class MyAgentAdapter extends BaseAdapter {
  get name() { return 'My Agent'; }
  parseRequest(body) { /* ... */ }
  formatResponse(decision, context) { /* ... */ }
  getToolName(body) { /* ... */ }
  isQuestion(body) { /* ... */ }
  parseNotification(body) { /* ... */ }
}
```

## Architecture

```
bin/farmer.js          CLI entry point (start/stop/status)
lib/server.js          Core HTTP + WebSocket server
lib/adapters/          Agent adapter interface + Claude Code adapter
lib/persistence.js     State persistence (atomic write, debounced)
lib/security.js        Token auth, CSRF, CSP, PID lock, audit log
public/index.html      Dashboard (inline JS, no build step)
```

## Zero dependencies

One exception: `ws` for WebSocket support. Everything else is Node built-ins.

## Part of the grainulation ecosystem

| Tool | Role |
|------|------|
| [wheat](https://github.com/grainulation/wheat) | Research engine -- grow structured evidence |
| **farmer** | Permission dashboard -- approve AI actions in real time |
| [barn](https://github.com/grainulation/barn) | Shared tools -- templates, validators, sprint detection |
| [mill](https://github.com/grainulation/mill) | Format conversion -- export to PDF, CSV, slides, 24 formats |
| [silo](https://github.com/grainulation/silo) | Knowledge storage -- reusable claim libraries and packs |
| [harvest](https://github.com/grainulation/harvest) | Analytics -- cross-sprint patterns and prediction scoring |
| [orchard](https://github.com/grainulation/orchard) | Orchestration -- multi-sprint coordination and dependencies |
| [grainulation](https://github.com/grainulation/grainulation) | Unified CLI -- single entry point to the ecosystem |

## License

MIT
