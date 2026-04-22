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
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { connect } from "../lib/connect.js";

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
