/**
 * SprintSession — Durable Object with WebSocket Hibernation + SQLite.
 *
 * One DO per sprint token. Manages:
 * - Permission requests from CLI hooks (HTTP POST)
 * - Dashboard connections (WebSocket with hibernation)
 * - State persistence (SQLite)
 * - Auto-deny timeout via DO Alarms
 */

// ── Trust tiers ──
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
const NEVER_AUTO = new Set(["Request", "AskUserQuestion"]);
const PERMISSION_TIMEOUT_MS = 120_000;
const MAX_ACTIVITY = 1000;

export class SprintSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

    // Auto-respond to ping without waking the DO
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    this._ensureSchema();
  }

  // ── Schema ──

  _ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        cwd TEXT DEFAULT '',
        color INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        trust_level TEXT DEFAULT 'paranoid',
        started_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        source TEXT
      );
      CREATE TABLE IF NOT EXISTS session_rules (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        pattern TEXT,
        UNIQUE(session_id, tool, pattern)
      );
      CREATE TABLE IF NOT EXISTS pending (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ── HTTP fetch handler (hooks + API) ──

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this._handleWebSocketUpgrade(request, url);
    }

    // Hook endpoints (POST from CLI)
    if (request.method === "POST" && path.startsWith("/hooks/")) {
      return this._handleHook(request, path);
    }

    // API endpoints (from dashboard via WebSocket mostly, but HTTP fallback)
    if (request.method === "POST" && path.startsWith("/api/")) {
      return this._handleAPI(request, path);
    }

    // GET /api/state — initial state for dashboard
    if (request.method === "GET" && path === "/api/state") {
      return this._jsonResponse(this._getFullState());
    }

    return new Response("Not found", { status: 404 });
  }

  // ── WebSocket Hibernation handlers ──

  _handleWebSocketUpgrade(request, url) {
    const role = url.searchParams.get("role") || "admin";
    const lastCursor = parseInt(url.searchParams.get("cursor") || "0", 10);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);

    // Store per-connection metadata
    server.serializeAttachment({ role, lastCursor, connectedAt: Date.now() });

    // Send initial state + missed events
    const state = this._getFullState();
    server.send(JSON.stringify({ type: "init", data: state }));

    if (lastCursor > 0) {
      const missed = this.sql
        .exec(
          "SELECT id, session_id, type, payload, created_at FROM activity_log WHERE id > ? ORDER BY id LIMIT 1000",
          lastCursor,
        )
        .toArray();
      for (const row of missed) {
        server.send(
          JSON.stringify({
            type: "replay",
            cursor: row.id,
            data: {
              type: row.type,
              session_id: row.session_id,
              ...JSON.parse(row.payload),
              timestamp: row.created_at,
            },
          }),
        );
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case "decide":
        this._decide(msg.requestId, msg.allow, msg.reason, msg.response);
        break;
      case "trust_level":
        this._setTrustLevel(msg.sessionId, msg.level);
        break;
      case "rules":
        this._updateRules(msg.sessionId, msg.action, msg.rules || [msg.rule]);
        break;
      case "message":
        this._addMessage(msg.sessionId, msg.content);
        break;
      case "feedback":
        this._addFeedback(msg.text);
        break;
      case "resume":
        this._sendMissedEvents(ws, msg.lastCursor || 0);
        break;
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, reason);
  }

  async webSocketError(ws, error) {
    ws.close(1011, "WebSocket error");
  }

  // ── Alarm handler (permission timeout + cleanup) ──

  async alarm() {
    const now = Date.now();

    // Auto-deny expired pending permissions
    const expired = this.sql
      .exec(
        "SELECT request_id, session_id, payload FROM pending WHERE created_at < ?",
        now - PERMISSION_TIMEOUT_MS,
      )
      .toArray();

    for (const row of expired) {
      this.sql.exec("DELETE FROM pending WHERE request_id = ?", row.request_id);
      const event = JSON.parse(row.payload);
      this._logActivity(row.session_id, "permission_expired", {
        requestId: row.request_id,
        tool_name: event.tool_name,
        decision: "timeout",
      });
      this._broadcast({
        type: "permission_expired",
        session_id: row.session_id,
        data: { requestId: row.request_id },
      });
    }

    // Check if more pending exist — reschedule alarm if so
    const remaining = this.sql.exec("SELECT COUNT(*) as c FROM pending").one();
    if (remaining.c > 0) {
      const next = this.sql
        .exec("SELECT MIN(created_at) as earliest FROM pending")
        .one();
      this.ctx.storage.setAlarm(next.earliest + PERMISSION_TIMEOUT_MS);
    }

    // Reap ended sessions older than 30 minutes
    this.sql.exec(
      "DELETE FROM sessions WHERE status = 'ended' AND last_activity < ?",
      now - 30 * 60 * 1000,
    );
  }

  // ── Hook handlers ──

  async _handleHook(request, path) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._jsonResponse({ error: "Invalid JSON" }, 400);
    }

    const hookType = path.split("/").pop();

    switch (hookType) {
      case "permission":
        return this._hookPermission(body);
      case "activity":
        return this._hookActivity(body);
      case "notification":
        return this._hookNotification(body);
      case "lifecycle":
        return this._hookLifecycle(body);
      case "stop":
        return this._hookStop(body);
      default:
        return this._jsonResponse({ error: `Unknown hook: ${hookType}` }, 400);
    }
  }

  async _hookPermission(body) {
    const sessionId = body.session_id || "default";
    const session = this._ensureSession(sessionId, body.cwd);

    const requestId = crypto.randomUUID();
    const toolName = this._extractToolName(body);
    const toolInput = this._extractToolInput(body);
    const isQuestion = toolName === "AskUserQuestion";

    // Auto-approve check
    const autoDecision = this._shouldAutoApprove(
      session,
      toolName,
      toolInput,
      body,
    );
    if (autoDecision) {
      this._logActivity(sessionId, "auto_approved", {
        requestId,
        tool_name: toolName,
        tool_input: toolInput,
        decision: "auto-allowed",
      });
      this._broadcast({
        type: "auto_approved",
        session_id: sessionId,
        data: { requestId, tool_name: toolName, tool_input: toolInput },
      });

      // Piggyback pending feedback on auto-approve
      const feedback = this._drainFeedback();
      const resp = this._formatPermissionResponse(true, null, body, feedback);
      return this._jsonResponse(resp);
    }

    // Store pending request
    const eventData = {
      requestId,
      tool_name: toolName,
      tool_input: toolInput,
      isQuestion,
      session_id: sessionId,
      session_label: session.label,
      session_color: session.color,
      cwd: session.cwd,
      hook_event_name: body.event?.name,
      timestamp: Date.now(),
    };

    this.sql.exec(
      "INSERT INTO pending (request_id, session_id, payload, created_at) VALUES (?, ?, ?, ?)",
      requestId,
      sessionId,
      JSON.stringify(eventData),
      Date.now(),
    );

    // Schedule alarm for timeout
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      this.ctx.storage.setAlarm(Date.now() + PERMISSION_TIMEOUT_MS);
    }

    // Broadcast to dashboards
    this._broadcast({
      type: "permission_request",
      session_id: sessionId,
      data: eventData,
    });

    // Wait for decision (long-poll with timeout)
    const decision = await this._waitForDecision(
      requestId,
      PERMISSION_TIMEOUT_MS,
    );

    if (!decision) {
      // Timed out — alarm handler already cleaned up
      return this._jsonResponse(
        this._formatPermissionResponse(
          false,
          "Permission request timed out",
          body,
        ),
      );
    }

    if (isQuestion && decision.response) {
      return this._jsonResponse({ result: decision.response });
    }

    return this._jsonResponse(
      this._formatPermissionResponse(decision.allow, decision.reason, body),
    );
  }

  _waitForDecision(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const key = `_resolve_${requestId}`;
      this[key] = resolve;

      // Fallback timeout (alarm is the primary timeout, this is a safety net)
      setTimeout(() => {
        if (this[key]) {
          delete this[key];
          // Clean up pending if still there
          this.sql.exec("DELETE FROM pending WHERE request_id = ?", requestId);
          resolve(null);
        }
      }, timeoutMs + 1000);
    });
  }

  _hookActivity(body) {
    const sessionId = body.session_id || "default";
    this._ensureSession(sessionId, body.cwd);

    const toolName = this._extractToolName(body);
    const toolInput = this._extractToolInput(body);
    const toolResult =
      typeof body.event?.result === "string"
        ? body.event.result.slice(0, 500)
        : JSON.stringify(body.event?.result || "").slice(0, 500);

    const type = body.event?.error ? "failure" : "success";

    this._logActivity(sessionId, type, {
      tool_name: toolName,
      tool_input: toolInput,
      tool_result: toolResult,
    });

    this._broadcast({
      type,
      session_id: sessionId,
      data: {
        tool_name: toolName,
        tool_input: toolInput,
        tool_result: toolResult,
      },
    });

    return this._jsonResponse({ ok: true });
  }

  _hookNotification(body) {
    const sessionId = body.session_id || "default";
    this._ensureSession(sessionId, body.cwd);

    const message = body.event?.message || body.event?.notification || "";

    this._logActivity(sessionId, "notification_card", { message });
    this._broadcast({
      type: "notification_card",
      session_id: sessionId,
      data: { message, timestamp: Date.now() },
    });

    return this._jsonResponse({ ok: true });
  }

  _hookLifecycle(body) {
    const sessionId = body.session_id || "default";
    const eventName = body.event?.name || body.event?.event;

    if (eventName === "session_start" || eventName === "init") {
      const session = this._ensureSession(sessionId, body.cwd);
      session.status = "active";
      this._updateSession(session);
      this._broadcast({
        type: "session_start",
        session_id: sessionId,
        data: this._sessionSummary(session),
      });
    } else if (eventName === "session_end" || eventName === "stop") {
      const session = this._getSession(sessionId);
      if (session) {
        session.status = "ended";
        session.last_activity = Date.now();
        this._updateSession(session);

        // Auto-deny all pending for this session
        const pending = this.sql
          .exec(
            "SELECT request_id FROM pending WHERE session_id = ?",
            sessionId,
          )
          .toArray();
        for (const p of pending) {
          this._decide(p.request_id, false, "session ended");
        }

        this._broadcast({
          type: "session_end",
          session_id: sessionId,
          data: { id: sessionId },
        });
      }

      // Schedule cleanup alarm
      this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
    }

    return this._jsonResponse({ ok: true });
  }

  _hookStop(body) {
    const sessionId = body.session_id || "default";
    const session = this._getSession(sessionId);
    if (session) {
      session.status = "idle";
      session.last_activity = Date.now();
      this._updateSession(session);
      this._broadcast({
        type: "session_idle",
        session_id: sessionId,
        data: { id: sessionId },
      });

      // Deliver pending feedback if Claude stopped
      const feedback = this._drainFeedback();
      if (feedback) {
        return this._jsonResponse({ result: feedback });
      }
    }
    return this._jsonResponse({ ok: true });
  }

  // ── API handlers ──

  async _handleAPI(request, path) {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const endpoint = path.replace("/api/", "");
    switch (endpoint) {
      case "decide":
        this._decide(body.requestId, body.allow, body.reason, body.response);
        return this._jsonResponse({ ok: true });
      case "trust-level":
        this._setTrustLevel(body.sessionId, body.level);
        return this._jsonResponse({ ok: true });
      case "rules":
        this._updateRules(
          body.sessionId,
          body.action,
          body.rules || [body.rule],
        );
        return this._jsonResponse({ ok: true });
      case "message":
        this._addMessage(body.sessionId || "default", body.content);
        return this._jsonResponse({ ok: true });
      case "feedback":
        this._addFeedback(body.text);
        return this._jsonResponse({ ok: true });
      case "feedback/poll":
        return this._jsonResponse(this._pollFeedback());
      case "feedback/ack":
        this._ackFeedback(body.ids || []);
        return this._jsonResponse({ ok: true });
      default:
        return this._jsonResponse({ error: "Unknown API endpoint" }, 404);
    }
  }

  // ── Decision resolution ──

  _decide(requestId, allow, reason, response) {
    const row = this.sql
      .exec(
        "SELECT session_id, payload FROM pending WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];

    if (!row) return; // Already resolved or expired

    this.sql.exec("DELETE FROM pending WHERE request_id = ?", requestId);

    const event = JSON.parse(row.payload);
    const decision = event.isQuestion
      ? "answered"
      : allow
        ? "allowed"
        : "denied";

    this._logActivity(row.session_id, "decision", {
      requestId,
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      decision,
      reason,
    });

    this._broadcast({
      type: "permission_resolved",
      session_id: row.session_id,
      data: { requestId, decision, reason },
    });

    // Resolve the waiting hook request
    const key = `_resolve_${requestId}`;
    if (this[key]) {
      this[key]({ allow, reason, response });
      delete this[key];
    }
  }

  // ── Trust & rules ──

  _setTrustLevel(sessionId, level) {
    if (!["paranoid", "standard", "autonomous"].includes(level)) return;

    if (sessionId) {
      this.sql.exec(
        "UPDATE sessions SET trust_level = ? WHERE id = ?",
        level,
        sessionId,
      );
    } else {
      this.sql.exec("UPDATE sessions SET trust_level = ?", level);
    }
    this._broadcast({
      type: "trust_level",
      session_id: sessionId || null,
      data: { level },
    });
  }

  _updateRules(sessionId, action, rules) {
    const sid = sessionId || this._activeSessionId() || "default";
    this._ensureSession(sid);

    for (const rule of rules) {
      if (!rule || !rule.tool) continue;
      if (action === "remove") {
        this.sql.exec(
          "DELETE FROM session_rules WHERE session_id = ? AND tool = ? AND (pattern = ? OR (pattern IS NULL AND ? IS NULL))",
          sid,
          rule.tool,
          rule.pattern || null,
          rule.pattern || null,
        );
      } else {
        this.sql.exec(
          "INSERT OR IGNORE INTO session_rules (session_id, tool, pattern) VALUES (?, ?, ?)",
          sid,
          rule.tool,
          rule.pattern || null,
        );
      }
    }
    this._broadcast({
      type: "rules_updated",
      session_id: sid,
      data: { rules: this._getRules(sid) },
    });
  }

  // ── Messages & feedback ──

  _addMessage(sessionId, content) {
    if (!content) return;
    this.sql.exec(
      "INSERT INTO messages (session_id, content, created_at) VALUES (?, ?, ?)",
      sessionId,
      content.slice(0, 10000),
      Date.now(),
    );
    // Keep last 50
    this.sql.exec(
      "DELETE FROM messages WHERE session_id = ? AND id NOT IN (SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 50)",
      sessionId,
      sessionId,
    );
    this._broadcast({
      type: "message",
      session_id: sessionId,
      data: { content, timestamp: Date.now() },
    });
  }

  _addFeedback(text) {
    if (!text) return;
    this.sql.exec(
      "INSERT INTO feedback (text, status, created_at) VALUES (?, ?, ?)",
      text.slice(0, 1_000_000),
      "pending",
      Date.now(),
    );
    this._broadcast({
      type: "user_feedback",
      data: { text, timestamp: Date.now() },
    });
  }

  _pollFeedback() {
    const rows = this.sql
      .exec(
        "SELECT id, text, created_at FROM feedback WHERE status = 'pending' ORDER BY id",
      )
      .toArray();
    const EXPIRE_MS = 30 * 60 * 1000;
    const STALE_MS = 5 * 60 * 1000;
    const now = Date.now();

    // Expire old
    this.sql.exec(
      "UPDATE feedback SET status = 'expired' WHERE status = 'pending' AND created_at < ?",
      now - EXPIRE_MS,
    );

    return {
      items: rows
        .filter((r) => now - r.created_at < EXPIRE_MS)
        .map((r) => ({
          id: r.id,
          text:
            (now - r.created_at > STALE_MS
              ? `[sent ${Math.round((now - r.created_at) / 60000)}m ago] `
              : "") + r.text,
          timestamp: r.created_at,
        })),
    };
  }

  _ackFeedback(ids) {
    for (const id of ids) {
      this.sql.exec(
        "UPDATE feedback SET status = 'delivered' WHERE id = ?",
        id,
      );
    }
    this._broadcast({ type: "feedback_read", data: { ids } });
  }

  _drainFeedback() {
    const rows = this.sql
      .exec(
        "SELECT id, text FROM feedback WHERE status = 'pending' ORDER BY id",
      )
      .toArray();
    if (!rows.length) return null;
    for (const r of rows) {
      this.sql.exec(
        "UPDATE feedback SET status = 'delivered' WHERE id = ?",
        r.id,
      );
    }
    return rows.map((r) => r.text).join("\n");
  }

  // ── Session management ──

  _ensureSession(sessionId, cwd) {
    const existing = this._getSession(sessionId);
    if (existing) {
      existing.last_activity = Date.now();
      if (existing.status !== "active") existing.status = "active";
      if (cwd && !existing.cwd) existing.cwd = cwd;
      this._updateSession(existing);
      return existing;
    }

    const now = Date.now();
    const label = cwd
      ? cwd.split("/").pop() || sessionId.slice(0, 8)
      : sessionId.slice(0, 8);
    const color = this._hueFromId(sessionId);

    // Inherit trust from most recent non-paranoid session
    let trustLevel = "paranoid";
    const prev = this.sql
      .exec(
        "SELECT trust_level FROM sessions WHERE trust_level != 'paranoid' ORDER BY last_activity DESC LIMIT 1",
      )
      .toArray()[0];
    if (prev) trustLevel = prev.trust_level;

    const session = {
      id: sessionId,
      label,
      cwd: cwd || "",
      color,
      status: "active",
      trust_level: trustLevel,
      started_at: now,
      last_activity: now,
      source: null,
    };
    this.sql.exec(
      "INSERT INTO sessions (id, label, cwd, color, status, trust_level, started_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      session.label,
      session.cwd,
      session.color,
      session.status,
      session.trust_level,
      session.started_at,
      session.last_activity,
    );

    // Inherit rules from previous session
    if (prev) {
      const activeId = this.sql
        .exec(
          "SELECT id FROM sessions WHERE trust_level != 'paranoid' ORDER BY last_activity DESC LIMIT 1",
        )
        .toArray()[0];
      if (activeId) {
        const rules = this.sql
          .exec(
            "SELECT tool, pattern FROM session_rules WHERE session_id = ?",
            activeId.id,
          )
          .toArray();
        for (const r of rules) {
          this.sql.exec(
            "INSERT OR IGNORE INTO session_rules (session_id, tool, pattern) VALUES (?, ?, ?)",
            sessionId,
            r.tool,
            r.pattern,
          );
        }
      }
    }

    this._broadcast({
      type: "session_new",
      session_id: sessionId,
      data: this._sessionSummary(session),
    });
    return session;
  }

  _getSession(sessionId) {
    return (
      this.sql
        .exec("SELECT * FROM sessions WHERE id = ?", sessionId)
        .toArray()[0] || null
    );
  }

  _updateSession(session) {
    this.sql.exec(
      "UPDATE sessions SET label = ?, cwd = ?, color = ?, status = ?, trust_level = ?, last_activity = ?, source = ? WHERE id = ?",
      session.label,
      session.cwd,
      session.color,
      session.status,
      session.trust_level,
      session.last_activity,
      session.source || null,
      session.id,
    );
  }

  _activeSessionId() {
    const row = this.sql
      .exec(
        "SELECT id FROM sessions WHERE status = 'active' ORDER BY last_activity DESC LIMIT 1",
      )
      .toArray()[0];
    return row?.id || null;
  }

  _sessionSummary(s) {
    const pendingCount = this.sql
      .exec("SELECT COUNT(*) as c FROM pending WHERE session_id = ?", s.id)
      .one().c;
    return {
      id: s.id,
      label: s.label,
      color: s.color,
      status: s.status,
      cwd: s.cwd,
      pending_count: pendingCount,
      trust: s.trust_level,
      startedAt: s.started_at,
      lastActivity: s.last_activity,
    };
  }

  _hueFromId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++)
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    return Math.abs(hash) % 360;
  }

  // ── Auto-approve logic ──

  _shouldAutoApprove(session, toolName, toolInput, body) {
    if (NEVER_AUTO.has(toolName)) return false;

    const trust = session.trust_level;
    if (trust === "paranoid") return false;

    // No dashboard connected — auto-approve as safety valve
    const clients = this.ctx.getWebSockets();
    if (clients.length === 0) return true;

    if (trust === "standard") {
      if (STANDARD_AUTO_APPROVE.has(toolName)) return true;
      return this._matchesSessionRule(session.id, toolName, toolInput);
    }

    if (trust === "autonomous") {
      if (toolName === "Bash" || toolName === "bash") {
        const cmd =
          typeof toolInput === "string" ? toolInput : toolInput?.command || "";
        if (DANGEROUS_BASH_PATTERNS.some((p) => p.test(cmd))) return false;
      }
      return true;
    }

    return false;
  }

  _matchesSessionRule(sessionId, toolName, toolInput) {
    const rules = this.sql
      .exec(
        "SELECT tool, pattern FROM session_rules WHERE session_id = ?",
        sessionId,
      )
      .toArray();
    for (const rule of rules) {
      if (rule.tool === toolName || rule.tool === "*") {
        if (!rule.pattern) return true;
        const input =
          typeof toolInput === "string"
            ? toolInput
            : JSON.stringify(toolInput || "");
        if (
          input.includes(rule.pattern) ||
          this._wildcardMatch(rule.pattern, input)
        )
          return true;
      }
    }
    return false;
  }

  _wildcardMatch(pattern, str) {
    const re = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    );
    return re.test(str);
  }

  // ── Tool extraction (Claude Code adapter) ──

  _extractToolName(body) {
    return (
      body.event?.tool_name || body.tool_name || body.event?.name || "unknown"
    );
  }

  _extractToolInput(body) {
    const input =
      body.event?.tool_input || body.tool_input || body.event?.input;
    if (!input) return "";
    if (typeof input === "string") return input;
    return (
      input.command ||
      input.file_path ||
      input.content ||
      JSON.stringify(input).slice(0, 500)
    );
  }

  // ── Permission response formatting (Claude Code adapter) ──

  _formatPermissionResponse(allow, reason, hookBody, feedback) {
    const hookEvent = hookBody?.event?.name || hookBody?.hook_event_name;

    if (hookEvent === "PreToolUse") {
      if (allow) {
        const resp = {};
        if (feedback) resp.additionalContext = feedback;
        return resp; // Empty object = allow
      }
      return { decision: "deny", reason: reason || "Denied by farmer" };
    }

    // PermissionRequest format
    if (allow) {
      const resp = { permissionDecision: "allow" };
      if (feedback) resp.additionalContext = feedback;
      return resp;
    }
    return { permissionDecision: "deny", reason: reason || "Denied by farmer" };
  }

  // ── Activity logging ──

  _logActivity(sessionId, type, data) {
    this.sql.exec(
      "INSERT INTO activity_log (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
      sessionId,
      type,
      JSON.stringify(data),
      Date.now(),
    );
    // Trim to MAX_ACTIVITY
    this.sql.exec(
      `DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT ${MAX_ACTIVITY})`,
    );
  }

  // ── State ──

  _getFullState() {
    const sessions = this.sql
      .exec("SELECT * FROM sessions ORDER BY last_activity DESC")
      .toArray();
    const pending = this.sql
      .exec(
        "SELECT request_id, session_id, payload, created_at FROM pending ORDER BY created_at",
      )
      .toArray();
    const activity = this.sql
      .exec(
        "SELECT id, session_id, type, payload, created_at FROM activity_log ORDER BY id DESC LIMIT 50",
      )
      .toArray();

    const activeSession = sessions[0];
    const trustLevel = activeSession?.trust_level || "paranoid";
    const sessionRules = activeSession ? this._getRules(activeSession.id) : [];

    return {
      sessions: sessions.map((s) => this._sessionSummary(s)),
      pending: pending.map((p) => {
        const data = JSON.parse(p.payload);
        return {
          id: p.request_id,
          ...data,
          session_id: p.session_id,
          timestamp: p.created_at,
        };
      }),
      activity: activity.map((a) => ({
        cursor: a.id,
        type: a.type,
        session_id: a.session_id,
        ...JSON.parse(a.payload),
        timestamp: a.created_at,
      })),
      trustLevel,
      sessionRules,
    };
  }

  _getRules(sessionId) {
    return this.sql
      .exec(
        "SELECT tool, pattern FROM session_rules WHERE session_id = ?",
        sessionId,
      )
      .toArray();
  }

  _sendMissedEvents(ws, lastCursor) {
    const missed = this.sql
      .exec(
        "SELECT id, session_id, type, payload, created_at FROM activity_log WHERE id > ? ORDER BY id LIMIT 1000",
        lastCursor,
      )
      .toArray();
    for (const row of missed) {
      ws.send(
        JSON.stringify({
          type: "replay",
          cursor: row.id,
          data: {
            type: row.type,
            session_id: row.session_id,
            ...JSON.parse(row.payload),
            timestamp: row.created_at,
          },
        }),
      );
    }
  }

  // ── Broadcast to all connected dashboards ──

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* client gone */
      }
    }
  }

  // ── Helpers ──

  _jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
