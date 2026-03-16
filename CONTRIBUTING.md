# Contributing to Farmer

Thanks for considering contributing. Farmer is the session management and permissions server for the grainulation ecosystem -- the control center that connects all tools.

## Quick setup

```bash
git clone https://github.com/grainulation/farmer.git
cd farmer
npm install
node bin/farmer.js --help
```

Farmer has one dependency: `ws` (WebSocket library). This is the only npm dependency in the entire grainulation ecosystem.

## How to contribute

### Report a bug
Open an issue with:
- What you expected
- What happened instead
- Your Node version (`node --version`)
- Steps to reproduce

### Suggest a feature
Open an issue describing the use case, not just the solution. "I need X because Y" is more useful than "add X."

### Submit a PR
1. Fork the repo
2. Create a branch (`git checkout -b fix/description`)
3. Make your changes
4. Run the tests: `node --test test/`
5. Commit with a clear message
6. Open a PR

### Important invariants
Farmer has critical invariants that must not regress:
- Server split architecture (desktop + mobile)
- WebSocket for real-time communication
- SSE for event streams
- Auth and token persistence across restarts
- Audit logging for all session activity

## Architecture

```
bin/farmer.js             CLI entrypoint -- starts the server
lib/index.js              Core library -- session and permission management
lib/server.js             HTTP + WebSocket server (uses ws)
lib/security.js           Auth, token generation, and validation
lib/persistence.js        Token and session state persistence
lib/adapters/             Tool adapters for ecosystem integration
lib/qrcodegen-nayuki.js   QR code generation (vendored, zero deps)
public/                   Web UI -- three-column (sessions + permissions + detail)
site/                     Public website (farmer.grainulation.com)
test/                     Node built-in test runner tests
```

The key architectural principle: **farmer is the reference implementation for the grainulation server pattern.** It uses WebSocket (via ws) for real-time communication. All other tools use SSE + POST to stay zero-dep.

## Code style

- One dependency: `ws`. Nothing else. Use Node built-ins for everything.
- No transpilation. Ship what you write.
- ESM imports (`import`/`export`). Node 18+ required.
- Keep functions small. If a function needs a scroll, split it.
- No emojis in code, CLI output, or UI.

## Testing

```bash
node --test test/
```

Tests use Node's built-in test runner. No test framework dependencies.

## Commit messages

Follow the existing pattern:
```
farmer: <what changed>
```

Examples:
```
farmer: add session expiry notification
farmer: fix token persistence across restart
farmer: update adapter for wheat hook registration
```

## License

MIT. See LICENSE for details.
