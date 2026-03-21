/**
 * Farmer server — the core permission dashboard server.
 *
 * Receives hook events from AI coding agents, pushes them to a browser
 * dashboard via SSE, and relays approve/deny decisions.
 *
 * Agent-agnostic: adapters translate between agent-specific hook formats
 * and Farmer's internal protocol. Claude Code adapter ships first.
 *
 * Zero dependencies.
 */

import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  watchFile,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { hasGlobalHooks, hasProjectHooks } from "./connect.js";
import { Persistence } from "./persistence.js";
import { buildCompactContext } from "./compact-context.js";
import {
  SECURITY_HEADERS,
  TokenManager,
  CsrfManager,
  PidLock,
  sourceFingerprint,
  deriveSessionId,
  clientAddr,
} from "./security.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

// ── Harvest analytics valid types ──
const HARVEST_TYPES = new Set(["health", "decay", "insight", "digest"]);

// ── Ecosystem tool port registry ──
const ECOSYSTEM_PORTS = {
  farmer: 9090,
  wheat: 9091,
  barn: 9093,
  mill: 9094,
  silo: 9095,
  harvest: 9096,
  orchard: 9097,
  grainulation: 9098,
};

// ── Crash handlers ──
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[${new Date().toISOString()}] FATAL: ${err.stack || err}\n`,
  );
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[${new Date().toISOString()}] WARN unhandledRejection: ${reason}\n`,
  );
});

const qrLibSource = (() => {
  try {
    return readFileSync(join(__dirname, "qrcodegen-nayuki.js"), "utf8");
  } catch {
    return "";
  }
})();

// --- Session state ---
class SessionState {
  constructor(sessionId, cwd) {
    this.id = sessionId;
    this.label = cwd ? basename(cwd) : sessionId.slice(0, 8);
    this.cwd = cwd || "";
    this.color = SessionState.hueFromId(sessionId);
    this.status = "active";
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.source = null;

    this.pending = new Map();
    this.activity = [];
    this.messages = [];
    this.trustLevel = "paranoid";
    this.sessionRules = [];
    this.agents = [];
  }

  static hueFromId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  isStale(timeoutMs = 5 * 60 * 1000) {
    return (
      this.status === "active" && Date.now() - this.lastActivity > timeoutMs
    );
  }
}

// --- Trust tiers ---
const STANDARD_AUTO_APPROVE = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
]);
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*\//,
  /\brm\s+-rf?\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bcurl\b.*\|\s*sh\b/,
  /\bcurl\b.*\|\s*bash\b/,
  /\bsudo\b/,
  /\bgit\s+push\s+.*--force\b/,
];

function minimatch(str, pattern) {
  if (!pattern.includes("*")) return str === pattern;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$").test(str);
}

function shouldAutoApprove(session, toolName, toolInput) {
  if (toolName === "Request" || toolName === "AskUserQuestion") return false;

  // Paranoid = approve everything manually, session rules do not override
  if (session.trustLevel === "paranoid") return false;

  for (const rule of session.sessionRules) {
    if (rule.tool === toolName) {
      if (!rule.pattern) return true;
      const target =
        toolInput?.file_path || toolInput?.command || toolInput?.pattern || "";
      if (target.includes(rule.pattern) || minimatch(target, rule.pattern))
        return true;
    }
  }
  if (session.trustLevel === "standard")
    return STANDARD_AUTO_APPROVE.has(toolName);
  if (session.trustLevel === "autonomous") {
    if (toolName === "Bash" && toolInput?.command) {
      for (const pat of DANGEROUS_BASH_PATTERNS) {
        if (pat.test(toolInput.command)) return false;
      }
    }
    return true;
  }
  return false;
}

// --- Helpers ---
const MAX_BODY_SIZE = 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function summarizeResult(result) {
  if (!result) return null;
  const s = typeof result === "string" ? result : JSON.stringify(result);
  return s.slice(0, 500);
}

// ============================================================
// Server class
// ============================================================
// ── Verbose logging ──────────────────────────────────────────────────────────

