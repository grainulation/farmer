# Changelog

## 1.0.4 -- 2026-03-20

Connect command and permission state reliability.

### Added

- farmer connect [--global] command for one-step hook installation
- Startup hint when no hooks detected
- Dynamic favicon with status dot (green=connected, orange=pending with count, red=disconnected)

### Changed

- Login page redesigned with blue theme, favicon, glass effect

### Fixed

- Permission state flicker -- optimistic updates, SSE echo suppression with 5s safety timeout, rollback on POST failure
- Batched rule changes -- addQuickRuleGroup sends single POST, server applies atomically
- Poll overwrite guard -- 3s cooldown after user changes prevents poll from reverting trust/rules
- Selective render on session events -- session_new no longer rebuilds Rules tab
- removeRule() -- was missing optimistic update pattern, now matches toggleRule
- SSE reconnect resets echo suppression counters
- Shutdown reliability -- SSE connections destroyed before server.close(), prevents port hanging
- `farmer stop` waits for exit, force-kills after 3s, cleans stale PID files via forceRelease()
- /connect page tunnel URL -- both admin and viewer URLs now update when tunnel restarts

## 1.0.3 -- 2026-03-19

Multi-user support with role-based access control.

### Added

- Two-token auth: separate admin and viewer roles with independent tokens
- HMAC-signed invite links with configurable expiry for secure onboarding
- Viewer UI: admin controls hidden, VIEWER badge displayed, read-only permission cards, "Waiting for admin" labels on pending decisions
- /connect page restricted to admin only (returns 404 for non-admin sessions)
- Dual QR codes on /connect page: one for admin, one for viewer
- Role field included in SSE init payload and /api/state response
- Mobile swipe card view for permissions with syntax-highlighted code blocks
- Session count badge replaces individual session pills on mobile footer
- Formatted code in permission cards: bash syntax highlighting, diff view, path truncation

### Changed

- Token file migrated from plain text to JSON format (backwards compatible with plain text files)
- Paranoid trust mode now overrides session-level trust rules
- SSE reconnection: any successful poll resets SSE retry state

### Security

- Admin token no longer leaked to viewer HTML payload
- token_rotated broadcast events filtered to admin-only SSE streams

## 1.0.0 -- 2026-03-16

Initial release.

- Mobile-first permission dashboard for AI coding agents
- SSE real-time updates for live session monitoring
- Trust levels: paranoid, standard, autonomous
- Hook protocol: permission, activity, notification, lifecycle
- Agent-agnostic adapter pattern for multi-client support
- Token persistence across server restarts
- Audit logging with structured JSONL output
