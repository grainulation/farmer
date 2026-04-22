/**
 * connect-server-seam.test.js — closes the bug class that landed us in 1.1.4.
 *
 * lib/connect.js writes hook commands into settings.json; lib/server.js
 * reads .farmer-token and enforces Bearer auth on /hooks/* when `hook` is
 * present. Unit tests on both sides were green in 1.1.4 yet the seam was
 * broken — connect emitted no-auth curls against a server that required
 * them. This test exercises the full path end-to-end in both auth modes
 * and asserts server-side that the POST was accepted (not just that curl
 * exited 0, which the `|| true` shape would mask).
 *
 * Also asserts the w001 bug (tilde inside `-H @<path>` does not expand)
 * cannot recur, and the silent-401 class is surfaced via /status counters
 * and the broken-installs log.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { request as nodeHttpRequest } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { connect, buildHookCommand } from "../lib/connect.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FARMER_BIN = resolve(__dirname, "..", "bin", "farmer.js");

let nextPort = 19190;
const allocPort = () => nextPort++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(port, path) {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", timeout: 3000 },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () =>
          res({
            status: r.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", rej);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

async function startFarmer(port, dataDir) {
  const child = spawn(
    process.execPath,
    [
      FARMER_BIN,
      "start",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--no-open",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (c) => (stderr += c.toString()));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`farmer exited early: ${stderr}`);
    }
    try {
      const r = await httpGet(port, "/status");
      if (r.status === 200) return { child, stderr: () => stderr };
    } catch {}
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(`farmer not ready in 5s: ${stderr}`);
}

function stopFarmer(child) {
  return new Promise((res) => {
    if (child.exitCode !== null) return res(child.exitCode);
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      res(-1);
    }, 3000);
    child.on("exit", (code) => {
      clearTimeout(t);
      res(code);
    });
    child.kill("SIGTERM");
  });
}

function runHook(command, payload) {
  return new Promise((res, rej) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("error", rej);
    child.on("exit", (code) =>
      res({ exitCode: code, stdout: out, stderr: err }),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

function hookCommandFor(settingsPath, event) {
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  const entry = (s.hooks?.[event] || []).find((e) =>
    (e.hooks || []).some((h) => /127\.0\.0\.1:\d+\/hooks\//.test(h.command)),
  );
  return entry.hooks.find((h) => /127\.0\.0\.1:\d+\/hooks\//.test(h.command))
    .command;
}

function samplePayload(cwd) {
  return {
    session_id: "seam-test-" + Date.now(),
    cwd,
    pid: process.pid,
    tool_name: "Bash",
    tool_input: { command: "echo test" },
    tool_result: { stdout: "test\n" },
    hook_event_name: "PostToolUse",
  };
}

const mkDataDir = () => mkdtempSync(join(tmpdir(), "farmer-seam-"));
const rmDataDir = (d) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
};

// ---------- Test 1: connect-server seam works in both auth modes ----------

describe("connect<->server seam: hook POSTs authenticate correctly", () => {
  for (const mode of ["opportunistic", "enforced"]) {
    describe(`mode=${mode}`, () => {
      let dataDir, port, farmer, settingsPath;

      before(async () => {
        dataDir = mkDataDir();
        port = allocPort();
        writeFileSync(
          join(dataDir, ".farmer-config.json"),
          JSON.stringify({ port }),
        );
        if (mode === "enforced") {
          writeFileSync(
            join(dataDir, ".farmer-token"),
            JSON.stringify({
              admin: "a".repeat(32),
              viewer: "v".repeat(32),
              hook: "h".repeat(32),
            }),
            { mode: 0o600 },
          );
        }
        farmer = await startFarmer(port, dataDir);
        await connect({ global: false, cwd: dataDir, dataDir });
        settingsPath = join(dataDir, ".claude", "settings.json");
        assert.ok(
          existsSync(settingsPath),
          "connect should write settings.json",
        );
      });

      after(async () => {
        if (farmer?.child && farmer.child.exitCode === null) {
          await stopFarmer(farmer.child);
        }
        rmDataDir(dataDir);
      });

      it("PostToolUse hook POST is accepted server-side", async () => {
        const cmd = hookCommandFor(settingsPath, "PostToolUse");

        // w001 regression guard — `-H @~/...` does not expand tilde in any
        // shell. Emitted command must use an absolute path.
        assert.ok(
          !/@~\//.test(cmd),
          "emitted hook command must not use `@~/...`",
        );

        const beforeStats = JSON.parse(
          (await httpGet(port, "/status")).body,
        ).hooks;

        const r = await runHook(cmd, samplePayload(dataDir));
        assert.equal(r.exitCode, 0, `hook curl failed: ${r.stderr}`);

        await sleep(150);
        const afterStats = JSON.parse(
          (await httpGet(port, "/status")).body,
        ).hooks;

        assert.equal(
          afterStats.rejected401,
          beforeStats.rejected401,
          `server rejected hook as 401 in ${mode} mode — ` +
            `connect wrote a command the server can't authenticate.`,
        );
        assert.ok(
          afterStats.accepted > beforeStats.accepted,
          "accepted counter should have advanced",
        );
        assert.equal(afterStats.lastType, "activity");
      });
    });
  }
});

// ---------- Red-team regression guards (rt001-rt008) ----------

describe("red-team regressions (rt001-rt008)", () => {
  it("rt002: buildHookCommand throws on path with shell-injection chars", () => {
    // Direct unit test: the function must refuse unsafe paths before any
    // command string is handed to a user-level shell.
    const attacks = [
      '/tmp/"; rm -rf ~; #/hook-auth.header',
      "/tmp/$(whoami)/hook-auth.header",
      "/tmp/`id`/hook-auth.header",
      "/tmp/a'b/hook-auth.header",
      "/tmp/a\nb/hook-auth.header",
    ];
    for (const bad of attacks) {
      assert.throws(
        () => buildHookCommand("http://127.0.0.1:9090", "/hooks/activity", bad),
        /unsafe characters|refusing/i,
        `rt002 regression — buildHookCommand accepted hostile path: ${bad}`,
      );
    }
    // Sanity: safe paths still work
    const safe = buildHookCommand(
      "http://127.0.0.1:9090",
      "/hooks/activity",
      "/Users/alice/.farmer/hook-auth.header",
    );
    assert.match(safe, /-H "@\/Users\/alice\/\.farmer\/hook-auth\.header"/);
  });

  it("rt003: plausible third-party 127.0.0.1 hook is NOT matched as farmer", async () => {
    const dataDir = mkDataDir();
    const port = allocPort();
    try {
      writeFileSync(
        join(dataDir, ".farmer-config.json"),
        JSON.stringify({ port }),
      );
      const settingsDir = join(dataDir, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      const thirdPartyHook = {
        matcher: "",
        hooks: [
          {
            type: "command",
            command:
              "cat | curl -s -X POST http://127.0.0.1:7777/hooks/log " +
              "-H 'X-Dev-Logger: yes' --data-binary @- # not-farmer",
          },
        ],
      };
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({ hooks: { PostToolUse: [thirdPartyHook] } }, null, 2),
      );

      const farmer = await startFarmer(port, dataDir);
      await connect({ global: false, cwd: dataDir, dataDir });
      await stopFarmer(farmer.child);

      const after = JSON.parse(
        readFileSync(join(settingsDir, "settings.json"), "utf8"),
      );
      const stillPresent = after.hooks.PostToolUse.some(
        (entry) =>
          entry.hooks?.[0]?.command === thirdPartyHook.hooks[0].command,
      );
      assert.ok(
        stillPresent,
        "rt003 regression — farmer's auto-migration clobbered a third-party hook",
      );
    } finally {
      rmDataDir(dataDir);
    }
  });

  it("rt006: request with non-loopback Host header is rejected 421", async () => {
    const dataDir = mkDataDir();
    const port = allocPort();
    const farmer = await startFarmer(port, dataDir);
    try {
      const resp = await new Promise((resolve, reject) => {
        const req = nodeHttpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/status",
            method: "GET",
            headers: { Host: "evil.com" },
            timeout: 3000,
          },
          (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () =>
              resolve({
                status: r.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(resp.status, 421, "rt006: DNS-rebinding host must 421");
      assert.match(
        resp.body,
        /misdirected_host/i,
        "rt006: response should identify as host mismatch",
      );
    } finally {
      await stopFarmer(farmer.child);
      rmDataDir(dataDir);
    }
  });

  it("rt004: /hooks/lifecycle compact refuses unregistered cwd (default install has empty registeredProjects)", async () => {
    // Red-team re-verify caught that the first fix used _isRegisteredProject,
    // which default-allows on empty registeredProjects. Default installs
    // have []  and so the exfil hole remained open. This test plants a
    // real compilation.json at an attacker-controlled path — the test
    // passes ONLY if the server refuses to read it.
    const dataDir = mkDataDir();
    const victimDir = mkDataDir();
    const port = allocPort();
    try {
      writeFileSync(
        join(dataDir, ".farmer-token"),
        JSON.stringify({
          admin: "a".repeat(32),
          viewer: "v".repeat(32),
          hook: "h".repeat(32),
        }),
        { mode: 0o600 },
      );
      // Plant a compilation.json in the victim dir. If the rt004 fix is
      // working, the server must NOT return this content.
      const SECRET_MARKER = "RT004-DO-NOT-LEAK-THIS-STRING";
      writeFileSync(
        join(victimDir, "compilation.json"),
        JSON.stringify({ question: SECRET_MARKER, claims: [] }),
      );
      const farmer = await startFarmer(port, dataDir);
      const body = JSON.stringify({
        event: "session_new",
        source: "compact",
        sessionId: "rt004-reverify",
        cwd: victimDir,
      });
      const resp = await new Promise((resolve, reject) => {
        const req = nodeHttpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/hooks/lifecycle",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Authorization: "Bearer " + "h".repeat(32),
            },
            timeout: 3000,
          },
          (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () =>
              resolve({
                status: r.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      await stopFarmer(farmer.child);
      assert.equal(resp.status, 200);
      assert.ok(
        !resp.body.includes(SECRET_MARKER),
        "rt004 regression — /hooks/lifecycle leaked a file from an unregistered cwd on a default install",
      );
      const parsed = JSON.parse(resp.body);
      assert.ok(
        !parsed.additionalContext,
        "rt004: additionalContext must be empty for unregistered cwd",
      );
    } finally {
      rmDataDir(dataDir);
      rmDataDir(victimDir);
    }
  });
});

// ---------- E2E feedback workflow (rt-fb1 / rt-fb2 / rt-fb3) ----------
//
// Walks the full mobile-feedback-submit -> Claude-poll -> Claude-ack path
// and verifies per-session semantics hold end-to-end. Previously missed
// by the attack-surface red team: the workflow semantics themselves had
// holes (default session fallback, ack-all, untargeted poll fallback)
// that let feedback cross between sessions on the same host.

describe("feedback workflow is session-scoped end-to-end", () => {
  let dataDir, port, farmer, sessionA, sessionB, hookToken;

  before(async () => {
    dataDir = mkDataDir();
    port = allocPort();
    hookToken = "h".repeat(32);
    const adminToken = "a".repeat(32);
    writeFileSync(
      join(dataDir, ".farmer-token"),
      JSON.stringify({
        admin: adminToken,
        viewer: "v".repeat(32),
        hook: hookToken,
      }),
      { mode: 0o600 },
    );
    farmer = await startFarmer(port, dataDir);
    sessionA = "feedback-session-A-" + Date.now();
    sessionB = "feedback-session-B-" + Date.now();

    // Register two distinct sessions by firing a PostToolUse hook for each
    for (const sid of [sessionA, sessionB]) {
      const body = JSON.stringify({
        session_id: sid,
        cwd: dataDir,
        tool_name: "Bash",
        hook_event_name: "PostToolUse",
      });
      await new Promise((resolve, reject) => {
        const req = nodeHttpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/hooks/activity",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Authorization: "Bearer " + hookToken,
            },
          },
          (r) => {
            r.resume();
            r.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
    }
    await sleep(100);
  });

  after(async () => {
    if (farmer?.child && farmer.child.exitCode === null) {
      await stopFarmer(farmer.child);
    }
    rmDataDir(dataDir);
  });

  const req = (path, method, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const opts = {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...headers },
        timeout: 3000,
      };
      if (body) {
        opts.headers["Content-Length"] = Buffer.byteLength(body);
        if (!opts.headers["Content-Type"])
          opts.headers["Content-Type"] = "application/json";
      }
      const r = nodeHttpRequest(opts, (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () =>
          resolve({
            status: resp.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });

  it("rt-fb1: submit without session_id is rejected 400", async () => {
    const r = await req(
      "/api/feedback",
      "POST",
      JSON.stringify({ content: "hello" }),
      { Authorization: "Bearer " + "a".repeat(32) },
    );
    assert.equal(r.status, 400);
    assert.match(r.body, /session_id_required/);
  });

  it("rt-fb1: submit to session A, poll from session B returns empty", async () => {
    const submit = await req(
      "/api/feedback",
      "POST",
      JSON.stringify({ content: "for A only", session_id: sessionA }),
      { Authorization: "Bearer " + "a".repeat(32) },
    );
    assert.equal(submit.status, 200, `submit: ${submit.body}`);

    const pollB = await req(
      `/api/feedback/poll?session_id=${encodeURIComponent(sessionB)}`,
      "GET",
      null,
      { Authorization: "Bearer " + hookToken },
    );
    assert.equal(pollB.status, 200);
    const itemsB = JSON.parse(pollB.body).items;
    assert.equal(
      itemsB.length,
      0,
      `rt-fb1 regression — session B received session A's feedback: ${pollB.body}`,
    );

    const pollA = await req(
      `/api/feedback/poll?session_id=${encodeURIComponent(sessionA)}`,
      "GET",
      null,
      { Authorization: "Bearer " + hookToken },
    );
    const itemsA = JSON.parse(pollA.body).items;
    assert.ok(
      itemsA.length >= 1,
      `session A should see its own feedback: ${pollA.body}`,
    );
    assert.ok(itemsA.some((i) => i.text.includes("for A only")));
  });

  it("rt-fb2: poll without hook token is rejected 401 in enforced mode", async () => {
    const r = await req(
      `/api/feedback/poll?session_id=${encodeURIComponent(sessionA)}`,
      "GET",
    );
    assert.equal(r.status, 401, `poll must require Bearer: ${r.body}`);
  });

  it("rt-fb1: ack from wrong session does not mark items delivered", async () => {
    // Submit a new item for A
    const submit = await req(
      "/api/feedback",
      "POST",
      JSON.stringify({ content: "ack test", session_id: sessionA }),
      { Authorization: "Bearer " + "a".repeat(32) },
    );
    const submitted = JSON.parse(submit.body);

    // Try to ack it FROM session B
    const wrongAck = await req(
      "/api/feedback/ack",
      "POST",
      JSON.stringify({ session_id: sessionB, ids: [submitted.id] }),
      { Authorization: "Bearer " + hookToken },
    );
    assert.equal(wrongAck.status, 200);
    assert.equal(
      JSON.parse(wrongAck.body).acked,
      0,
      "rt-fb1 regression — session B acked session A's feedback",
    );

    // Verify the item is still pending: poll as A returns it
    const poll = await req(
      `/api/feedback/poll?session_id=${encodeURIComponent(sessionA)}`,
      "GET",
      null,
      { Authorization: "Bearer " + hookToken },
    );
    const items = JSON.parse(poll.body).items;
    assert.ok(
      items.some((i) => i.id === submitted.id),
      "item should still be pending after wrong-session ack",
    );

    // Correct-session ack works
    const rightAck = await req(
      "/api/feedback/ack",
      "POST",
      JSON.stringify({ session_id: sessionA, ids: [submitted.id] }),
      { Authorization: "Bearer " + hookToken },
    );
    assert.equal(rightAck.status, 200);
    assert.equal(JSON.parse(rightAck.body).acked, 1);
  });

  it("rt-fb3: legacy /api/feedback/read is 410 Gone", async () => {
    const r = await req("/api/feedback/read", "POST", "");
    assert.equal(r.status, 410);
    assert.match(r.body, /endpoint_removed|\/api\/feedback\/ack/);
  });
});

// ---------- Test 2: silent-401 class is surfaced ----------

describe("silent-401 visibility: server records rejections users can see", () => {
  let dataDir, port, farmer;

  before(async () => {
    dataDir = mkDataDir();
    port = allocPort();
    // Enforced mode with a hook token that no client will provide
    writeFileSync(
      join(dataDir, ".farmer-token"),
      JSON.stringify({
        admin: "a".repeat(32),
        viewer: "v".repeat(32),
        hook: "server-side-hook-xxxxxxxxxxxxxxx",
      }),
      { mode: 0o600 },
    );
    farmer = await startFarmer(port, dataDir);
  });

  after(async () => {
    if (farmer?.child && farmer.child.exitCode === null) {
      await stopFarmer(farmer.child);
    }
    rmDataDir(dataDir);
  });

  it("401 on /hooks/* increments /status counter and appends broken-installs log", async () => {
    // Forge the 1.1.4 shape (no Authorization header)
    const buggyCmd =
      `cat | curl -sS -X POST http://127.0.0.1:${port}/hooks/activity ` +
      `-H 'Content-Type: application/json' --data-binary @-`;
    await runHook(buggyCmd, samplePayload(dataDir));

    await sleep(150);

    const status = JSON.parse((await httpGet(port, "/status")).body);
    assert.ok(
      status.hooks.rejected401 >= 1,
      "/status must expose rejected401 counter for `farmer status` to render",
    );

    const logPath = join(dataDir, ".farmer-broken-installs.jsonl");
    assert.ok(
      existsSync(logPath),
      "401 must append to .farmer-broken-installs.jsonl for user diagnosis",
    );
    const last = JSON.parse(
      readFileSync(logPath, "utf8").trim().split("\n").pop(),
    );
    assert.equal(last.type, "activity");
    assert.equal(last.reason, "missing_or_wrong_bearer");
  });
});