const verbose = process.argv.includes("--verbose");
function vlog(...a) {
  if (!verbose) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] farmer: ${a.join(" ")}\n`);
}

// ── Routes manifest ──────────────────────────────────────────────────────────

const ROUTES = [
  {
    method: "GET",
    path: "/events",
    description: "SSE event stream for dashboard updates",
  },
  {
    method: "POST",
    path: "/hooks/permission",
    description: "Hook: permission request from AI agent",
  },
  {
    method: "POST",
    path: "/hooks/activity",
    description: "Hook: activity notification from AI agent",
  },
  {
    method: "POST",
    path: "/hooks/notification",
    description: "Hook: general notification from AI agent",
  },
  {
    method: "POST",
    path: "/hooks/lifecycle",
    description: "Hook: session lifecycle events",
  },
  {
    method: "POST",
    path: "/hooks/stop",
    description: "Hook: stop event from AI agent",
  },
  {
    method: "POST",
    path: "/api/decide",
    description: "Approve or deny a pending permission request",
  },
  {
    method: "POST",
    path: "/api/trust-level",
    description: "Set trust level for a session",
  },
  {
    method: "POST",
    path: "/api/rules",
    description: "Add auto-approve rules for a session",
  },
  {
    method: "POST",
    path: "/api/message",
    description: "Send a message to an agent session",
  },
  {
    method: "GET",
    path: "/api/claims",
    description: "Sprint claims data (if configured)",
  },
  {
    method: "GET",
    path: "/api/compilation",
    description: "Sprint compilation data (if configured)",
  },
  {
    method: "GET",
    path: "/api/state",
    description: "Full server state (sessions, pending, feedback)",
  },
  {
    method: "POST",
    path: "/api/feedback",
    description: "Submit feedback to the queue",
  },
  {
    method: "GET",
    path: "/api/feedback/poll",
    description: "Poll pending feedback items (localhost only)",
  },
  {
    method: "POST",
    path: "/api/feedback/ack",
    description: "Mark feedback items as delivered (localhost only)",
  },
  {
    method: "POST",
    path: "/api/feedback/read",
    description: "Legacy: mark all pending feedback as delivered",
  },
  { method: "POST", path: "/api/ask", description: "Ask an agent a question" },
  {
    method: "POST",
    path: "/api/switch-sprint",
    description: "Switch active sprint directory",
  },
  {
    method: "POST",
    path: "/api/admin/rotate-token",
    description: "Rotate the auth token",
  },
  {
    method: "GET",
    path: "/api/admin/invite",
    description: "Generate a signed invite URL for a role",
  },
  {
    method: "GET",
    path: "/invite",
    description: "Validate invite link and set auth cookie",
  },
  {
    method: "GET",
    path: "/api/sites",
    description: "List detected grainulation tool sites",
  },
  {
    method: "POST",
    path: "/hooks/harvest",
    description: "Hook: harvest analytics event",
  },
  {
    method: "GET",
    path: "/api/ecosystem",
    description: "Ecosystem tool health and orchard data",
  },
  {
    method: "GET",
    path: "/api/docs",
    description: "This API documentation page",
  },
];

export class FarmerServer {
  constructor(opts = {}) {
    this.port = opts.port || 9090;
    this.trustProxy = opts.trustProxy || false;
    this.maxSessions = opts.maxSessions || 50;

    this.adapter = opts.adapter || new ClaudeCodeAdapter();

    this.dataDir = opts.dataDir || process.cwd();
    this.persistence = new Persistence(this.dataDir);

    // Token persistence — read from .farmer-token (JSON or plain text for backwards compat)
    const tokenPath = join(this.dataDir, ".farmer-token");
    let adminToken = opts.token || "";
    let viewerToken = opts.viewerToken || "";
    if (!adminToken) {
      try {
        const raw = readFileSync(tokenPath, "utf8");
        const parsed = TokenManager.parseTokenFile(raw);
        adminToken = parsed.admin;
        viewerToken = viewerToken || parsed.viewer;
      } catch {}
    }
    this.tokenManager = new TokenManager({
      token: adminToken || undefined,
      viewerToken: viewerToken || undefined,
      rotationInterval: opts.tokenRotationInterval || 0,
      gracePeriod: opts.tokenGracePeriod || 60,
    });
    try {
      writeFileSync(tokenPath, JSON.stringify(this.tokenManager.toJSON()), {
        mode: 0o600,
      });
    } catch {}

    this.csrfManager = new CsrfManager();
    this.pidLock = new PidLock(join(this.dataDir, ".farmer.pid"));

    this.sessions = new Map();
    this.sessionBindings = new Map();
    this.lifecycleBuffer = new Map();

    this.registeredProjects = (opts.registeredProjects || []).map((p) =>
      resolve(p),
    );

    this.sseClients = new Map(); // Map<Response, { role: string, clientId: string }>

    this.MAX_ACTIVITY = 1000;

    this.ENDED_TTL = 5 * 60 * 1000;
    this.STALE_TTL = 30 * 60 * 1000;

    this.claimsPath = opts.claimsPath || "";
    this.compilationPath = opts.compilationPath || "";
    this.claimsData = null;
    this.compilationData = null;
    this.sprintsData = [];

    this.tunnelUrl = null;
    this.noTunnel = opts.noTunnel || false;
    this.noOpen = opts.noOpen || false;
    this.tunnelName = opts.tunnelName || "";
    this.tunnelHostname = opts.tunnelHostname || "";

    this.dashboardHtmlPath = opts.dashboardHtmlPath || "";

    // Rate limiting — fixed-window per-IP
    this._rateLimitStore = new Map();
    this._rateLimitOpts = {
      hooks: opts.rateLimit?.hooks ?? 60,
      api: opts.rateLimit?.api ?? 120,
    };

    // Feedback queue (session-agnostic pipeline)
    this._feedbackQueuePath = join(this.dataDir, ".farmer-feedback");
    this._feedbackQueue = this._loadFeedbackQueue();

    // Harvest analytics state
    this.harvestState = new Map();

    // Ecosystem config
    this.orchardJsonPath = opts.orchardJsonPath || "";

    this.server = null;
    this._timers = [];
  }

  // --- Startup ---
  start() {
    this.pidLock.acquire();

    const saved = this.persistence.loadState();
    if (saved) {
      for (const s of saved.sessions || []) {
        const session = this._getSession(s.id, s.cwd);
        if (!session) continue;
        session.trustLevel = s.trustLevel || "paranoid";
        session.sessionRules = s.sessionRules || [];
        session.activity = s.activity || [];
        session.messages = s.messages || [];
        if (s.label) session.label = s.label;
        if (s.color) session.color = s.color;
      }
    }

    this._loadClaims();
    this._loadSprints();
    if (this.claimsPath && existsSync(this.claimsPath)) {
      watchFile(this.claimsPath, { interval: 1000 }, () => {
        this._loadClaims();
        this._loadSprints();
      });
    }
    if (this.compilationPath && existsSync(this.compilationPath)) {
      watchFile(this.compilationPath, { interval: 1000 }, () => {
        this._loadCompilation();
      });
    }

    this.server = createServer((req, res) => this._handleRequest(req, res));

    this.server.on("error", (e) => {
      switch (e.code) {
        case "EADDRINUSE":
          console.error(`\n  Error: Port ${this.port} is already in use.`);
          console.error(
            `  Fix: Kill the existing process or use --port <other>`,
          );
          console.error(
            `  Tip: lsof -i :${this.port}  (to find what's using the port)\n`,
          );
          break;
        case "EACCES":
          console.error(`\n  Error: Permission denied for port ${this.port}.`);
          console.error(`  Fix: Use a port above 1024.\n`);
          break;
        default:
          console.error(
            `\n  Error: Server failed to start — ${e.code || e.message}\n`,
          );
      }
      process.exit(1);
    });

    this._timers.push(setInterval(() => this._heartbeat(), 10_000));
    this._timers.push(setInterval(() => this._detectStale(), 60_000));
    this._timers.push(setInterval(() => this._reapSessions(), 60_000));
    this._timers.push(
      setInterval(() => this.persistence.flushIfDirty(this.sessions), 30_000),
    );
    this._timers.push(setInterval(() => this._cleanLifecycleBuffer(), 15_000));
    this._timers.push(setInterval(() => this._cleanRateLimitStore(), 60_000));

    const shutdown = (signal) => this._shutdown(signal);
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("exit", () => this.pidLock.release());

    this.server.listen(this.port, "127.0.0.1", () => {
      vlog("listen", `port=${this.port}`, `dataDir=${this.dataDir}`);
      const token = this.tokenManager.token;
      const viewerToken = this.tokenManager.viewerToken;
      const localUrl = `http://localhost:${this.port}/?token=${token}`;
      const connectPage = `http://localhost:${this.port}/connect`;
      console.log(`\n  Farmer (${this.adapter.name} adapter)`);
      console.log(`  ${"─".repeat(48)}`);
      console.log(`  Local:   ${localUrl}`);
      console.log(`  Admin:   ${token}`);
      console.log(`  Viewer:  ${viewerToken}`);
      console.log(`  Hooks:  /hooks/permission  /hooks/activity`);
      console.log(`          /hooks/notification /hooks/lifecycle /hooks/stop`);
      console.log(`  SSE:    /events (real-time stream)`);
      console.log(`  Audit:  ${this.persistence.auditLogPath}`);
      this.persistence.auditLog({ event: "server_startup", port: this.port });

      // Hint: if no hooks detected, nudge user toward `farmer connect`
      if (!hasGlobalHooks() && !hasProjectHooks(process.cwd())) {
        console.log(`\n  No hooks detected. Run: farmer connect --global`);
      }

      if (!this.noTunnel) {
        this._startTunnel((err, publicUrl) => {
          if (err) {
            console.log(`\n  Tunnel:  not available (${err})`);
          } else {
            this.tunnelUrl = publicUrl;
            console.log(`\n  Tunnel:  ${publicUrl}/?token=${token}`);
          }
          console.log(`  Connect: ${connectPage}  (QR code for phone)`);
          console.log(`  Waiting for connections...\n`);
          if (!this.noOpen) this._openBrowser(localUrl);
        });
      } else {
        console.log(`\n  Connect: ${connectPage}  (QR code for phone)`);
        console.log(`  Waiting for connections...\n`);
        if (!this.noOpen) this._openBrowser(localUrl);
      }
    });
  }

  // --- Shutdown ---
  _shutdown(signal) {
    console.log(`\n  [${signal}] Shutting down...`);
    for (const [, session] of this.sessions) {
      for (const [, entry] of session.pending) {
        entry.resolve({
          allow: false,
          reason: `Server shutting down (${signal})`,
        });
      }
    }
    this.persistence.saveState(this.sessions, true);
    this.persistence.auditLog({ event: "server_shutdown", signal });
    this._broadcast({ type: "server_shutdown", data: { signal } });
    // Destroy all SSE connections so server.close() doesn't hang
    for (const [res] of this.sseClients) {
      try {
        res.end();
      } catch {}
    }
    this.sseClients.clear();
    for (const t of this._timers) clearInterval(t);
    this.tokenManager.destroy();
    this.csrfManager.destroy();
    this.pidLock.release();
    this.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000);
  }

  // --- Session management ---
  _getSession(sessionId, cwd, req) {
    const id = sessionId || "default";
    if (!this.sessions.has(id)) {
      if (this.sessions.size >= this.maxSessions) {
        let victim = null,
          victimAge = Infinity;
        for (const [vid, vs] of this.sessions) {
          if (vs.status === "ended" && vs.lastActivity < victimAge) {
            victim = vid;
            victimAge = vs.lastActivity;
          }
        }
        if (!victim) {
          for (const [vid, vs] of this.sessions) {
            if (vs.status === "stale" && vs.lastActivity < victimAge) {
              victim = vid;
              victimAge = vs.lastActivity;
            }
          }
        }
        if (victim) this._evictSession(victim);
        else {
          console.warn(`[gc] MAX_SESSIONS reached — rejecting ${id}`);
          return null;
        }
      }
      const session = new SessionState(id, cwd);
      // Inherit trust level from most recent active session (prevents paranoid reset on new sessions)
      let inheritedTrust = null;
      for (const [, existing] of this.sessions) {
        if (
          existing.status === "active" &&
          existing.trustLevel !== "paranoid"
        ) {
          if (
            !inheritedTrust ||
            existing.lastActivity > inheritedTrust.lastActivity
          ) {
            inheritedTrust = existing;
          }
        }
      }
      if (inheritedTrust) {
        session.trustLevel = inheritedTrust.trustLevel;
        session.sessionRules = [...inheritedTrust.sessionRules];
      }
      this.sessions.set(id, session);
      const fp = req
        ? sourceFingerprint(clientAddr(req, this.trustProxy), req._hookPid)
        : null;
      if (fp) this.sessionBindings.set(id, fp);
      this._broadcast({
        type: "session_new",
        session_id: id,
        data: this._sessionSummary(session),
      });
    } else if (req) {
      const fp = sourceFingerprint(
        clientAddr(req, this.trustProxy),
        req._hookPid,
      );
      const bound = this.sessionBindings.get(id);
      if (bound && fp && bound !== fp) {
        console.warn(`[security] Session binding mismatch for ${id}`);
        return null;
      }
    }
    const s = this.sessions.get(id);
    if (cwd && (!s.cwd || s.cwd !== cwd)) {
      s.cwd = cwd;
      s.label = basename(cwd);
    }
    s.touch();
    return s;
  }

  _evictSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const [, entry] of session.pending)
      entry.resolve({ allow: false, reason: "session evicted" });
    this.sessions.delete(id);
    this.sessionBindings.delete(id);
    this.lifecycleBuffer.delete(id);
    this._broadcast({
      type: "session_removed",
      session_id: id,
      data: { reason: "evicted" },
    });
  }

  _sessionSummary(s) {
    return {
      id: s.id,
      label: s.label,
      color: s.color,
      status: s.status,
      cwd: s.cwd,
      pending_count: s.pending.size,
      trust: s.trustLevel,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
    };
  }

  _allPending() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const [id, p] of session.pending) {
        result.push({
          id,
          ...p.data,
          timestamp: p.timestamp,
          session_id: session.id,
          session_label: session.label,
          session_color: session.color,
        });
      }
    }
    return result;
  }

  _allActivity() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const a of session.activity)
        result.push({ ...a, session_id: a.session_id || session.id });
    }
    result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return result.slice(-50);
  }

  _allMessages() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const m of session.messages)
        result.push({ ...m, session_id: session.id });
    }
    result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return result;
  }

  _allAgents() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const a of session.agents)
        result.push({ ...a, session_id: session.id });
    }
    return result;
  }

  _allSessionsSummary() {
    return [...this.sessions.values()].map((s) => this._sessionSummary(s));
  }

  _addActivity(session, event) {
    session.activity.push(event);
    if (session.activity.length > this.MAX_ACTIVITY) session.activity.shift();
    this.persistence.markDirty();
    this._broadcast({ type: "activity", session_id: session.id, data: event });
  }

  // --- Effective state (scans active sessions instead of hardcoding 'default') ---
  _getEffectiveState() {
    let best = null;
    for (const [, s] of this.sessions) {
      if (s.status === "ended") continue;
      if (!best || s.lastActivity > best.lastActivity) best = s;
    }
    return {
      trustLevel: best ? best.trustLevel : "paranoid",
      sessionRules: best ? best.sessionRules : [],
    };
  }

  // --- Project scope guard ---
  _isRegisteredProject(cwd) {
    if (!cwd) return true; // No cwd info — assume registered (backwards compat)
    if (this.registeredProjects.length === 0) return true; // No projects configured — allow all
    const resolved = resolve(cwd);
    return this.registeredProjects.some(
      (p) => resolved === p || resolved.startsWith(p + "/"),
    );
  }

  // --- Broadcast (SSE + WS) ---
  _broadcast(msg, roleFilter) {
    const data = JSON.stringify(msg);
    for (const [res, meta] of this.sseClients) {
      try {
        if (res.destroyed || res.writableEnded) {
          this.sseClients.delete(res);
          continue;
        }
        if (roleFilter && meta.role !== roleFilter) continue;
        res.write(`data: ${data}\n\n`);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  // --- Rate limiting (fixed-window per-IP, separate buckets) ---
  _rateLimitCheck(ip, bucket, limit) {
    // Skip localhost
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")
      return true;
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const entry = this._rateLimitStore.get(key);
    if (!entry || now - entry.windowStart > 60_000) {
      this._rateLimitStore.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }

  _rateLimitRetryAfter(ip, bucket) {
    const key = `${bucket}:${ip}`;
    const entry = this._rateLimitStore.get(key);
    if (!entry) return 1;
    const elapsed = Date.now() - entry.windowStart;
    return Math.max(1, Math.ceil((60_000 - elapsed) / 1000));
  }

  _cleanRateLimitStore() {
    const cutoff = Date.now() - 120_000;
    for (const [key, entry] of this._rateLimitStore) {
      if (entry.windowStart < cutoff) this._rateLimitStore.delete(key);
    }
  }

  // --- Feedback queue ---
  _loadFeedbackQueue() {
    try {
      const raw = readFileSync(this._feedbackQueuePath, "utf8");
      const parsed = JSON.parse(raw);
      // Migrate from old single-item {text, read} format to queue array
      if (Array.isArray(parsed)) return parsed;
      if (parsed && parsed.text) {
        return [
          {
            id: "migrated",
            text: parsed.text,
            timestamp: parsed.timestamp || Date.now(),
            status: parsed.read ? "delivered" : "pending",
          },
        ];
      }
    } catch {}
    return [];
  }

  _persistFeedbackQueue() {
    try {
      writeFileSync(
        this._feedbackQueuePath,
        JSON.stringify(this._feedbackQueue),
        "utf8",
      );
    } catch {}
  }

  // --- HTTP request handler ---
  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    // Security headers
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // CORS
    const origin = req.headers.origin || "";
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-CSRF-Token",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate limiting — apply before route dispatch for hooks and api paths
    const remoteIp = clientAddr(req, this.trustProxy);
    if (url.pathname.startsWith("/hooks/")) {
      if (!this._rateLimitCheck(remoteIp, "hooks", this._rateLimitOpts.hooks)) {
        const retryAfter = this._rateLimitRetryAfter(remoteIp, "hooks");
        res.writeHead(429, {
          "Retry-After": String(retryAfter),
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfter }));
        return;
      }
    } else if (url.pathname.startsWith("/api/")) {
      if (!this._rateLimitCheck(remoteIp, "api", this._rateLimitOpts.api)) {
        const retryAfter = this._rateLimitRetryAfter(remoteIp, "api");
        res.writeHead(429, {
          "Retry-After": String(retryAfter),
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfter }));
        return;
      }
    }

    // Auth helpers
    const cookies = this._parseCookies(req);
    const roleAuth = () => {
      // Priority 1: Authorization: Bearer <token> header (no token in URL/logs)
      const authHeader = req.headers["authorization"] || "";
      if (authHeader.startsWith("Bearer ")) {
        const role = this.tokenManager.matches(authHeader.slice(7));
        if (role) return { authenticated: true, role };
      }
      // Priority 2: Cookie auth (HttpOnly) — check role cookie for viewer, fall back to farmer_token
      const cookieRole = cookies["farmer_role"] || null;
      const cookieToken = cookies["farmer_token"];
      if (cookieToken) {
        const role = this.tokenManager.matches(cookieToken);
        if (role) return { authenticated: true, role };
      }
      // Priority 3: URL token fallback (for initial login, QR codes, hook endpoints)
      const urlToken = url.searchParams.get("token") || "";
      if (urlToken) {
        const role = this.tokenManager.matches(urlToken);
        if (role) return { authenticated: true, role };
      }
      return { authenticated: false, role: null };
    };
    const csrfOk = () => {
      if (
        req.method === "GET" ||
        req.method === "OPTIONS" ||
        req.method === "HEAD"
      )
        return true;
      return this.csrfManager.validate(req.headers["x-csrf-token"] || "");
    };

    vlog("request", req.method, url.pathname);

    // --- API: docs ---
    if (req.method === "GET" && url.pathname === "/api/docs") {
      const html = `<!DOCTYPE html><html><head><title>farmer API</title>
<style>body{font-family:system-ui;background:#0a0e1a;color:#e8ecf1;max-width:800px;margin:40px auto;padding:0 20px}
table{width:100%;border-collapse:collapse}th,td{padding:8px 12px;border-bottom:1px solid #1e293b;text-align:left}
th{color:#9ca3af}code{background:#1e293b;padding:2px 6px;border-radius:4px;font-size:13px}</style></head>
<body><h1>farmer API</h1><p>${ROUTES.length} endpoints</p>
<table><tr><th>Method</th><th>Path</th><th>Description</th></tr>
${ROUTES.map((r) => "<tr><td><code>" + r.method + "</code></td><td><code>" + r.path + "</code></td><td>" + r.description + "</td></tr>").join("")}
</table></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // --- SSE ---
    if (req.method === "GET" && url.pathname === "/events") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "identity",
      });
      res.flushHeaders();
      const csrfToken = this.csrfManager.generate();
      res.write(
        `data: ${JSON.stringify({ type: "init", data: { ...this._initPayload(csrfToken), role: auth.role } })}\n\n`,
      );
      if (this.claimsData)
        res.write(
          `data: ${JSON.stringify({ type: "claims", data: this.claimsData })}\n\n`,
        );
      if (this.compilationData)
        res.write(
          `data: ${JSON.stringify({ type: "compilation", data: this.compilationData })}\n\n`,
        );
      if (this.sprintsData.length)
        res.write(
          `data: ${JSON.stringify({ type: "sprints_list", data: this.sprintsData })}\n\n`,
        );
      const clientId = randomBytes(8).toString("hex");
      this.sseClients.set(res, { role: auth.role, clientId });
      vlog(
        "sse",
        `${auth.role} client connected (${this.sseClients.size} total)`,
      );
      req.on("close", () => {
        this.sseClients.delete(res);
        vlog("sse", `client disconnected (${this.sseClients.size} total)`);
      });
      return;
    }

    // --- Hook endpoints (localhost only) ---
    if (req.method === "POST" && url.pathname.startsWith("/hooks/")) {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Hook endpoints accept localhost only");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Request too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }

      if (data.pid) req._hookPid = String(data.pid);
      if (!data.session_id)
        data.session_id = deriveSessionId({ pid: data.pid, cwd: data.cwd });

      const hookType = url.pathname.split("/hooks/")[1];

      // Project scope guard — auto-allow hooks from non-registered projects
      // Never auto-allow requests/questions — they must wait for the user
      const isRequestTool =
        data.tool_name === "AskUserQuestion" || data.tool_name === "Request";
      if (
        hookType === "permission" &&
        !isRequestTool &&
        !this._isRegisteredProject(data.cwd)
      ) {
        const hookEvent = data.hook_event_name || "PreToolUse";
        const reason = `[scope] auto-allowed: cwd "${data.cwd}" is not a registered project`;
        console.log(reason);
        this.persistence.auditLog({
          event: "permission_decision",
          session_id: data.session_id || "unknown",
          tool_name: data.tool_name,
          decision: "auto-allow-scope",
          reason,
          cwd: data.cwd,
        });
        this._broadcast({
          type: "scope_auto_allow",
          data: {
            tool_name: data.tool_name || "unknown",
            cwd: data.cwd || "",
            timestamp: Date.now(),
          },
        });
        let responseBody;
        responseBody = {
          hookSpecificOutput: {
            hookEventName: hookEvent,
            permissionDecision: "allow",
            permissionDecisionReason: reason,
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }

      if (hookType === "permission")
        return this._handlePermission(data, res, req);
      if (hookType === "activity") return this._handleActivity(data, res, req);
      if (hookType === "notification")
        return this._handleNotification(data, res, req);
      if (hookType === "lifecycle")
        return this._handleLifecycle(data, res, req);
      if (hookType === "stop") return this._handleStop(data, res, req);
      if (hookType === "harvest") return this._handleHarvest(data, res);
      res.writeHead(404);
      res.end("Unknown hook");
      return;
    }

    // --- Dashboard API ---
    if (req.method === "POST" && url.pathname === "/api/decide") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      if (!csrfOk()) {
        res.writeHead(403);
        res.end("CSRF token invalid");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      return this._handleDecision(data, res);
    }

    if (req.method === "POST" && url.pathname === "/api/trust-level") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      if (!csrfOk()) {
        res.writeHead(403);
        res.end("CSRF token invalid");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      return this._handleTrustLevel(data, res);
    }

    if (req.method === "POST" && url.pathname === "/api/rules") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      if (!csrfOk()) {
        res.writeHead(403);
        res.end("CSRF token invalid");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      return this._handleRules(data, res);
    }

    if (req.method === "POST" && url.pathname === "/api/message") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      const session = this._getSession(
        data.session_id || deriveSessionId({ cwd: data.cwd }),
        data.cwd,
      );
      if (!session) {
        res.writeHead(503);
        res.end("Max sessions reached");
        return;
      }
      const msg = {
        type: "message",
        content: data.content || data.message || "",
        timestamp: Date.now(),
        session_id: session.id,
      };
      session.messages.push(msg);
      if (session.messages.length > 50) session.messages.shift();
      this._broadcast({ type: "message", session_id: session.id, data: msg });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // --- Claims endpoints (optional, wheat integration) ---
    if (req.method === "GET" && url.pathname === "/api/claims") {
      if (!roleAuth().authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.claimsData));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/compilation") {
      if (!roleAuth().authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.compilationData));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      const csrfToken = this.csrfManager.generate();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...this._initPayload(csrfToken),
          role: auth.role,
          messages: this._allMessages(),
        }),
      );
      return;
    }

    // --- Feedback queue: user sends notes from mobile, Claude polls to receive them ---
    // POST /api/feedback — mobile submits feedback (authed, remote OK)
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      const text = (data.content || "").trim();
      if (!text) {
        res.writeHead(400);
        res.end("Empty feedback");
        return;
      }

      const item = {
        id: randomBytes(4).toString("hex"),
        text,
        timestamp: Date.now(),
        status: "pending", // pending -> delivered -> expired
      };
      this._feedbackQueue.push(item);
      this._persistFeedbackQueue();

      this.persistence.auditLog({ event: "user_feedback", content: text });
      this._broadcast({
        type: "user_feedback",
        data: { text, timestamp: Date.now() },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: item.id }));
      return;
    }

    // GET /api/feedback/poll — Claude's dedicated feedback pipeline (localhost only)
    if (req.method === "GET" && url.pathname === "/api/feedback/poll") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }

      const now = Date.now();
      const STALE_MS = 5 * 60 * 1000;
      const EXPIRE_MS = 30 * 60 * 1000;

      const pending = [];
      let expiredAny = false;
      for (const item of this._feedbackQueue) {
        if (item.status !== "pending") continue;
        const age = now - item.timestamp;
        if (age > EXPIRE_MS) {
          item.status = "expired";
          expiredAny = true;
          continue;
        }
        const stalePrefix =
          age > STALE_MS ? `[sent ${Math.round(age / 60000)}m ago] ` : "";
        pending.push({
          id: item.id,
          text: stalePrefix + item.text,
          timestamp: item.timestamp,
        });
      }
      if (expiredAny) this._persistFeedbackQueue();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: pending }));
      return;
    }

    // POST /api/feedback/ack — mark feedback items as delivered (localhost only)
    if (req.method === "POST" && url.pathname === "/api/feedback/ack") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      const ids = data.ids || [];
      const now = Date.now();
      let acked = 0;
      for (const item of this._feedbackQueue) {
        if (ids.includes(item.id) && item.status === "pending") {
          item.status = "delivered";
          item.delivered_at = now;
          acked++;
        }
      }
      if (acked > 0) {
        this._persistFeedbackQueue();
        this._broadcast({ type: "feedback_read", data: {} });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, acked }));
      return;
    }

    // POST /api/feedback/read — legacy compat, marks all pending as delivered
    if (req.method === "POST" && url.pathname === "/api/feedback/read") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }
      const pendingItems = this._feedbackQueue.filter(
        (f) => f.status === "pending",
      );
      const texts = pendingItems.map((f) => f.text);
      pendingItems.forEach((f) => {
        f.status = "delivered";
        f.delivered_at = Date.now();
      });
      if (pendingItems.length > 0) this._persistFeedbackQueue();
      this._broadcast({ type: "feedback_read", data: {} });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, text: texts.join("\n") }));
      return;
    }

    // --- Ask endpoint: POST a question from Claude, hold until user responds ---
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      const session = this._getSession(
        data.session_id || deriveSessionId({ cwd: data.cwd }),
        data.cwd,
      );
      if (!session) {
        res.writeHead(503);
        res.end("Max sessions reached");
        return;
      }
      const requestId = randomBytes(8).toString("hex");
      const event = {
        requestId,
        tool_name: "Request",
        tool_input: { prompt: data.question || data.prompt || "" },
        session_id: session.id,
        session_label: session.label,
        session_color: session.color,
        options: data.options || [],
        timestamp: Date.now(),
      };
      this._broadcast({
        type: "permission_request",
        session_id: session.id,
        data: event,
      });
      const timeout = setTimeout(() => {
        if (session.pending.has(requestId)) {
          session.pending.delete(requestId);
          this._broadcast({
            type: "permission_expired",
            session_id: session.id,
            data: { requestId },
          });
          res.writeHead(408, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "timeout", response: "" }));
        }
      }, 120_000);
      session.pending.set(requestId, {
        resolve: (decision) => {
          clearTimeout(timeout);
          session.pending.delete(requestId);
          this._broadcast({
            type: "permission_resolved",
            session_id: session.id,
            data: { requestId, decision: "answered" },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              response: decision.reason || decision.response || "",
            }),
          );
        },
        data: event,
        timestamp: Date.now(),
      });
      return;
    }

    // --- /connect: QR code page for phone pairing ---
    if (req.method === "GET" && url.pathname === "/connect") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }
      const auth = roleAuth();
      if (!auth.authenticated || auth.role !== "admin") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body><h1>404</h1><p>Not Found</p></body></html>");
        return;
      }
      const adminToken = this.tokenManager.token;
      const viewerToken = this.tokenManager.viewerToken;
      const base = this.tunnelUrl || `http://localhost:${this.port}`;
      const adminUrl = `${base}/?token=${adminToken}`;
      const viewerUrl = `${base}/?token=${viewerToken}`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(this._connectPage(adminUrl, viewerUrl));
      return;
    }

    // --- /api/new-tunnel: restart CF tunnel and return new QR page ---
    if (req.method === "POST" && url.pathname === "/api/new-tunnel") {
      const remoteAddr = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) {
        res.writeHead(403);
        res.end("Localhost only");
        return;
      }
      this._startTunnel((err, publicUrl) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err }));
          return;
        }
        this.tunnelUrl = publicUrl;
        const base = publicUrl || `http://localhost:${this.port}`;
        const adminUrl = `${base}/?token=${this.tokenManager.token}`;
        const viewerUrl = `${base}/?token=${this.tokenManager.viewerToken}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: adminUrl, adminUrl, viewerUrl }));
      });
      return;
    }

    // --- Sprint switching ---
    if (req.method === "POST" && url.pathname === "/api/switch-sprint") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      if (!csrfOk()) {
        res.writeHead(403);
        res.end("CSRF token invalid");
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("Too large");
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
        return;
      }
      const target = this.sprintsData.find((s) => s.slug === data.slug);
      if (!target) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: "Sprint not found" }));
        return;
      }
      const repoRoot = this.claimsPath
        ? resolve(dirname(this.claimsPath))
        : this.dataDir;
      const sprintDir =
        target.path === "." ? repoRoot : join(repoRoot, target.path);
      try {
        const sprintClaims = join(sprintDir, "claims.json");
        const sprintComp = join(sprintDir, "compilation.json");
        if (existsSync(sprintClaims)) {
          this.claimsData = JSON.parse(readFileSync(sprintClaims, "utf8"));
          this._broadcast({ type: "claims", data: this.claimsData });
        }
        if (existsSync(sprintComp)) {
          this.compilationData = JSON.parse(readFileSync(sprintComp, "utf8"));
          this._broadcast({ type: "compilation", data: this.compilationData });
        }
        this.sprintsData = this.sprintsData.map((s) => ({
          ...s,
          active: s.slug === data.slug,
        }));
        this._broadcast({ type: "sprints_list", data: this.sprintsData });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/rotate-token") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      if (!csrfOk()) {
        res.writeHead(403);
        res.end("CSRF token invalid");
        return;
      }
      const newToken = this.tokenManager.rotate((msg) =>
        this._broadcast(msg, "admin"),
      );
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `farmer_token=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- Ecosystem endpoint: orchard portfolio + tool health ---
    if (req.method === "GET" && url.pathname === "/api/ecosystem") {
      if (!roleAuth().authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      let orchardData = null;
      const orchardPath =
        this.orchardJsonPath ||
        (this.claimsPath
          ? join(resolve(dirname(this.claimsPath)), "orchard.json")
          : "");
      if (orchardPath) {
        try {
          if (existsSync(orchardPath))
            orchardData = JSON.parse(readFileSync(orchardPath, "utf8"));
        } catch {}
      }

      // Probe tool ports in parallel with 2s timeout
      const probes = Object.entries(ECOSYSTEM_PORTS).map(
        async ([name, port]) => {
          if (name === "farmer")
            return [name, { port, alive: true, latencyMs: 0 }];
          const start = Date.now();
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2000);
            const r = await fetch(`http://127.0.0.1:${port}/health`, {
              signal: ctrl.signal,
            });
            clearTimeout(timer);
            return [name, { port, alive: r.ok, latencyMs: Date.now() - start }];
          } catch {
            return [
              name,
              { port, alive: false, latencyMs: Date.now() - start },
            ];
          }
        },
      );

      const results = await Promise.allSettled(probes);
      const tools = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          const [name, info] = r.value;
          tools.push({ name, ...info });
        }
      }

      res.writeHead(200, {
        "Content-Type": "application/json",
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify({ tools, orchard: orchardData }));
      return;
    }

    // --- Configurable sites ---
    if (req.method === "GET" && url.pathname === "/api/sites") {
      if (!roleAuth().authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify(this._loadSites()));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/sites/")) {
      if (!roleAuth().authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      const siteName = url.pathname.replace("/sites/", "").split("/")[0];
      const sites = this._loadSites();
      const site = sites.find((s) => s.name === siteName);
      if (!site) {
        res.writeHead(404);
        res.end("Site not found");
        return;
      }
      if (site.url) {
        // External URL — redirect
        res.writeHead(302, { Location: site.url });
        res.end();
        return;
      }
      if (site.path) {
        const filePath = resolve(site._basedir || ".", site.path);
        try {
          const content = readFileSync(filePath, "utf8");
          res.writeHead(200, {
            "Content-Type": "text/html",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(content);
          return;
        } catch {
          res.writeHead(404);
          res.end(`Site not found for ${siteName}`);
          return;
        }
      }
      res.writeHead(404);
      res.end("No path or url for site");
      return;
    }

    // --- Serve output artifacts ---
    if (req.method === "GET" && url.pathname.startsWith("/output/")) {
      if (!roleAuth().authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      const fileName = url.pathname.replace("/output/", "");
      if (
        fileName.includes("..") ||
        fileName.includes("/") ||
        !fileName.match(/^[\w.-]+$/)
      ) {
        res.writeHead(400);
        res.end("Invalid filename");
        return;
      }
      const outputDir = this.claimsPath
        ? resolve(this.claimsPath, "..", "output")
        : join(this.dataDir, "output");
      const filePath = join(outputDir, fileName);
      try {
        const content = readFileSync(filePath, "utf8");
        const ext = fileName.split(".").pop();
        const mime =
          {
            html: "text/html",
            md: "text/plain",
            json: "application/json",
            pdf: "application/pdf",
          }[ext] || "text/plain";
        res.writeHead(200, { "Content-Type": mime });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // --- Serve PWA assets ---
    if (
      req.method === "GET" &&
      (url.pathname === "/sw.js" || url.pathname === "/manifest.json")
    ) {
      const file = url.pathname.slice(1);
      const filePath = join(PUBLIC_DIR, file);
      try {
        const content = readFileSync(filePath, "utf8");
        const mime = file.endsWith(".js")
          ? "application/javascript"
          : "application/json";
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-cache",
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // --- Serve dashboard ---
    // --- Invite endpoint: validate HMAC, set cookie, redirect ---
    if (req.method === "GET" && url.pathname === "/invite") {
      const inviteRole = url.searchParams.get("role");
      const exp = parseInt(url.searchParams.get("exp") || "0", 10);
      const sig = url.searchParams.get("sig") || "";
      if (!inviteRole || !exp || !sig) {
        res.writeHead(400);
        res.end("Invalid invite link");
        return;
      }
      if (Date.now() > exp) {
        res.writeHead(410);
        res.end("Invite link expired");
        return;
      }
      if (!this.tokenManager.verifyInvite(inviteRole, exp, sig)) {
        res.writeHead(403);
        res.end("Invalid invite signature");
        return;
      }
      const token =
        inviteRole === "admin"
          ? this.tokenManager.token
          : this.tokenManager.viewerToken;
      res.writeHead(302, {
        "Set-Cookie": [
          `farmer_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
          `farmer_role=${inviteRole}; SameSite=Strict; Path=/; Max-Age=86400`,
        ],
        Location: "/",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    // --- Admin invite generation ---
    if (req.method === "GET" && url.pathname === "/api/admin/invite") {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      if (auth.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Viewer role cannot perform this action" }),
        );
        return;
      }
      const inviteRole = url.searchParams.get("role") || "viewer";
      if (!["admin", "viewer"].includes(inviteRole)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid role" }));
        return;
      }
      const exp = Date.now() + 24 * 60 * 60 * 1000; // 24h
      const sig = this.tokenManager.signInvite(inviteRole, exp);
      const base = this.tunnelUrl || `http://localhost:${this.port}`;
      const inviteUrl = `${base}/invite?role=${inviteRole}&exp=${exp}&sig=${sig}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ url: inviteUrl, role: inviteRole, expiresAt: exp }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === "/desktop" ||
        url.pathname === "/m" ||
        url.pathname === "/mobile")
    ) {
      const auth = roleAuth();
      if (!auth.authenticated) {
        res.writeHead(200, {
          "Content-Type": "text/html",
          ...SECURITY_HEADERS,
        });
        res.end(this._loginPage());
        return;
      }
      const urlToken = url.searchParams.get("token");
      if (urlToken) {
        const tokenToSet =
          auth.role === "admin"
            ? this.tokenManager.token
            : this.tokenManager.viewerToken;
        res.writeHead(302, {
          "Set-Cookie": [
            `farmer_token=${tokenToSet}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
            `farmer_role=${auth.role}; SameSite=Strict; Path=/; Max-Age=86400`,
          ],
          Location: "/",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        ...SECURITY_HEADERS,
      });
      res.end(this._dashboardPage(auth.role));
      return;
    }

    // --- Static files from public/ ---
    if (req.method === "GET" && url.pathname.startsWith("/")) {
      const safeName = url.pathname.slice(1).replace(/\.\./g, "");
      if (safeName && !safeName.includes("/")) {
        const filePath = join(PUBLIC_DIR, safeName);
        if (existsSync(filePath)) {
          const ext = safeName.split(".").pop();
          const mime =
            {
              js: "application/javascript",
              css: "text/css",
              json: "application/json",
              html: "text/html",
              png: "image/png",
              svg: "image/svg+xml",
            }[ext] || "text/plain";
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": "no-cache",
          });
          res.end(readFileSync(filePath));
          return;
        }
      }
    }

    res.writeHead(404);
    res.end("Not found");
  }

  // --- Permission handling ---
  _handlePermission(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (!session) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Session rejected" }));
      return;
    }

    const parsed = this.adapter.parseRequest(data);
    const requestId = parsed.requestId || randomBytes(8).toString("hex");
    const { toolName, toolInput, hookEvent, isQuestion } = parsed;

    // Agent tracking
    if (toolName === "Agent") {
      session.agents.push({
        id: requestId,
        description: toolInput?.description || "",
        status: "running",
        startedAt: Date.now(),
      });
      this._broadcast({
        type: "agent_start",
        session_id: session.id,
        data: { id: requestId },
      });
    }

    // Auto-approve check
    if (shouldAutoApprove(session, toolName, toolInput)) {
      const reason = `Auto-approved by ${session.trustLevel} trust level`;
      const pendingFeedback = this._consumePendingFeedback();
      let responseBody;
      if (hookEvent === "PreToolUse") {
        const output = {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
        };
        if (pendingFeedback) {
          output.additionalContext = `[USER FEEDBACK from Farmer mobile dashboard]: "${pendingFeedback}" — The user sent this from their phone and cannot see CLI output. Acknowledge and act on this feedback.`;
        }
        responseBody = { hookSpecificOutput: output };
      } else {
        responseBody = this.adapter.formatAutoApproveResponse(reason, {
          hookEvent,
        });
      }
      this._addActivity(session, {
        type: "decision",
        tool_name: toolName,
        tool_input: toolInput,
        decision: "auto-allowed",
        reason,
        session_id: session.id,
        timestamp: Date.now(),
      });
      this.persistence.auditLog({
        event: "permission_decision",
        session_id: session.id,
        tool_name: toolName,
        decision: "auto-allow",
        reason,
        requestId,
      });
      this._broadcast({
        type: "auto_approved",
        session_id: session.id,
        data: { requestId, tool_name: toolName, reason },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
      return;
    }

    // No-dashboard guard (stale server protection)
    // Never auto-approve requests/questions — they must wait for the user
    if (
      this.sseClients.size === 0 &&
      !isQuestion &&
      toolName !== "AskUserQuestion" &&
      toolName !== "Request"
    ) {
      const reason =
        "Auto-approved: no dashboard clients connected (stale server guard)";
      const pendingFeedback = this._consumePendingFeedback();
      let responseBody;
      if (hookEvent === "PreToolUse") {
        const output = {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
        };
        if (pendingFeedback)
          output.additionalContext = `[USER FEEDBACK from Farmer mobile dashboard]: "${pendingFeedback}" — The user sent this from their phone. Acknowledge and act on this feedback.`;
        responseBody = { hookSpecificOutput: output };
      } else {
        responseBody = this.adapter.formatAutoApproveResponse(reason, {
          hookEvent,
        });
      }
      this._addActivity(session, {
        type: "decision",
        tool_name: toolName,
        tool_input: toolInput,
        decision: "auto-allowed",
        reason,
        session_id: session.id,
        timestamp: Date.now(),
      });
      this.persistence.auditLog({
        event: "permission_decision",
        session_id: session.id,
        tool_name: toolName,
        decision: "auto-allow-no-dashboard",
        reason,
        requestId,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
      return;
    }

    // Enqueue for dashboard approval
    const event = {
      requestId,
      tool_name: toolName,
      tool_input: toolInput,
      isQuestion,
      session_id: session.id,
      session_label: session.label,
      session_color: session.color,
      permission_mode: data.permission_mode,
      cwd: data.cwd,
      hook_event_name: hookEvent,
      permission_suggestions: data.permission_suggestions,
    };

    this._broadcast({
      type: "permission_request",
      session_id: session.id,
      data: event,
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (session.pending.has(requestId) && !resolved) {
        resolved = true;
        session.pending.delete(requestId);
        this._broadcast({
          type: "permission_expired",
          session_id: session.id,
          data: { requestId },
        });
        const denyBody = this.adapter.formatTimeoutResponse({ hookEvent });
        this.persistence.auditLog({
          event: "permission_decision",
          session_id: session.id,
          tool_name: toolName,
          decision: "timeout",
          requestId,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(denyBody));
      }
    }, 120_000);

    session.pending.set(requestId, {
      resolve: (decision) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        session.pending.delete(requestId);

        const responseBody = this.adapter.formatResponse(decision, {
          hookEvent,
          isQuestion,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));

        this._addActivity(session, {
          type: "decision",
          tool_name: toolName,
          tool_input: toolInput,
          decision: decision.allow ? "allowed" : "denied",
          reason: decision.reason,
          session_id: session.id,
          timestamp: Date.now(),
        });
        this.persistence.auditLog({
          event: "permission_decision",
          session_id: session.id,
          tool_name: toolName,
          decision: decision.allow ? "allow" : "deny",
          reason: decision.reason,
          requestId,
        });
        this._broadcast({
          type: "permission_resolved",
          session_id: session.id,
          data: { requestId, decision: decision.allow ? "allowed" : "denied" },
        });
      },
      data: event,
      timestamp: Date.now(),
    });
  }

  // --- Activity handling ---
  _handleActivity(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (!session) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Max sessions reached" }));
      return;
    }

    if (data.tool_name === "Agent") {
      const agentId = data.tool_use_id || randomBytes(8).toString("hex");
      const a = session.agents.find((x) => x.id === agentId);
      if (a) {
        a.status = "done";
        a.stoppedAt = Date.now();
      }
      this._broadcast({
        type: "agent_stop",
        session_id: session.id,
        data: { id: agentId },
      });
    }

    const activityType =
      data.hook_event_name === "PostToolUseFailure" ? "failure" : "success";
    this._addActivity(session, {
      type: activityType,
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_result: data.tool_result ? summarizeResult(data.tool_result) : null,
      session_id: session.id,
      timestamp: Date.now(),
    });
    this.persistence.auditLog({
      event: "activity",
      session_id: session.id,
      tool_name: data.tool_name,
      hook_event_name: data.hook_event_name,
      result: activityType,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  }

  // --- Notification handling ---
  _handleNotification(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (!session) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Max sessions reached" }));
      return;
    }

    const notif = this.adapter.parseNotification(data);
    const event = {
      requestId: data.tool_use_id || randomBytes(8).toString("hex"),
      type: "question",
      tool_name: notif.toolName,
      prompt: notif.prompt,
      session_id: session.id,
      session_label: session.label,
      session_color: session.color,
      hook_event_name: notif.hookEvent,
      timestamp: Date.now(),
    };

    this._broadcast({
      type: "notification_card",
      session_id: session.id,
      data: event,
    });
    this._addActivity(session, {
      type: "notification",
      tool_name: notif.toolName,
      tool_input: { prompt: notif.prompt },
      session_id: session.id,
      timestamp: Date.now(),
    });
    this.persistence.auditLog({
      event: "notification",
      session_id: session.id,
      tool_name: notif.toolName,
      hook_event_name: notif.hookEvent,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  }

  // --- Lifecycle handling ---
  _handleLifecycle(data, res, req) {
    const lc = this.adapter.parseLifecycle(data);
    if (lc.event === "session_start") {
      const session = this._getSession(lc.sessionId, lc.cwd, req);
      if (!session) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "Max sessions reached" }));
        return;
      }
      session.source = lc.source;
      session.status = "active";
      this._broadcast({
        type: "session_start",
        session_id: lc.sessionId,
        data: this._sessionSummary(session),
      });
      // Replay buffered events
      const buffered = this.lifecycleBuffer.get(lc.sessionId);
      if (buffered?.length) {
        this.lifecycleBuffer.delete(lc.sessionId);
        for (const item of buffered)
          this._processSessionEnd(item.data, session);
      }
      // PostCompact context re-injection
      const output = {};
      if (lc.source === "compact") {
        try {
          const ctx = this._buildCompactContext(lc.cwd);
          if (ctx) {
            output.additionalContext = ctx.text;
            this.persistence.auditLog({
              event: "compact_context_injected",
              session_id: lc.sessionId,
              hash: ctx.hash,
            });
            this._broadcast({
              type: "session_compact",
              session_id: lc.sessionId,
              data: { hash: ctx.hash, stale: ctx.stale },
            });
          }
        } catch (err) {
          console.error(`[compact] Failed to build context: ${err.message}`);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(output));
      return;
    } else if (lc.event === "session_end") {
      const session = this.sessions.get(lc.sessionId);
      if (session) {
        this._processSessionEnd(data, session);
      } else {
        if (!this.lifecycleBuffer.has(lc.sessionId))
          this.lifecycleBuffer.set(lc.sessionId, []);
        this.lifecycleBuffer
          .get(lc.sessionId)
          .push({ data, receivedAt: Date.now() });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  }

  _processSessionEnd(data, session) {
    session.status = "ended";
    session.endedAt = Date.now();
    session.endReason = data.reason;
    for (const [, entry] of session.pending)
      entry.resolve({ allow: false, reason: "session ended" });
    this.sessionBindings.delete(session.id);
    this._broadcast({
      type: "session_end",
      session_id: session.id,
      data: { reason: data.reason },
    });
  }

  // --- Stop hook handling (feedback delivery when Claude is idle) ---
  _handleStop(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (session) {
      session.status = "idle";
      session.lastStopAt = Date.now();
      this._broadcast({
        type: "session_idle",
        session_id: data.session_id,
        data: { timestamp: Date.now() },
      });
    }

    const pendingFeedback = this._consumePendingFeedback();
    const output = {};
    if (pendingFeedback) {
      output.additionalContext = `[USER FEEDBACK from Farmer mobile dashboard]: "${pendingFeedback}" -- The user sent this from their phone. Acknowledge and act on this feedback.`;
    }

    this.persistence.auditLog({
      event: "stop_hook",
      session_id: data.session_id || "unknown",
      had_feedback: !!pendingFeedback,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(output));
  }

  // --- Compact context builder (delegates to lib/compact-context.js) ---
  _buildCompactContext(cwd) {
    return buildCompactContext(cwd, ECOSYSTEM_PORTS);
  }

  // --- Harvest analytics hook ---
  _handleHarvest(data, res) {
    const htype = data.type;
    const sprint = data.sprint;
    if (!htype || !sprint || !data.data) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Missing required fields: type, sprint, data",
        }),
      );
      return;
    }
    if (!HARVEST_TYPES.has(htype)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Invalid harvest type: ${htype}. Expected: health, decay, insight, digest`,
        }),
      );
      return;
    }
    // Store latest per sprint+type
    if (!this.harvestState.has(sprint)) this.harvestState.set(sprint, {});
    this.harvestState.get(sprint)[htype] = {
      ...data.data,
      timestamp: Date.now(),
    };
    this.persistence.auditLog({
      event: `harvest_${htype}`,
      sprint,
      data: data.data,
    });
    this._broadcast({
      type: `harvest_${htype}`,
      data: { sprint, ...data.data, timestamp: Date.now() },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  }

  // --- Decision from browser ---
  _handleDecision(data, res) {
    const { requestId, allow, reason, response } = data;
    let found = null;
    for (const [, session] of this.sessions) {
      if (session.pending.has(requestId)) {
        found = session.pending.get(requestId);
        break;
      }
    }
    if (!found) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request not found or expired" }));
      return;
    }
    if (found.data.isQuestion) {
      found.resolve({ response: response || "" });
    } else {
      found.resolve({ allow, reason });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  // --- Trust level ---
  _handleTrustLevel(data, res) {
    const valid = ["paranoid", "standard", "autonomous"];
    if (!valid.includes(data.level)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid level" }));
      return;
    }
    if (data.session_id && this.sessions.has(data.session_id)) {
      const session = this.sessions.get(data.session_id);
      session.trustLevel = data.level;
      this._broadcast({
        type: "trust_level",
        session_id: session.id,
        data: { level: data.level },
      });
    } else {
      for (const [, session] of this.sessions) session.trustLevel = data.level;
      this._broadcast({ type: "trust_level", data: { level: data.level } });
    }
    this.persistence.saveState(this.sessions);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, level: data.level }));
  }

  // --- Session rules ---
  _handleRules(data, res) {
    const { action } = data;
    // Support batch rules: rules: [...] (plural) or rule: {...} (singular) (d002)
    const ruleList = Array.isArray(data.rules)
      ? data.rules
      : data.rule
        ? [data.rule]
        : [];
    if (ruleList.length === 0 || !ruleList.every((r) => r.tool)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "rule.tool required" }));
      return;
    }
    const targets =
      data.session_id && this.sessions.has(data.session_id)
        ? [this.sessions.get(data.session_id)]
        : [...this.sessions.values()];
    if (targets.length === 0) targets.push(this._getSession("default"));

    for (const rule of ruleList) {
      for (const session of targets) {
        if (action === "add") {
          const exists = session.sessionRules.find(
            (r) =>
              r.tool === rule.tool &&
              (r.pattern || "") === (rule.pattern || ""),
          );
          if (!exists)
            session.sessionRules.push({
              tool: rule.tool,
              pattern: rule.pattern || null,
            });
        } else if (action === "remove") {
          const idx = session.sessionRules.findIndex(
            (r) =>
              r.tool === rule.tool &&
              (r.pattern || "") === (rule.pattern || ""),
          );
          if (idx !== -1) session.sessionRules.splice(idx, 1);
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "action must be add or remove" }));
          return;
        }
      }
    }
    this.persistence.saveState(this.sessions);
    // Single broadcast for all rule changes (d002)
    this._broadcast({
      type: "rules_updated",
      data: { sessionRules: targets[0].sessionRules },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, sessionRules: targets[0].sessionRules }),
    );
  }

  // --- Claims loading (optional wheat integration) ---
  _loadClaims() {
    if (!this.claimsPath) return;
    try {
      if (existsSync(this.claimsPath)) {
        this.claimsData = JSON.parse(readFileSync(this.claimsPath, "utf8"));
        this._broadcast({ type: "claims", data: this.claimsData });
      }
    } catch {}
    this._loadCompilation();
  }

  _loadCompilation() {
    if (!this.compilationPath) return;
    try {
      if (existsSync(this.compilationPath)) {
        this.compilationData = JSON.parse(
          readFileSync(this.compilationPath, "utf8"),
        );
        this._broadcast({ type: "compilation", data: this.compilationData });
      }
    } catch {}
  }

  _loadSprints() {
    if (!this.claimsPath) return;
    const repoRoot = resolve(dirname(this.claimsPath));
    try {
      const require_ = createRequire(import.meta.url);
      const mod = require_(join(repoRoot, "detect-sprints.js"));
      if (mod?.detectSprints) {
        const { sprints } = mod.detectSprints(repoRoot);
        this.sprintsData = sprints.map((s) => ({
          slug: s.name,
          path: s.path,
          question: s.question,
          phase: s.phase,
          claimCount: s.claims_count,
          active: s.status === "active",
          lastModified: s.last_git_activity,
        }));
        this._broadcast({ type: "sprints_list", data: this.sprintsData });
      }
    } catch {}
  }

  // --- Feedback injection (consumes oldest pending item for auto-approve piggyback) ---
  _consumePendingFeedback() {
    const pending = this._feedbackQueue.filter((f) => f.status === "pending");
    if (pending.length === 0) return null;
    const item = pending[0];
    item.status = "delivered";
    item.delivered_at = Date.now();
    this._persistFeedbackQueue();
    this._broadcast({ type: "feedback_read", data: {} });
    return item.text;
  }

  // --- Init payload (shared between SSE + WS) ---
  _initPayload(csrfToken) {
    const effective = this._getEffectiveState();
    return {
      pending: this._allPending(),
      activity: this._allActivity(),
      claims: null,
      compilation: null,
      trustLevel: effective.trustLevel,
      sessionRules: effective.sessionRules,
      agents: this._allAgents(),
      sessions: this._allSessionsSummary(),
      csrfToken,
    };
  }

  // --- Timers ---
  _heartbeat() {
    const heartbeats = [];
    for (const [id, session] of this.sessions) {
      if (session.status === "ended") continue;
      heartbeats.push({
        id,
        label: session.label,
        status: session.status,
        lastActivity: session.lastActivity,
        pending_count: session.pending.size,
        oldest_pending:
          session.pending.size > 0
            ? Math.min(...[...session.pending.values()].map((p) => p.timestamp))
            : null,
      });
    }
    if (heartbeats.length > 0 || this.sseClients.size > 0) {
      this._broadcast({
        type: "heartbeat",
        data: { serverTime: Date.now(), sessions: heartbeats },
      });
    }
  }

  _detectStale() {
    for (const [id, session] of this.sessions) {
      if (session.isStale()) {
        session.status = "stale";
        this._broadcast({
          type: "session_stale",
          session_id: id,
          data: this._sessionSummary(session),
        });
      }
    }
  }

  _reapSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const age = now - session.lastActivity;
      if (
        (session.status === "ended" && age > this.ENDED_TTL) ||
        (session.status === "stale" && age > this.STALE_TTL)
      ) {
        this._evictSession(id);
      }
    }
  }

  _cleanLifecycleBuffer() {
    const now = Date.now();
    for (const [sid, items] of this.lifecycleBuffer) {
      const fresh = items.filter((i) => now - i.receivedAt < 30_000);
      if (fresh.length === 0) this.lifecycleBuffer.delete(sid);
      else this.lifecycleBuffer.set(sid, fresh);
    }
  }

  // --- HTML pages ---
  _parseCookies(req) {
    const h = req.headers.cookie || "";
    const map = {};
    h.split(";").forEach((c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) map[k] = v.join("=");
    });
    return map;
  }

  _loginPage() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Farmer</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%230a0e1a'/><text x='32' y='34' text-anchor='middle' dominant-baseline='central' fill='%233b82f6' font-family='-apple-system,system-ui,sans-serif' font-size='34' font-weight='800'>F</text></svg>">
<meta name="theme-color" content="#0a0e1a">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0e1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;height:100dvh;margin:0}
.login{background:rgba(30,41,59,0.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:40px;border-radius:16px;border:1px solid rgba(59,130,246,0.15);max-width:380px;width:90%}
.logo{font-size:28px;font-weight:800;margin-bottom:4px;background:linear-gradient(135deg,#fff 0%,#94a3b8 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#64748b;font-size:13px;margin-bottom:24px}
input{width:100%;padding:12px 14px;border:1px solid rgba(59,130,246,0.2);background:rgba(10,14,26,0.8);color:#f1f5f9;border-radius:10px;font-size:16px;margin-bottom:14px;outline:none;box-sizing:border-box}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.15)}
button{width:100%;padding:12px;background:#3b82f6;color:white;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;letter-spacing:0.02em}
button:hover{filter:brightness(1.1)}
button:active{transform:scale(0.98)}
</style></head><body>
<div class="login"><div class="logo">Farmer</div><p>Enter the dashboard token from your terminal.</p>
<form onsubmit="location.href='/?token='+document.getElementById('t').value;return false;">
<input id="t" type="password" placeholder="Token" autofocus><button type="submit">Connect</button></form></div></body></html>`;
  }

  _dashboardPage(role = "admin") {
    const htmlPath = this.dashboardHtmlPath || join(PUBLIC_DIR, "index.html");
    try {
      let html = readFileSync(htmlPath, "utf8");
      const token =
        role === "admin"
          ? this.tokenManager.token
          : this.tokenManager.viewerToken;
      return html.replace(/\{\{TOKEN\}\}/g, token);
    } catch {
      return "<html><body>Dashboard not found. Check public/index.html.</body></html>";
    }
  }

  _loadSites() {
    // 1. Check for .farmer-sites.json in the first session's CWD or process.cwd()
    const cwd = this._guessCwd();
    const configPath = join(cwd, ".farmer-sites.json");
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      const sites = Array.isArray(raw) ? raw : raw.sites || [];
      return sites.map((s) => ({ ...s, _basedir: cwd }));
    } catch {
      /* no config — auto-discover */
    }

    // 2. Auto-discover: scan sibling directories for site/index.html
    const parent = resolve(cwd, "..");
    const sites = [];
    try {
      for (const entry of readdirSync(parent)) {
        const siteFile = join(parent, entry, "site", "index.html");
        if (existsSync(siteFile)) {
          sites.push({
            name: entry,
            description: entry,
            color: "#94a3b8",
            path: siteFile,
            _basedir: parent,
          });
        }
      }
    } catch {
      /* can't read parent */
    }
    return sites;
  }

  _connectPage(adminUrl, viewerUrl) {
    if (!qrLibSource) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Phone — Farmer</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0a0e1a;color:#e2e8f0;font-family:-apple-system,system-ui,sans-serif;}
.qr-row{display:flex;gap:40px;flex-wrap:wrap;justify-content:center;}
.qr-col{text-align:center;}
.qr-col h2{font-size:1rem;margin-bottom:8px;}
</style>
</head><body><h1>Connect Phone</h1>
<div class="qr-row">
  <div class="qr-col"><h2>Admin</h2><p style="margin:12px;word-break:break-all"><a href="${adminUrl}" style="color:#3b82f6">${adminUrl}</a></p></div>
  <div class="qr-col"><h2>Viewer</h2><p style="margin:12px;word-break:break-all"><a href="${viewerUrl}" style="color:#64748b">${viewerUrl}</a></p></div>
</div></body></html>`;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Phone — Farmer</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0a0e1a;color:#e2e8f0;font-family:-apple-system,system-ui,sans-serif;}
  h1{font-size:1.3rem;margin-bottom:6px;}
  .sub{color:#64748b;font-size:0.85rem;margin-bottom:32px;}
  .qr-row{display:flex;gap:48px;flex-wrap:wrap;justify-content:center;align-items:flex-start;}
  .qr-col{text-align:center;}
  .qr-col h2{font-size:1rem;margin-bottom:12px;font-weight:600;}
  .qr-col.admin h2{color:#3b82f6;}
  .qr-col.viewer h2{color:#64748b;}
  .qr-wrap{background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.4);}
  canvas{display:block;}
  .url{margin-top:16px;font-size:11px;color:#64748b;max-width:320px;word-break:break-all;text-align:center;line-height:1.5;}
  .url a{color:#3b82f6;text-decoration:none;}
  .tunnel-btn{margin-top:20px;padding:10px 24px;font-size:13px;font-weight:600;border:1px solid #1e293b;border-radius:8px;background:#131825;color:#3b82f6;cursor:pointer;transition:all .15s;}
  .tunnel-btn:hover{background:#1e293b;border-color:#3b82f6;}
  .tunnel-btn:disabled{opacity:0.5;cursor:wait;}
  .tip{margin-top:16px;font-size:12px;color:#475569;background:#131825;border:1px solid #1e293b;border-radius:8px;padding:12px 16px;max-width:480px;text-align:center;line-height:1.6;}
</style></head><body>
  <h1>Connect Phone</h1>
  <p class="sub">Scan a QR code with your phone camera</p>
  <div class="qr-row">
    <div class="qr-col admin">
      <h2>Admin</h2>
      <div class="qr-wrap"><canvas id="qr-admin"></canvas></div>
      <div class="url"><a id="admin-link" href="${adminUrl}">${adminUrl}</a></div>
    </div>
    <div class="qr-col viewer">
      <h2>Viewer</h2>
      <div class="qr-wrap"><canvas id="qr-viewer"></canvas></div>
      <div class="url"><a id="viewer-link" href="${viewerUrl}">${viewerUrl}</a></div>
    </div>
  </div>
  <button class="tunnel-btn" id="tunnelBtn" onclick="newTunnel()">New Cloudflare Tunnel</button>
  <div class="tip">This page is only accessible from localhost.<br>The QR codes contain auth tokens -- do not share the screen.</div>
<script>
${qrLibSource}
function drawQR(canvasId, url) {
  const QRC = qrcodegen.QrCode;
  const qr = QRC.encodeText(url, QRC.Ecc.LOW);
  const canvas = document.getElementById(canvasId);
  const scale = 8, border = 4;
  const total = (qr.size + border * 2) * scale;
  canvas.width = total; canvas.height = total;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.getModule(x, y))
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
}
drawQR("qr-admin", "${adminUrl}");
drawQR("qr-viewer", "${viewerUrl}");

function newTunnel() {
  const btn = document.getElementById('tunnelBtn');
  btn.textContent = 'Starting tunnel...';
  btn.disabled = true;
  fetch('/api/new-tunnel', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.error) { btn.textContent = 'Failed: ' + data.error; setTimeout(() => { btn.textContent = 'New Cloudflare Tunnel'; btn.disabled = false; }, 3000); return; }
      drawQR('qr-admin', data.adminUrl);
      document.getElementById('admin-link').href = data.adminUrl;
      document.getElementById('admin-link').textContent = data.adminUrl;
      drawQR('qr-viewer', data.viewerUrl);
      document.getElementById('viewer-link').href = data.viewerUrl;
      document.getElementById('viewer-link').textContent = data.viewerUrl;
      btn.textContent = 'Tunnel active';
      setTimeout(() => { btn.textContent = 'New Cloudflare Tunnel'; btn.disabled = false; }, 2000);
    })
    .catch(() => { btn.textContent = 'New Cloudflare Tunnel'; btn.disabled = false; });
}
</script>
</body></html>`;
  }

  _startTunnel(cb) {
    try {
      // Named tunnel: stable URL, SSE works, no random subdomain
      if (this.tunnelName) {
        const tunnelArgs = ["tunnel", "run", this.tunnelName];
        const proc = execFile("cloudflared", tunnelArgs, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        const hostname = this.tunnelHostname;
        if (hostname) {
          const timeout = setTimeout(() => {
            cb(null, `https://${hostname}`);
          }, 3000);
          proc.on("error", (e) => {
            clearTimeout(timeout);
            cb("cloudflared not found");
          });
          proc.on("exit", (code) => {
            clearTimeout(timeout);
            cb(`cloudflared exited (${code})`);
          });
        } else {
          cb(null, null);
          console.log(
            `  (Named tunnel '${this.tunnelName}' running -- set tunnelHostname for stable URL)`,
          );
        }

        process.on("exit", () => {
          try {
            proc.kill();
          } catch {}
        });
        return;
      }

      // Quick tunnel fallback: random trycloudflare.com URL
      const proc = execFile(
        "cloudflared",
        ["tunnel", "--url", `http://localhost:${this.port}`],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let found = false;
      const timeout = setTimeout(() => {
        if (!found) cb("timeout waiting for tunnel URL");
      }, 15000);
      const handleData = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !found) {
          found = true;
          clearTimeout(timeout);
          cb(null, match[0]);
        }
      };
      proc.stdout.on("data", handleData);
      proc.stderr.on("data", handleData);
      proc.on("error", () => {
        if (!found) {
          clearTimeout(timeout);
          cb("cloudflared not found");
        }
      });
      proc.on("exit", (code) => {
        if (!found) {
          clearTimeout(timeout);
          cb(`cloudflared exited (${code})`);
        }
      });
      process.on("exit", () => {
        try {
          proc.kill();
        } catch {}
      });
    } catch (e) {
      cb(e.message);
    }
  }

  _openBrowser(url) {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    try {
      execFile(cmd, [url], { stdio: "ignore" }).unref?.();
    } catch {}
  }

  _guessCwd() {
    // Use first active session's cwd, or process.cwd()
    for (const [, s] of this.sessions) {
      if (s.cwd) return s.cwd;
    }
    return process.cwd();
  }
}
