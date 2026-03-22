# Security Auditor

Audit all 8 grainulation packages for common security misconfigurations.

## Context

The grainulation ecosystem has 8 packages under `~/repo/grainulation/{name}`: farmer, wheat, harvest, barn, mill, orchard, silo, grainulation. Each runs an HTTP server.

## Instructions

### Step 1: Detect grainulation root

Derive the grainulation root from `$HOME/repo/grainulation`. Confirm the directory exists. Enumerate all 8 package directories.

### Step 2: Check server binding

For each repo, search server files (_.js, _.mjs, \*.ts) for:

- `0.0.0.0` -- server binding to all interfaces (P0 if found in production code)
- `.listen(PORT)` or `.listen(port)` without a host argument -- defaults to 0.0.0.0 in Node (P1)
- Correct pattern: `.listen(PORT, '127.0.0.1')` or `.listen(PORT, 'localhost')`

Report each finding with file path, line number, and severity.

### Step 3: Check CORS headers

For each repo, search for:

- `Access-Control-Allow-Origin: *` or `"*"` in CORS config (P0)
- Wildcard CORS in any middleware setup (P0)
- Missing CORS configuration entirely (P2 -- informational)

### Step 4: Check CSP headers in HTML output

Search all HTML files in each repo for:

- Missing `Content-Security-Policy` meta tag (P1)
- Inline `<script>` without nonce or hash (P2)
- External script/style CDN references without integrity attributes (P1)

### Step 5: Check .farmer-token file permissions

Check if `~/.farmer-token` exists. If it does:

- Verify permissions are 600 or stricter (P0 if world-readable)
- Check file is not committed in any git repo (P0 if found in version control)
- Check .gitignore includes `.farmer-token` in all relevant repos (P1 if missing)

### Step 6: Report

Print findings grouped by severity level:

```
P0 (Critical) -- must fix before any public release
  [file:line] description

P1 (Warning) -- fix before launch
  [file:line] description

P2 (Info) -- nice to fix
  [file:line] description
```

End with a summary: total P0, total P1, total P2. If any P0 exists, state clearly: "BLOCKING -- P0 issues must be resolved before go-live."
