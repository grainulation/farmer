#!/usr/bin/env node
/**
 * Farmer CLI — start, stop, and check status of the permission dashboard.
 *
 * Usage:
 *   farmer start [--port 9090] [--token <secret>] [--trust-proxy] [--data-dir <path>]
 *   farmer stop
 *   farmer status
 */

import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { FarmerServer } from '../lib/server.js';
import { PidLock } from '../lib/security.js';

const args = process.argv.slice(2);
const command = args[0] || 'start';

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const dataDir = resolve(arg('data-dir', process.cwd()));
const pidLock = new PidLock(join(dataDir, '.farmer.pid'));

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`Farmer — permission dashboard for AI coding agents

Usage: farmer <command> [options]

Commands:
  start    Start the dashboard server (default)
  stop     Stop a running instance
  status   Check if Farmer is running

Options (start):
  --port <n>           Port to listen on (default: 9090)
  --token <secret>     Auth token (persisted to .farmer-token if omitted)
  --trust-proxy        Trust X-Forwarded-For headers
  --data-dir <path>    Directory for state/audit files (default: cwd)
  --max-sessions <n>   Max concurrent sessions (default: 50)
  --claims <path>      Path to claims.json (enables Claims tab)
  --compilation <path> Path to compilation.json (enables sprint status)
  --no-tunnel          Skip cloudflared tunnel auto-start
  --no-open            Don't open browser on start

Examples:
  farmer start --port 8080
  farmer start --claims ./claims.json --compilation ./compilation.json
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
    const claimsPath = arg('claims', '');
    const compilationPath = arg('compilation', '') || (claimsPath ? resolve(join(resolve(claimsPath, '..'), 'compilation.json')) : '');
    const server = new FarmerServer({
      port: parseInt(arg('port', '9090'), 10),
      token: arg('token', undefined),
      trustProxy: args.includes('--trust-proxy'),
      dataDir,
      maxSessions: parseInt(arg('max-sessions', '50'), 10),
      tokenRotationInterval: parseInt(arg('token-rotation-interval', '0'), 10),
      tokenGracePeriod: parseInt(arg('token-grace-period', '60'), 10),
      claimsPath: claimsPath ? resolve(claimsPath) : '',
      compilationPath: compilationPath ? resolve(compilationPath) : '',
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
      console.log(`Sent SIGTERM to Farmer (PID ${pid}).`);
    } catch (err) {
      if (err.code === 'ESRCH') {
        console.log(`Farmer (PID ${pid}) is not running. Cleaning stale PID file.`);
        pidLock.release();
      } else {
        console.error(`Failed to stop Farmer: ${err.message}`);
        process.exit(1);
      }
    }
    break;
  }

  case 'status': {
    const pid = pidLock.readPid();
    if (!pid) {
      console.log('Farmer is not running.');
      process.exit(1);
    }
    const running = pidLock.isRunning();
    if (running) {
      console.log(`Farmer is running (PID ${pid}).`);
      process.exit(0);
    } else {
      console.log(`Farmer PID file exists (PID ${pid}) but process is not running.`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: farmer <start|stop|status> [options]');
    process.exit(1);
}
