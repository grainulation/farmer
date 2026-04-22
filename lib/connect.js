/**
 * farmer connect — one-command hook setup for Claude Code.
 *
 * Collapses 3 setup steps into 1:
 *   1. Write/merge hooks into .claude/settings.json
 *   2. Register project in .farmer-config.json
 *   3. Print restart reminder
 *
 * Usage:
 *   farmer connect           — per-project (hooks in ./.claude/settings.json)
 *   farmer connect --global  — user-level (hooks in ~/.claude/settings.json)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";

// Sentinel embedded in every hook command farmer emits. Lets auto-migration
// identify OUR hooks without greedy pattern-match on `/hooks/*` (which would
// clobber hand-edits or third-party tools emitting to the same path).
// Appears as a shell comment — inert at runtime, pattern-unique on disk.
const FARMER_SENTINEL = "# @farmer-managed";

// Prefix shape emitted by farmer 1.1.4 and earlier (no Bearer, no sentinel).
// Used for opt-in auto-migration: only exact-prefix matches get rewritten.
const LEGACY_1_1_4_PREFIX = "cat | curl -s -X POST http://127.0.0.1:";

/**
 * Build a single hook curl command. Encodes the 1.1.5 fix decisions:
 *   - `-H "@<absPath>"` uses an absolute path, NOT `~` (tilde does not
 *     expand inside `@<path>` in any shell; verified broken in
 *     bash/zsh/sh/dash).
 *   - `--fail-with-body` makes non-2xx return non-zero.
 *   - No `2>/dev/null` — curl stderr rides to Claude Code's hook log so
 *     users can see 401s / connection errors when debugging.
 *   - No `|| true` — exit code now reflects reality. Claude Code does not
 *     block tool use on hook failure, so a non-zero exit is safe UX.
 *   - Trailing `# @farmer-managed` sentinel enables safe auto-migration.
 */
function buildHookCommand(base, path, hookAuthPath) {
  const authArg = hookAuthPath ? `-H "@${hookAuthPath}" ` : "";
  return (
    `cat | curl -sS --fail-with-body -X POST ${base}${path} ` +
    `${authArg}-H 'Content-Type: application/json' --data-binary @- ` +
    FARMER_SENTINEL
  );
}

// The hook templates — must match templates/hooks.json but with port placeholder
function makeHooks(port, hookAuthPath) {
  const base = `http://127.0.0.1:${port}`;
  return {
    PreToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: buildHookCommand(base, "/hooks/permission", hookAuthPath),
            timeout: 120,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: buildHookCommand(base, "/hooks/activity", hookAuthPath),
          },
        ],
      },
    ],
    Notification: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: buildHookCommand(
              base,
              "/hooks/notification",
              hookAuthPath,
            ),
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: buildHookCommand(base, "/hooks/stop", hookAuthPath),
            timeout: 5,
          },
        ],
      },
    ],
  };
}

/**
 * Check if a hook entry is a farmer hook — detects (a) the 1.1.5+ sentinel,
 * or (b) the exact 1.1.4 prefix. Anything else is someone else's hook and
 * must not be rewritten.
 */
function isFarmerHook(hookEntry) {
  if (!hookEntry?.hooks) return false;
  return hookEntry.hooks.some(
    (h) =>
      h.command &&
      (h.command.includes(FARMER_SENTINEL) ||
        h.command.startsWith(LEGACY_1_1_4_PREFIX)),
  );
}

/**
 * Merge farmer hooks into an existing settings object.
 * Preserves all non-farmer hooks and other settings keys.
 * Deduplicates: if farmer hooks already exist, replaces them (to update port).
 */
function mergeHooks(existing, farmerHooks) {
  const settings = { ...existing };
  if (!settings.hooks) settings.hooks = {};

  for (const [hookType, farmerEntries] of Object.entries(farmerHooks)) {
    const current = settings.hooks[hookType] || [];
    // Remove existing farmer hooks (will be replaced)
    const nonFarmer = current.filter((entry) => !isFarmerHook(entry));
    settings.hooks[hookType] = [...nonFarmer, ...farmerEntries];
  }

  return settings;
}

/**
 * Read JSON file, returning fallback on missing/corrupt.
 */
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON with 2-space indent.
 */
function writeJson(path, data) {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error(`Could not write to ${path}: ${err.message}`);
    process.exit(1);
  }
}

