# Changelog

## 1.1.5 — 2026-04-21

### Fixed

- **First-install silent 401 on every hook POST.** `lib/server.js` enforces `Authorization: Bearer <hook-token>` on `/hooks/*` when `.farmer-token` contains a `hook` field (introduced in the bs-19 security hardening). `lib/connect.js` wrote hook commands into `~/.claude/settings.json` with no `Authorization` header. `cat | curl -s ... 2>/dev/null || true` swallowed the 401, so every fresh install that landed in enforcement mode had a silently empty dashboard. Root cause: two sides of the same binary shipped asymmetric auth contracts; no end-to-end test covered the connect↔server seam.
- Rewrote `lib/connect.js` to emit a hook command shape that authenticates correctly: `-H "@<absolute-path>/hook-auth.header"`. The server writes the header file (mode 0600) on startup and on token rotation via an atomic tmp+rename write. Token never appears on argv (`ps`-safe). Shell tilde (`~`) is never emitted — we use the server's real `dataDir` (via the new `GET /status`) because `@~/path` does not expand in bash/zsh/sh/dash. Stderr is no longer redirected to `/dev/null` and `|| true` is removed; curl's `--fail-with-body` now surfaces 401s to Claude Code's hook log.

### Added

- `GET /status` — unauth, loopback-only JSON endpoint exposing hook counters, `hookAuthMode`, `dataDir`, and `hookAuthPath`. Used by `farmer connect` to discover the running server's real data dir (closing the connect-CWD vs start-CWD divergence) and by `farmer status` to render visible diagnostics.
- `.farmer-broken-installs.jsonl` — appended on every `/hooks/*` 401. Lets `farmer status` warn users when their dashboard is silently empty.
- Tamper-safe auto-migration — 1.1.4 curl commands (no Bearer) rewrite in place on next `farmer connect`. Detection uses our sentinel (`# @farmer-managed`) OR the exact 1.1.4 prefix; hand-edits are preserved.
- `test/connect-server-seam.test.js` — end-to-end test exercising both opportunistic and enforced modes. Spawns farmer on an ephemeral port, calls `connect()` as a library, invokes the emitted curl via `sh -c`, asserts `hooks.accepted > 0` and `hooks.rejected401 === 0`. Also regression-guards the tilde-in-path bug.

### Changed

- `package.json` — declared `"os": ["darwin", "linux"]`. Native Windows is unsupported (the emitted hook string is POSIX shell); WSL works. A 1.2.0 followup will introduce a cross-platform HTTP-hook shape using Claude Code's native `type: "http"` hook blocks, eliminating the curl + shell-quoting class entirely.

## 1.1.3 -- 2026-04-18

### Added

- Session-aware feedback consumption and defensive type coercion so feedback scoping doesn't leak across sessions

### Changed

- Refactored farmer CLI to use `@grainulation/barn/cli` vlog

### Fixed

- Feedback dropdown no longer collapses the popover when selected

### Docs

- Added SECURITY.md
- README honesty pass (production polish), added `publishConfig`, expanded `.gitignore` to cover `.env`

## 1.1.2 -- 2026-04-11

### Added

- Sprint-status endpoint plus session-targeted feedback (allows directing feedback to a specific session)

### Fixed

- DeepWiki docs link (was broken)
- Wheat chip label shortened from "evidence compiler" to "compiler"
- Updated wheat ecosystem chip and added tagline to footer

### Changed

- Concrete zero-dep messaging in landing copy; softened Cloudflare reference

### Removed

- Unused imports and dead code flagged by eslint audit
- `publish.yml` workflow — publishing is now manual (token-create-publish-delete)

### Internal

- Trimmed npm tarball — removed local-only files and `site/` (deployed separately via GitHub Pages)
- CI skips publish when the version already exists on npm

## 1.1.0 -- 2026-04-11

Security hardening release.

### Security

- CSP meta tag added (Rx-6)
- Farmer tunnel flipped to opt-in by default (Rx-9)

### Internal

- Missing runtime files added to `.gitignore` (Rx-10)

## 1.0.7 -- 2026-04-09

### Security

- Bearer token auth added to hook endpoints (P0 blind-spot fix)
- `.farmer-token` and runtime files added to `.gitignore` (Rx-003)

### Fixed

- Node 18 → 20 across landing page, `bin`, CI matrix, and docs

### Docs

- npm badge now shows the full scoped package name

## 1.0.6 -- 2026-03-23

### Fixed

- Session-rule toggle — label + checkbox double-click bug caused unintended re-toggles

## 1.0.5 -- 2026-03-22

### Added

- Hosted farmer on Cloudflare Workers + Durable Objects (optional hosted variant)

### Changed

- Aligned `engines.node` to `>=20`; LICENSE copyright to "grainulation contributors"
- DeepWiki badge, static license badge, and `type: module` consistency pass

### Fixed

- Approve/deny buttons were unclickable because the swipe overlay was blocking clicks

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
