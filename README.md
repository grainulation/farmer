# @grainulator/farmer

Desktop-first permission dashboard for AI coding agents.

Farmer sits between your AI coding agent (Claude Code, etc.) and your terminal, giving you a visual dashboard to approve, deny, or respond to tool calls in real time.

## Features

- **Desktop-first split-pane UI** — session sidebar, permission cards, activity feed
- **Agent-agnostic hook protocol** — Claude Code adapter ships first; write your own for other agents
- **Zero npm dependencies** — Node built-in modules only
- **Security** — token auth, CSRF protection, CSP headers, audit logging
- **Multi-session** — manage multiple AI sessions from one dashboard
- **Trust tiers** — paranoid (approve everything), standard (auto-approve reads), autonomous (auto-approve most)
- **PID lock** — prevents duplicate server instances
- **Stale server guard** — auto-approves when no dashboard is connected (prevents CLI blocking)
- **AskUserQuestion** — deny-to-respond pattern lets you answer agent questions from the dashboard
- **Data persistence** — activity and messages survive server restarts

## Quick Start

```bash
# Start the dashboard
node bin/farmer.js start --port 9090

# The token URL is printed to the terminal
# Open it in your browser

# Configure Claude Code hooks to point at Farmer:
# http://localhost:9090/hooks/permission
# http://localhost:9090/hooks/activity
# http://localhost:9090/hooks/notification
# http://localhost:9090/hooks/lifecycle
```

## CLI

```bash
farmer start [--port 9090] [--token <secret>] [--trust-proxy] [--data-dir <path>]
farmer stop
farmer status
```

## Hook Protocol

Farmer exposes four hook endpoints. All accept POST with JSON body, localhost only:

| Endpoint | Purpose |
|---|---|
| `/hooks/permission` | Tool permission requests (blocking — waits for approve/deny) |
| `/hooks/activity` | Tool completion events (non-blocking) |
| `/hooks/notification` | Messages, questions, agent events (non-blocking) |
| `/hooks/lifecycle` | Session start/end events |

See `docs/hook-protocol.md` for the full specification.

## Writing an Adapter

To support a new AI agent, extend `BaseAdapter` in `lib/adapters/base.js`:

```js
import { BaseAdapter } from '@grainulator/farmer/lib/adapters/base.js';

class MyAgentAdapter extends BaseAdapter {
  get name() { return 'My Agent'; }
  parseRequest(body) { /* ... */ }
  formatResponse(decision, context) { /* ... */ }
  getToolName(body) { /* ... */ }
  isQuestion(body) { /* ... */ }
  parseNotification(body) { /* ... */ }
}
```

See `docs/adapter-guide.md` for details.

## Architecture

```
bin/farmer.js          CLI entry point (start/stop/status)
lib/server.js          Core HTTP + WebSocket server
lib/adapters/base.js   Agent adapter interface
lib/adapters/claude-code.js  Claude Code adapter
lib/persistence.js     State persistence (atomic write, debounced)
lib/security.js        Token auth, CSRF, CSP, PID lock, audit log
public/index.html      Desktop-first dashboard (inline JS)
public/mobile.css      Mobile responsive overrides
```

## License

MIT
