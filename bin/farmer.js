#!/usr/bin/env node
/**
 * Farmer CLI — start, stop, and check status of the permission dashboard.
 *
 * Usage:
 *   farmer start [--port 9090] [--token <secret>] [--trust-proxy] [--data-dir <path>]
 *   farmer stop
 *   farmer status
 *   farmer connect [--global]
 */

// Node version gate — fail fast with a clear message on Node < 18
{
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(
      `\n  Error: Node 18+ is required, but you are running ${process.version}.\n` +
      `  Please upgrade Node.js: https://nodejs.org/\n`
    );
    process.exit(1);
  }
}

import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { FarmerServer } from '../lib/server.js';
import { PidLock } from '../lib/security.js';
import { connect, hasGlobalHooks, hasProjectHooks } from '../lib/connect.js';

const verbose = process.argv.includes('--verbose');
function vlog(...a) {
  if (!verbose) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] farmer: ${a.join(' ')}\n`);
}
export { vlog, verbose };

const args = process.argv.slice(2);
const command = args[0] || 'start';

vlog('startup', `command=${command}`, `cwd=${process.cwd()}`);

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const dataDir = resolve(arg('data-dir', process.cwd()));

// Load .farmer-config.json (optional — CLI flags override)
let fileConfig = {};
for (const searchDir of [process.cwd(), dataDir]) {
  const configPath = join(searchDir, '.farmer-config.json');
  if (existsSync(configPath)) {
    try { fileConfig = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    break;
  }
}
function cfg(name, fallback) {
  // CLI flag wins, then config file, then fallback
  const cliVal = arg(name, undefined);
  if (cliVal !== undefined) return cliVal;
  // config keys use camelCase: "tunnel-hostname" -> "tunnelHostname"
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (fileConfig[camel] !== undefined) return String(fileConfig[camel]);
  return fallback;
}

const pidLock = new PidLock(join(dataDir, '.farmer.pid'));

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`Farmer — permission dashboard for AI coding agents

Usage: farmer <command> [options]

Commands:
  start    Start the dashboard server (default)
  stop     Stop a running instance
  status   Check if Farmer is running
  connect  Install Claude Code hooks (one-command setup)

Options (connect):
  --global               Install hooks in ~/.claude/settings.json (all projects)
                         Without --global, installs in ./.claude/settings.json

Options (start):
  --port <n>               Port to listen on (default: 9090)
  --token <secret>         Admin auth token (a viewer token is auto-generated;
                           both are persisted as JSON to .farmer-token)
  --trust-proxy            Trust X-Forwarded-For headers
  --data-dir <path>        Directory for state/audit files (default: cwd)
  --max-sessions <n>       Max concurrent sessions (default: 50)
  --claims <path>          Path to claims.json (enables Claims tab)
  --compilation <path>     Path to compilation.json (enables sprint status)
  --tunnel-name <name>     Named cloudflared tunnel (stable URL)
  --tunnel-hostname <host> Hostname for named tunnel
  --no-tunnel              Skip cloudflared tunnel auto-start
  --no-open                Don't open browser on start
  --verbose                Enable verbose logging to stderr

Config file:
  Place .farmer-config.json in CWD or --data-dir. Supports: port,
  trustProxy, registeredProjects, tunnelName, tunnelHostname, rateLimit.
  CLI flags override config values.

Examples:
  farmer start --port 8080
  farmer start --claims ./claims.json --compilation ./compilation.json
  farmer start --tunnel-name my-tunnel --tunnel-hostname farm.example.com
  farmer start --no-tunnel --no-open
  farmer stop
  farmer status`);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`farmer v${pkg.version}`);
  process.exit(0);
}

switch (command) {
  case 'start': {
    const claimsPath = cfg('claims', '');
    const compilationPath = cfg('compilation', '') || (claimsPath ? resolve(join(resolve(claimsPath, '..'), 'compilation.json')) : '');

    // Parse registered projects from config (array) or CLI (comma-separated)
    let registeredProjects = [];
    if (fileConfig.registeredProjects && Array.isArray(fileConfig.registeredProjects)) {
      registeredProjects = fileConfig.registeredProjects.map(p => resolve(p));
    }
    const cliProjects = arg('registered-projects', undefined);
    if (cliProjects) registeredProjects = cliProjects.split(',').map(p => resolve(p.trim()));

    // Parse rate limits from config
    let rateLimit = undefined;
    if (fileConfig.rateLimit && typeof fileConfig.rateLimit === 'object') {
      rateLimit = fileConfig.rateLimit;
    }

    const server = new FarmerServer({
      port: parseInt(cfg('port', '9090'), 10),
      token: arg('token', undefined),
      trustProxy: args.includes('--trust-proxy') || fileConfig.trustProxy === true,
      dataDir,
      maxSessions: parseInt(cfg('max-sessions', '50'), 10),
      tokenRotationInterval: parseInt(cfg('token-rotation-interval', '0'), 10),
      tokenGracePeriod: parseInt(cfg('token-grace-period', '60'), 10),
      claimsPath: claimsPath ? resolve(claimsPath) : '',
      compilationPath: compilationPath ? resolve(compilationPath) : '',
      registeredProjects,
      tunnelName: cfg('tunnel-name', ''),
      tunnelHostname: cfg('tunnel-hostname', ''),
      rateLimit,
      noTunnel: args.includes('--no-tunnel'),
      noOpen: args.includes('--no-open'),
    });
    server.start();
    break;
  }

  case 'stop': {
    const pid = pidLock.readPid();
    if (!pid) {
      console.log('No running Farmer instance found.');
      process.exit(0);
    }
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopping Farmer (PID ${pid})...`);
      // Wait up to 3s for process to exit
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        try { process.kill(pid, 0); } catch { pidLock.forceRelease(); console.log('Stopped.'); process.exit(0); }
      }
      // Still alive after 3s — force kill
      try { process.kill(pid, 'SIGKILL'); } catch {}
      pidLock.forceRelease();
      console.log('Force-killed.');
    } catch (err) {
      if (err.code === 'ESRCH') {
        console.log(`Farmer (PID ${pid}) is not running. Cleaning stale PID file.`);
        pidLock.forceRelease();
      } else {
        console.error(`farmer: failed to stop: ${err.message}`);
        process.exit(1);
      }
    }
    break;
  }

  case 'status': {
    const jsonMode = args.includes('--json');
    const pid = pidLock.readPid();
    if (!pid) {
      if (jsonMode) {
        console.log(JSON.stringify({ running: false, pid: null }));
      } else {
        console.log('Farmer is not running.');
      }
      process.exit(1);
    }
    const running = pidLock.isRunning();
    if (jsonMode) {
      console.log(JSON.stringify({ running, pid }));
      process.exit(running ? 0 : 1);
    }
    if (running) {
      console.log(`Farmer is running (PID ${pid}).`);
      process.exit(0);
    } else {
      console.log(`Farmer PID file exists (PID ${pid}) but process is not running.`);
      process.exit(1);
    }
    break;
  }

  case 'connect': {
    const isGlobal = args.includes('--global');
    connect({ global: isGlobal, cwd: process.cwd(), dataDir }).then(() => {
      process.exit(0);
    }).catch((err) => {
      console.error(`\n  Error: ${err.message}\n`);
      process.exit(1);
    });
    break;
  }

  default:
    console.error(`farmer: unknown command: ${command}`);
    console.error('Usage: farmer <start|stop|status|connect> [options]');
    process.exit(1);
}
