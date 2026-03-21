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

// The hook templates — must match templates/hooks.json but with port placeholder
function makeHooks(port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    PreToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `cat | curl -s -X POST ${base}/hooks/permission -H 'Content-Type: application/json' --data-binary @- 2>/dev/null || true`,
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
            command: `cat | curl -s -X POST ${base}/hooks/activity -H 'Content-Type: application/json' --data-binary @- 2>/dev/null || true`,
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
            command: `cat | curl -s -X POST ${base}/hooks/notification -H 'Content-Type: application/json' --data-binary @- 2>/dev/null || true`,
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
            command: `cat | curl -s -X POST ${base}/hooks/stop -H 'Content-Type: application/json' --data-binary @- 2>/dev/null || true`,
            timeout: 5,
          },
        ],
      },
    ],
  };
}

/**
 * Check if a hook entry is a farmer hook (matches the port pattern).
 */
function isFarmerHook(hookEntry) {
  if (!hookEntry?.hooks) return false;
  return hookEntry.hooks.some(
    (h) => h.command && /127\.0\.0\.1:\d+\/hooks\//.test(h.command),
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
 * Searches cwd, then home directory for config with a port setting.
 */
function detectPort() {
  const searchDirs = [process.cwd(), homedir()];
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
 * Probe whether farmer is listening on the given port.
 * Returns a promise that resolves to true/false.
 */
function probeFarmer(port) {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: 1000,
      },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
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
  const dataDir = opts.dataDir || cwd;
  const port = detectPort();

  // Probe farmer to see if it's running
  const farmerRunning = await probeFarmer(port);

  // Build hooks for the detected port
  const farmerHooks = makeHooks(port);

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
