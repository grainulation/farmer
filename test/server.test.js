/**
 * Smoke tests for the Farmer HTTP + SSE server.
 *
 * Spawns the real CLI (bin/farmer.js start) against an isolated tempdir so
 * no ~/.farmer state is touched. Each test uses a distinct high port so
 * runs can't collide with anything else on the machine or each other.
 *
 * Covers the minimum "does the server boot and enforce its core invariants"
 * surface: dashboard serves, SSE events stream, auth is enforced,
 * CSRF rejects unsigned POSTs, rate limiting fires when configured, and
 * SIGTERM shuts the process down cleanly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FARMER_BIN = resolve(__dirname, "..", "bin", "farmer.js");

// Each test gets a unique port so restarts don't race on TIME_WAIT.
let nextPort = 9190;
function allocPort() {
  return nextPort++;
}

const ADMIN_TOKEN = "test-admin-token-000000000000000";

/**
 * HTTP helper. Returns { status, headers, body }. Never throws on
 * non-2xx — tests assert on status explicitly.
 */
function httpReq(
  port,
  { method = "GET", path = "/", headers = {}, body = null } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Start a farmer subprocess. Returns once /api/state answers (meaning the
 * server is fully listening). Throws if the process exits early.
 */
async function startFarmer({ port, dataDir, extraArgs = [] }) {
  const child = spawn(
    process.execPath,
    [
      FARMER_BIN,
      "start",
      "--port",
      String(port),
      "--token",
      ADMIN_TOKEN,
      "--data-dir",
      dataDir,
      "--no-open",
      ...extraArgs,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString()));
  child.stderr.on("data", (c) => (stderr += c.toString()));

  let exitedEarly = false;
  child.on("exit", () => {
    exitedEarly = true;
  });

  // Poll /api/state (authenticated) until it answers 200, max ~5s.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (exitedEarly) {
      throw new Error(
        `farmer exited before listening.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    try {
      const res = await httpReq(port, {
        path: `/api/state?token=${ADMIN_TOKEN}`,
      });
      if (res.status === 200) {
        return { child, stdout: () => stdout, stderr: () => stderr };
      }
    } catch {
      // connection refused — keep polling
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(
    `farmer did not become ready within 5s.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Clean SIGTERM + await exit. Used both by the "graceful shutdown" test
 * and by every other test's cleanup path.
 */
function stopFarmer(child, timeoutMs = 3000) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise(child.exitCode);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise(-1);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
    child.kill("SIGTERM");
  });
}

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "farmer-server-test-"));
  return dir;
}

function cleanupDataDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

describe("Farmer HTTP server (smoke)", () => {
  let dataDir;
  let port;
  let farmer;

  before(async () => {
    dataDir = makeDataDir();
    port = allocPort();
    farmer = await startFarmer({ port, dataDir });
  });

  after(async () => {
    if (farmer?.child && farmer.child.exitCode === null) {
      await stopFarmer(farmer.child);
    }
    cleanupDataDir(dataDir);
  });

  it("GET / serves the dashboard HTML to an authenticated user", async () => {
    // Token in URL triggers a 302 that sets the cookie. Follow manually by
    // re-requesting with the cookie, mirroring how a browser would behave.
    const redirect = await httpReq(port, {
      path: `/?token=${ADMIN_TOKEN}`,
    });
    assert.equal(redirect.status, 302, "token URL should set cookie + 302");
    const cookie = (redirect.headers["set-cookie"] || []).find((c) =>
      c.startsWith("farmer_token="),
    );
    assert.ok(cookie, "Set-Cookie should include farmer_token");

    const html = await httpReq(port, {
      path: "/",
      headers: { cookie: cookie.split(";")[0] },
    });
    assert.equal(html.status, 200);
    assert.match(html.headers["content-type"] || "", /text\/html/);
    // App-shell markers from public/index.html.
    assert.match(html.body, /<title>Farmer<\/title>/);
    assert.match(html.body, /<div class="app" id="app">/);
    // {{TOKEN}} must have been substituted.
    assert.ok(
      !html.body.includes("{{TOKEN}}"),
      "TOKEN placeholder should be replaced in dashboard HTML",
    );
  });

  it("GET / without auth returns the login page (not the dashboard)", async () => {
    const res = await httpReq(port, { path: "/" });
    assert.equal(res.status, 200);
    assert.match(res.body, /Enter the dashboard token/);
    // Login page must NOT contain app shell markup.
    assert.ok(!res.body.includes('<div class="app" id="app">'));
  });

  it("GET /api/state without token returns 401", async () => {
    const res = await httpReq(port, { path: "/api/state" });
    assert.equal(res.status, 401);
  });

  it("GET /api/state with admin token returns the expected JSON shape", async () => {
    const res = await httpReq(port, {
      path: `/api/state?token=${ADMIN_TOKEN}`,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] || "", /application\/json/);
    const json = JSON.parse(res.body);
    // Shape contract — these keys are what the dashboard consumes.
    for (const key of [
      "pending",
      "activity",
      "trustLevel",
      "sessionRules",
      "agents",
      "sessions",
      "csrfToken",
      "role",
      "messages",
    ]) {
      assert.ok(key in json, `expected key "${key}" in /api/state response`);
    }
    assert.equal(json.role, "admin");
    assert.ok(Array.isArray(json.sessions));
    assert.equal(json.sessions.length, 0, "fresh server has no sessions");
    assert.equal(typeof json.csrfToken, "string");
    assert.ok(json.csrfToken.length > 0);
  });

  it("POST /api/decide without CSRF token is rejected with 403", async () => {
    // Authenticated but no X-CSRF-Token header — must not 500, must 403.
    const res = await httpReq(port, {
      method: "POST",
      path: `/api/decide?token=${ADMIN_TOKEN}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "whatever", decision: "allow" }),
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /CSRF/i);
  });

  it("POST /api/decide without any auth is rejected with 401 (not 500)", async () => {
    const res = await httpReq(port, {
      method: "POST",
      path: "/api/decide",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
  });

  it("GET /events streams an SSE init message within 2s, then closes cleanly", async () => {
    const received = await new Promise((resolvePromise, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/events?token=${ADMIN_TOKEN}`,
          method: "GET",
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`unexpected SSE status: ${res.statusCode}`));
            return;
          }
          assert.match(res.headers["content-type"] || "", /text\/event-stream/);
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk.toString();
            if (buf.includes("\n\n")) {
              res.destroy();
              resolvePromise(buf);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error("SSE timed out after 5s"));
      });
      req.end();
    });
    // First SSE event should be the "init" payload.
    assert.match(received, /^data: /);
    const payload = JSON.parse(received.replace(/^data:\s*/, "").trim());
    assert.equal(payload.type, "init");
    assert.equal(payload.data.role, "admin");
    assert.equal(typeof payload.data.csrfToken, "string");
  });
});

