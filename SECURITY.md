# Security Policy

## Supported versions

Only the latest published minor version of each package receives security
fixes. Older versions may be patched at maintainer discretion.

| Version | Supported |
| ------- | --------- |
| latest  | ✅         |
| older   | ❌         |

## Reporting a vulnerability

If you believe you have found a security vulnerability in this package,
please report it privately so we can fix it before it is disclosed.

Preferred: open a **Private vulnerability report** via GitHub Security
Advisories on this repository (`Security` tab → `Report a vulnerability`).
GitHub handles coordination and gives us a private space to discuss a fix.

Alternative: email `security@grainulator.app` with a description of the
issue, reproduction steps, and any relevant logs. Use the PGP key on
the website to encrypt sensitive details.

## Disclosure process

1. You report the issue privately.
2. We acknowledge receipt within **3 business days**.
3. We investigate, confirm (or refute) the issue, and develop a fix.
4. We coordinate a release date with you. Our default is a **90-day**
   disclosure window from initial report; we may ship a fix earlier
   and request that you delay public disclosure until users have had
   reasonable time to upgrade.
5. On the agreed disclosure date we publish a security advisory with
   credit to the reporter (unless you prefer to remain anonymous).

## Scope

In scope:

- Remote code execution via crafted input to any CLI, MCP tool, or
  exported library function.
- Path traversal, command injection, or SSRF in features that read
  files, spawn processes, or fetch URLs.
- Leakage of user secrets (tokens, environment variables) written to
  logs, outputs, or disk caches.
- Anything that would let a malicious claim / sprint / configuration
  compromise the developer machine running the tool.

Out of scope:

- Issues that require the attacker to already have local filesystem
  access or to have modified package files directly.
- Denial of service via obviously expensive inputs (please do file
  performance issues on the public tracker).
- Missing security headers on local-only HTTP servers that are
  intended for a single-user loopback workflow.

## Hook authentication model (1.1.5+)

The `/hooks/*` endpoints use an opportunistic Bearer auth scheme:

- If `.farmer-token` (in the server's `dataDir`) contains a `hook` field
  at startup, every `/hooks/*` POST MUST carry `Authorization: Bearer
  <hookToken>` or receive `401 unauthorized`.
- If the file has no `hook` field, farmer accepts unauthenticated loopback
  POSTs (for pre-1.1 compat) and logs a one-time stderr warning.

The hook token is written to `<dataDir>/hook-auth.header` (mode 0600) and
referenced by Claude Code hook curls via `-H "@<path>"` so the token never
appears on argv.

### Known limitation — no per-session isolation on loopback (rt005)

An authenticated hook client (any process that can read
`<dataDir>/hook-auth.header` — i.e. the same UID on the host) can POST a
hook with an arbitrary `session_id` and `pid`, and farmer will attribute
the event to that session. The `sourceFingerprint(addr, pid)` check that
previously "bound" a session to a pid is disabled on loopback in 1.1.5
because loopback pids are client-controlled and visible via `ps`,
making the check security theater.

This means: on a multi-user host, a malicious same-UID process with the
hook token can pollute your audit log and dashboard with forged events
attributed to other sessions. Mitigations:

- The hook token file is 0600 by default; set a strict umask and don't
  share your host UID.
- For stronger isolation between Claude Code sessions running as the same
  UID, wait for 1.2.0: farmer will hand out a per-session token at hook
  start, and hook POSTs will need to present the session-specific token
  to be accepted for that session_id.

Report fingerprint-spoof incidents via the process above so we can track
the 1.2.0 migration priority.

## Credit

We credit reporters in release notes and the advisory. Let us know if
you'd prefer to remain anonymous.