function safeMkdir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`Could not create directory ${dir}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Detect farmer port: check .farmer-config.json in likely locations, or default 9090.
 * Search order: dataDir (if passed), cwd (if passed), process.cwd(), $HOME.
 * Respects opts so test harnesses and programmatic callers can isolate from
 * the developer's real farmer config.
 */
function detectPort(opts = {}) {
  const seen = new Set();
  const searchDirs = [];
  for (const d of [opts.dataDir, opts.cwd, process.cwd(), homedir()]) {
    if (d && !seen.has(d)) {
      searchDirs.push(d);
      seen.add(d);
    }
  }
  for (const dir of searchDirs) {
    const configPath = join(dir, ".farmer-config.json");
    const config = readJson(configPath, null);
    if (config && config.port) {
      const p = parseInt(config.port, 10);
      if (p > 0 && p < 65536) return p;
    }
  }
  return 9090;
}

/**
 * Extract port from a farmer hook command string.
 * Returns the port number or null if not found.
 */
function extractPortFromHook(hookEntry) {
  if (!hookEntry?.hooks) return null;
  for (const h of hookEntry.hooks) {
    if (!h.command) continue;
    const m = h.command.match(/127\.0\.0\.1:(\d+)\/hooks\//);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Query GET /status on a running farmer. Returns the parsed JSON body
 * or null if farmer isn't running / doesn't respond / returns a non-2xx.
 *
 * Used to read `dataDir` + `hookAuthPath` from the live server so the
 * emitted hook curls point at the same absolute path the server is
 * writing (closes the connect-CWD vs start-dataDir divergence — x003).
 */
function probeFarmerStatus(port) {
  return new Promise((res) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/status",
        method: "GET",
        timeout: 1500,
      },
      (resp) => {
        if (resp.statusCode !== 200) {
          resp.resume();
          res(null);
          return;
        }
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          try {
            res(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            res(null);
          }
        });
      },
    );
    req.on("error", () => res(null));
    req.on("timeout", () => {
      req.destroy();
      res(null);
    });
    req.end();
  });
}

/**
 * Check if hooks are already configured in ~/.claude/settings.json.
 */
export function hasGlobalHooks() {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = readJson(settingsPath, {});
  if (!settings.hooks) return false;
  for (const hookType of Object.keys(settings.hooks)) {
    const entries = settings.hooks[hookType] || [];
    if (entries.some(isFarmerHook)) return true;
  }
  return false;
}

/**
 * Check if hooks exist in a project-level settings file.
 */
export function hasProjectHooks(cwd) {
  const settingsPath = join(cwd, ".claude", "settings.json");
  const settings = readJson(settingsPath, {});
  if (!settings.hooks) return false;
  for (const hookType of Object.keys(settings.hooks)) {
    const entries = settings.hooks[hookType] || [];
    if (entries.some(isFarmerHook)) return true;
  }
  return false;
}

/**
 * Main connect logic.
 * @param {object} opts
 * @param {boolean} opts.global — install hooks globally (~/.claude/settings.json)
 * @param {string} opts.cwd — current working directory (for per-project mode)
 * @param {string} opts.dataDir — farmer data dir (to find .farmer-config.json)
 */
export async function connect(opts = {}) {
  const isGlobal = opts.global || false;
  const cwd = opts.cwd || process.cwd();
  let dataDir = opts.dataDir || cwd;
  const port = detectPort({ cwd, dataDir });

  // Query /status on the live farmer. Used for two things (x003 fix):
  //   1. Discover the server's real `dataDir` — the authoritative location
  //      of `hook-auth.header`. Avoids the connect-CWD vs start-CWD drift
  //      that silently 401'd hooks in 1.1.4.
  //   2. Learn `hookAuthMode`. In enforced mode, emit `-H @<path>`; in
  //      opportunistic mode, omit the auth arg so pre-upgrade users keep
  //      working until they provision a token.
  const status = await probeFarmerStatus(port);
  const farmerRunning = status !== null;

  // When farmer is running, trust ITS dataDir over the CLI arg. When farmer
  // isn't running, fall back to the CLI arg or cwd — user will re-run
  // `farmer connect` after `farmer start` if they want the authoritative path.
  let hookAuthPath = null;
  if (status) {
    if (status.dataDir) dataDir = status.dataDir;
    if (status.hookAuthMode === "enforced") {
      hookAuthPath = status.hookAuthPath || join(dataDir, "hook-auth.header");
    }
  } else if (existsSync(join(dataDir, ".farmer-token"))) {
    // Farmer isn't running, but a token file exists — best-effort: if that
    // file has a `hook` field, enforcement will kick in when farmer starts.
    // Embed the auth path now so the emitted hooks survive the next start.
    try {
      const tokenRaw = readFileSync(join(dataDir, ".farmer-token"), "utf8");
      const parsed = JSON.parse(tokenRaw);
      if (parsed && typeof parsed === "object" && parsed.hook) {
        hookAuthPath = join(dataDir, "hook-auth.header");
      }
    } catch {
      // plain-text or corrupt token file — legacy shape, no auth expected
    }
  }

  // Build hooks for the detected port + auth path
  const farmerHooks = makeHooks(port, hookAuthPath);

  if (isGlobal) {
    // --- Global mode: ~/.claude/settings.json ---
    const claudeDir = join(homedir(), ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    if (!existsSync(claudeDir)) {
      safeMkdir(claudeDir);
    }

    const existing = readJson(settingsPath, {});

    // Check if already connected
    if (existing.hooks) {
      const alreadyHasFarmer = Object.values(existing.hooks).some((entries) =>
        (entries || []).some(isFarmerHook),
      );
      if (alreadyHasFarmer) {
        // Check if existing hooks point to the correct port
        let existingPort = null;
        for (const entries of Object.values(existing.hooks)) {
          for (const entry of entries || []) {
            const p = extractPortFromHook(entry);
            if (p) {
              existingPort = p;
              break;
            }
          }
          if (existingPort) break;
        }
        if (existingPort && existingPort !== port) {
          // Port mismatch — update hooks to use correct port
          const merged = mergeHooks(existing, farmerHooks);
          writeJson(settingsPath, merged);
          console.log(
            `\n  Updated hooks globally (port ${existingPort} -> ${port}).`,
          );
          console.log(`  ${settingsPath}`);
          if (!farmerRunning) {
            console.log(`\n  Note: farmer is not running on port ${port}.`);
            console.log(
              "  Hooks will fail silently until you run: farmer start",
            );
          }
          console.log(
            "\n  Restart any running claude sessions to activate updated hooks.\n",
          );
          return;
        }
        console.log("\n  Already connected globally. Farmer hooks found in:");
        console.log(`  ${settingsPath}`);
        if (!farmerRunning) {
          console.log(`\n  Note: farmer is not running on port ${port}.`);
          console.log("  Hooks will fail silently until you run: farmer start");
        }
        console.log("");
        return;
      }
    }

    const merged = mergeHooks(existing, farmerHooks);
    writeJson(settingsPath, merged);

    console.log("\n  Connected globally. Hooks installed in:");
    console.log(`  ${settingsPath}`);
    console.log("\n  All future claude sessions will route to farmer.");
    if (!farmerRunning) {
      console.log(`\n  Note: farmer is not running on port ${port}.`);
      console.log("  Hooks will fail silently until you run: farmer start");
    }
    console.log("\n  Restart any running claude sessions to activate hooks.\n");
  } else {
    // --- Per-project mode: ./.claude/settings.json ---
    const claudeDir = join(cwd, ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    if (!existsSync(claudeDir)) {
      safeMkdir(claudeDir);
    }

    const existing = readJson(settingsPath, {});

    // Check if already connected
    if (existing.hooks) {
      const alreadyHasFarmer = Object.values(existing.hooks).some((entries) =>
        (entries || []).some(isFarmerHook),
      );
      if (alreadyHasFarmer) {
        // Check if existing hooks point to the correct port
        let existingPort = null;
        for (const entries of Object.values(existing.hooks)) {
          for (const entry of entries || []) {
            const p = extractPortFromHook(entry);
            if (p) {
              existingPort = p;
              break;
            }
          }
          if (existingPort) break;
        }
        if (existingPort && existingPort !== port) {
          // Port mismatch — update hooks to use correct port
          const merged = mergeHooks(existing, farmerHooks);
          writeJson(settingsPath, merged);
          console.log(
            `\n  Updated hooks in this project (port ${existingPort} -> ${port}).`,
          );
          console.log(`  ${settingsPath}`);
          if (!farmerRunning) {
            console.log(`\n  Note: farmer is not running on port ${port}.`);
            console.log(
              "  Hooks will fail silently until you run: farmer start",
            );
          }
          console.log(
            "\n  Restart claude in this directory to activate updated hooks.\n",
          );
          return;
        }
        console.log(
          "\n  Already connected in this project. Farmer hooks found in:",
        );
        console.log(`  ${settingsPath}`);
        if (!farmerRunning) {
          console.log(`\n  Note: farmer is not running on port ${port}.`);
          console.log("  Hooks will fail silently until you run: farmer start");
        }
        console.log("");
        return;
      }
    }

    const merged = mergeHooks(existing, farmerHooks);
    writeJson(settingsPath, merged);

    // Register project in .farmer-config.json
    const configPath = join(dataDir, ".farmer-config.json");
    const config = readJson(configPath, {});
    if (!config.registeredProjects) config.registeredProjects = [];
    const absCwd = resolve(cwd);
    if (!config.registeredProjects.includes(absCwd)) {
      config.registeredProjects.push(absCwd);
      writeJson(configPath, config);
      console.log(`\n  Registered project: ${absCwd}`);
      console.log(`  Config: ${configPath}`);
    }

    console.log("\n  Connected. Hooks installed in:");
    console.log(`  ${settingsPath}`);
    if (!farmerRunning) {
      console.log(`\n  Note: farmer is not running on port ${port}.`);
      console.log("  Hooks will fail silently until you run: farmer start");
    }
    console.log(
      "\n  Restart claude in this directory to activate farmer hooks.\n",
    );
  }
}