describe("Farmer rate limiting (smoke)", () => {
  let dataDir;
  let port;
  let farmer;

  before(async () => {
    dataDir = makeDataDir();
    port = allocPort();
    // Lower the /api limit so we can burst past it without sending hundreds
    // of requests. The server reads rateLimit.* from .farmer-config.json.
    writeFileSync(
      join(dataDir, ".farmer-config.json"),
      JSON.stringify({ rateLimit: { api: 3, hooks: 3 } }),
    );
    // --trust-proxy so the server uses our X-Forwarded-For IP (otherwise
    // localhost traffic bypasses the limiter by design).
    farmer = await startFarmer({
      port,
      dataDir,
      extraArgs: ["--trust-proxy"],
    });
  });

  after(async () => {
    if (farmer?.child && farmer.child.exitCode === null) {
      await stopFarmer(farmer.child);
    }
    cleanupDataDir(dataDir);
  });

  it("rejects bursts past the /api limit with 429 + Retry-After", async () => {
    const headers = {
      "x-forwarded-for": "198.51.100.42",
    };
    let sawOk = 0;
    let sawLimited = null;
    // Limit is 3 per 60s — send 6 and expect the tail to be 429.
    for (let i = 0; i < 6; i++) {
      const res = await httpReq(port, {
        path: `/api/state?token=${ADMIN_TOKEN}`,
        headers,
      });
      if (res.status === 200) sawOk++;
      else if (res.status === 429) {
        sawLimited = res;
        break;
      }
    }
    assert.ok(sawOk >= 1, "first few requests should succeed");
    assert.ok(sawLimited, "expected a 429 after exceeding the limit");
    assert.match(sawLimited.headers["content-type"] || "", /application\/json/);
    assert.ok(
      sawLimited.headers["retry-after"],
      "Retry-After header should be set",
    );
    const body = JSON.parse(sawLimited.body);
    assert.match(body.error, /Rate limit/i);
    assert.equal(typeof body.retryAfter, "number");
  });
});

describe("Farmer graceful shutdown (smoke)", () => {
  let dataDir;
  let port;
  let farmer;

  before(async () => {
    dataDir = makeDataDir();
    port = allocPort();
    farmer = await startFarmer({ port, dataDir });
  });

  after(() => {
    cleanupDataDir(dataDir);
  });

  it("exits within 2s of SIGTERM and removes the PID file", async () => {
    // Confirm pid file exists before shutdown (sanity).
    const pidFile = join(dataDir, ".farmer.pid");
    assert.ok(existsSync(pidFile), "PID file should exist while running");
    const t0 = Date.now();
    const exitCode = await stopFarmer(farmer.child, 2500);
    const elapsed = Date.now() - t0;
    assert.notEqual(exitCode, -1, "farmer should exit before force-kill");
    assert.equal(
      exitCode,
      0,
      `farmer should exit 0 on SIGTERM, got ${exitCode}`,
    );
    assert.ok(elapsed < 2000, `shutdown took ${elapsed}ms; should be under 2s`);
    // PID file should be gone.
    assert.ok(
      !existsSync(pidFile),
      "PID file should be released on clean shutdown",
    );
  });
});
