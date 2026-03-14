/**
 * Farmer server — the core permission dashboard server.
 *
 * Receives hook events from AI coding agents, pushes them to a browser
 * dashboard via WebSocket + SSE, and relays approve/deny decisions.
 *
 * Agent-agnostic: adapters translate between agent-specific hook formats
 * and Farmer's internal protocol. Claude Code adapter ships first.
 *
 * Zero npm dependencies — Node built-in only.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { Persistence } from './persistence.js';
import {
  SECURITY_HEADERS, TokenManager, CsrfManager, PidLock,
  sourceFingerprint, deriveSessionId, clientAddr,
} from './security.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

// --- Session state ---
class SessionState {
  constructor(sessionId, cwd) {
    this.id = sessionId;
    this.label = cwd ? cwd.split('/').pop() : sessionId.slice(0, 8);
    this.cwd = cwd || '';
    this.color = SessionState.hueFromId(sessionId);
    this.status = 'active';
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.source = null;

    this.pending = new Map();
    this.activity = [];
    this.messages = [];
    this.trustLevel = 'paranoid';
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

  touch() { this.lastActivity = Date.now(); }

  isStale(timeoutMs = 5 * 60 * 1000) {
    return this.status === 'active' && (Date.now() - this.lastActivity) > timeoutMs;
  }
}

// --- Trust tiers ---
const STANDARD_AUTO_APPROVE = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
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
  if (!pattern.includes('*')) return str === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(str);
}

function shouldAutoApprove(session, toolName, toolInput) {
  if (toolName === 'Request' || toolName === 'AskUserQuestion') return false;

  for (const rule of session.sessionRules) {
    if (rule.tool === toolName) {
      if (!rule.pattern) return true;
      const target = toolInput?.file_path || toolInput?.command || toolInput?.pattern || '';
      if (target.includes(rule.pattern) || minimatch(target, rule.pattern)) return true;
    }
  }

  if (session.trustLevel === 'paranoid') return false;
  if (session.trustLevel === 'standard') return STANDARD_AUTO_APPROVE.has(toolName);
  if (session.trustLevel === 'autonomous') {
    if (toolName === 'Bash' && toolInput?.command) {
      for (const pat of DANGEROUS_BASH_PATTERNS) {
        if (pat.test(toolInput.command)) return false;
      }
    }
    return true;
  }
  return false;
}

// --- WebSocket helpers (zero-dep, raw RFC 6455) ---
function wsEncodeFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

function wsDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = buf.readUInt32BE(6);
    offset = 10;
  }

  let payload;
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
  } else {
    if (buf.length < offset + payloadLen) return null;
    payload = buf.slice(offset, offset + payloadLen);
  }
  return { opcode, fin, payload, bytesConsumed: offset + payloadLen };
}

// --- Helpers ---
const MAX_BODY_SIZE = 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function summarizeResult(result) {
  if (!result) return null;
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s.slice(0, 500);
}

// ============================================================
// Server class
// ============================================================
export class FarmerServer {
  constructor(opts = {}) {
    this.port = opts.port || 9090;
    this.trustProxy = opts.trustProxy || false;
    this.maxSessions = opts.maxSessions || 50;

    // Adapter — defaults to Claude Code
    this.adapter = opts.adapter || new ClaudeCodeAdapter();

    // Data dir for persistence
    const dataDir = opts.dataDir || process.cwd();
    this.persistence = new Persistence(dataDir);

    // Security
    this.tokenManager = new TokenManager({
      token: opts.token,
      rotationInterval: opts.tokenRotationInterval || 0,
      gracePeriod: opts.tokenGracePeriod || 60,
    });
    this.csrfManager = new CsrfManager();
    this.pidLock = new PidLock(join(dataDir, '.farmer.pid'));

    // Sessions
    this.sessions = new Map();
    this.sessionBindings = new Map();
    this.lifecycleBuffer = new Map();

    // SSE + WS clients
    this.sseClients = new Set();
    this.wsClients = new Set();
    this.MAX_WS_BUFFER_SIZE = 1024 * 1024;

    // Activity limits
    this.MAX_ACTIVITY = 1000;

    // GC config
    this.ENDED_TTL = 5 * 60 * 1000;
    this.STALE_TTL = 30 * 60 * 1000;

    this.server = null;
    this._timers = [];
  }

  // --- Startup ---
  start() {
    // PID lock
    this.pidLock.acquire();

    // Load persisted state
    const saved = this.persistence.loadState();
    if (saved) {
      for (const s of saved.sessions || []) {
        const session = this._getSession(s.id, s.cwd);
        if (!session) continue;
        session.trustLevel = s.trustLevel || 'paranoid';
        session.sessionRules = s.sessionRules || [];
        session.activity = s.activity || [];
        session.messages = s.messages || [];
        if (s.label) session.label = s.label;
        if (s.color) session.color = s.color;
      }
    }

    // Create HTTP server
    this.server = createServer((req, res) => this._handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this._handleWsUpgrade(req, socket, head));

    // Start timers
    this._timers.push(setInterval(() => this._heartbeat(), 10_000));
    this._timers.push(setInterval(() => this._detectStale(), 60_000));
    this._timers.push(setInterval(() => this._reapSessions(), 60_000));
    this._timers.push(setInterval(() => this._wsHeartbeat(), 30_000));
    this._timers.push(setInterval(() => this.persistence.flushIfDirty(this.sessions), 30_000));
    this._timers.push(setInterval(() => this._cleanLifecycleBuffer(), 15_000));

    // Graceful shutdown
    const shutdown = (signal) => this._shutdown(signal);
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('exit', () => this.pidLock.release());

    this.server.listen(this.port, () => {
      const token = this.tokenManager.token;
      console.log(`\n  Farmer v0.1.0 (${this.adapter.name} adapter)`);
      console.log(`  ${'─'.repeat(48)}`);
      console.log(`  Local:  http://localhost:${this.port}/?token=${token}`);
      console.log(`  Token:  ${token}`);
      console.log(`  Hooks:  /hooks/permission  /hooks/activity`);
      console.log(`          /hooks/notification /hooks/lifecycle`);
      console.log(`  WS:     /ws (auth via first message)`);
      console.log(`  SSE:    /events (fallback)`);
      console.log(`  Audit:  ${this.persistence.auditLogPath}`);
      console.log(`\n  Waiting for connections...\n`);
      this.persistence.auditLog({ event: 'server_startup', port: this.port });
    });
  }

  // --- Shutdown ---
  _shutdown(signal) {
    console.log(`\n  [${signal}] Shutting down...`);
    for (const [, session] of this.sessions) {
      for (const [, entry] of session.pending) {
        entry.resolve({ allow: false, reason: `Server shutting down (${signal})` });
      }
    }
    this.persistence.saveState(this.sessions, true);
    this.persistence.auditLog({ event: 'server_shutdown', signal });
    this.pidLock.release();
    this._broadcast({ type: 'server_shutdown', data: { signal } });
    for (const t of this._timers) clearInterval(t);
    this.tokenManager.destroy();
    this.csrfManager.destroy();
    this.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  }

  // --- Session management ---
  _getSession(sessionId, cwd, req) {
    const id = sessionId || 'default';
    if (!this.sessions.has(id)) {
      if (this.sessions.size >= this.maxSessions) {
        let victim = null, victimAge = Infinity;
        for (const [vid, vs] of this.sessions) {
          if (vs.status === 'ended' && vs.lastActivity < victimAge) { victim = vid; victimAge = vs.lastActivity; }
        }
        if (!victim) {
          for (const [vid, vs] of this.sessions) {
            if (vs.status === 'stale' && vs.lastActivity < victimAge) { victim = vid; victimAge = vs.lastActivity; }
          }
        }
        if (victim) this._evictSession(victim);
        else { console.warn(`[gc] MAX_SESSIONS reached — rejecting ${id}`); return null; }
      }
      const session = new SessionState(id, cwd);
      this.sessions.set(id, session);
      const fp = req ? sourceFingerprint(clientAddr(req, this.trustProxy), req._hookPid) : null;
      if (fp) this.sessionBindings.set(id, fp);
      this._broadcast({ type: 'session_new', session_id: id, data: this._sessionSummary(session) });
    } else if (req) {
      const fp = sourceFingerprint(clientAddr(req, this.trustProxy), req._hookPid);
      const bound = this.sessionBindings.get(id);
      if (bound && fp && bound !== fp) {
        console.warn(`[security] Session binding mismatch for ${id}`);
        return null;
      }
    }
    const s = this.sessions.get(id);
    if (cwd && (!s.cwd || s.cwd !== cwd)) { s.cwd = cwd; s.label = cwd.split('/').pop(); }
    s.touch();
    return s;
  }

  _evictSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const [, entry] of session.pending) entry.resolve({ allow: false, reason: 'session evicted' });
    this.sessions.delete(id);
    this.sessionBindings.delete(id);
    this.lifecycleBuffer.delete(id);
    this._broadcast({ type: 'session_removed', session_id: id, data: { reason: 'evicted' } });
  }

  _sessionSummary(s) {
    return {
      id: s.id, label: s.label, color: s.color, status: s.status,
      cwd: s.cwd, pending_count: s.pending.size, trust: s.trustLevel,
      startedAt: s.startedAt, lastActivity: s.lastActivity,
    };
  }

  _allPending() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const [id, p] of session.pending) {
        result.push({ id, ...p.data, timestamp: p.timestamp, session_id: session.id, session_label: session.label, session_color: session.color });
      }
    }
    return result;
  }

  _allActivity() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const a of session.activity) result.push({ ...a, session_id: a.session_id || session.id });
    }
    result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return result.slice(-50);
  }

  _allMessages() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const m of session.messages) result.push({ ...m, session_id: session.id });
    }
    result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return result;
  }

  _allAgents() {
    const result = [];
    for (const [, session] of this.sessions) {
      for (const a of session.agents) result.push({ ...a, session_id: session.id });
    }
    return result;
  }

  _allSessionsSummary() {
    return [...this.sessions.values()].map(s => this._sessionSummary(s));
  }

  _addActivity(session, event) {
    session.activity.push(event);
    if (session.activity.length > this.MAX_ACTIVITY) session.activity.shift();
    this.persistence.markDirty();
    this._broadcast({ type: 'activity', session_id: session.id, data: event });
  }

  // --- Broadcast (SSE + WS) ---
  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const res of this.sseClients) {
      try {
        if (res.destroyed || res.writableEnded) { this.sseClients.delete(res); continue; }
        res.write(`data: ${data}\n\n`);
      } catch { this.sseClients.delete(res); }
    }
    const frame = wsEncodeFrame(data);
    for (const client of this.wsClients) {
      if (!client.authenticated) continue;
      try { client.socket.write(frame); }
      catch { this.wsClients.delete(client); try { client.socket.destroy(); } catch {} }
    }
  }

  // --- HTTP request handler ---
  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    // Security headers
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // CORS
    const origin = req.headers.origin || '';
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Auth helpers
    const cookies = this._parseCookies(req);
    const authOk = () => {
      if (this.tokenManager.matches(cookies['farmer_token'])) return true;
      return this.tokenManager.matches(url.searchParams.get('token') || '');
    };
    const csrfOk = () => {
      if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return true;
      return this.csrfManager.validate(req.headers['x-csrf-token'] || '');
    };

    // --- SSE ---
    if (req.method === 'GET' && url.pathname === '/events') {
      if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Content-Encoding': 'identity',
      });
      res.flushHeaders();
      const csrfToken = this.csrfManager.generate();
      res.write(`data: ${JSON.stringify({ type: 'init', data: this._initPayload(csrfToken) })}\n\n`);
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    // --- Hook endpoints (localhost only) ---
    if (req.method === 'POST' && url.pathname.startsWith('/hooks/')) {
      const remoteAddr = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr)) {
        res.writeHead(403); res.end('Hook endpoints accept localhost only'); return;
      }
      let body; try { body = await readBody(req); } catch { res.writeHead(413); res.end('Request too large'); return; }
      let data; try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }

      if (data.pid) req._hookPid = String(data.pid);
      if (!data.session_id) data.session_id = deriveSessionId({ pid: data.pid, cwd: data.cwd });

      const hookType = url.pathname.split('/hooks/')[1];
      if (hookType === 'permission') return this._handlePermission(data, res, req);
      if (hookType === 'activity') return this._handleActivity(data, res, req);
      if (hookType === 'notification') return this._handleNotification(data, res, req);
      if (hookType === 'lifecycle') return this._handleLifecycle(data, res, req);
      res.writeHead(404); res.end('Unknown hook'); return;
    }

    // --- Dashboard API ---
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
      if (!csrfOk()) { res.writeHead(403); res.end('CSRF token invalid'); return; }
      let body; try { body = await readBody(req); } catch { res.writeHead(413); res.end('Too large'); return; }
      let data; try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
      return this._handleDecision(data, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/trust-level') {
      if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
      if (!csrfOk()) { res.writeHead(403); res.end('CSRF token invalid'); return; }
      let body; try { body = await readBody(req); } catch { res.writeHead(413); res.end('Too large'); return; }
      let data; try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
      return this._handleTrustLevel(data, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/rules') {
      if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
      if (!csrfOk()) { res.writeHead(403); res.end('CSRF token invalid'); return; }
      let body; try { body = await readBody(req); } catch { res.writeHead(413); res.end('Too large'); return; }
      let data; try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
      return this._handleRules(data, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const remoteAddr = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr)) {
        res.writeHead(403); res.end('Localhost only'); return;
      }
      let body; try { body = await readBody(req); } catch { res.writeHead(413); res.end('Too large'); return; }
      let data; try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
      const session = this._getSession(data.session_id || deriveSessionId({ cwd: data.cwd }), data.cwd);
      if (!session) { res.writeHead(503); res.end('Max sessions reached'); return; }
      const msg = { type: 'message', content: data.content || data.message || '', timestamp: Date.now(), session_id: session.id };
      session.messages.push(msg);
      if (session.messages.length > 50) session.messages.shift();
      this._broadcast({ type: 'message', session_id: session.id, data: msg });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
      const csrfToken = this.csrfManager.generate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...this._initPayload(csrfToken),
        messages: this._allMessages(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/rotate-token') {
      if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
      if (!csrfOk()) { res.writeHead(403); res.end('CSRF token invalid'); return; }
      const newToken = this.tokenManager.rotate((msg) => this._broadcast(msg));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `farmer_token=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true, token: newToken }));
      return;
    }

    // --- Serve dashboard ---
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!authOk()) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...SECURITY_HEADERS });
        res.end(this._loginPage()); return;
      }
      const urlToken = url.searchParams.get('token');
      if (urlToken) {
        res.writeHead(302, {
          'Set-Cookie': `farmer_token=${this.tokenManager.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
          'Location': '/', 'Cache-Control': 'no-store',
        });
        res.end(); return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...SECURITY_HEADERS,
      });
      res.end(this._dashboardPage()); return;
    }

    // --- Static files from public/ ---
    if (req.method === 'GET' && url.pathname.startsWith('/')) {
      const safeName = url.pathname.slice(1).replace(/\.\./g, '');
      if (safeName && !safeName.includes('/')) {
        const filePath = join(PUBLIC_DIR, safeName);
        if (existsSync(filePath)) {
          const ext = safeName.split('.').pop();
          const mime = { js: 'application/javascript', css: 'text/css', json: 'application/json', html: 'text/html', png: 'image/png', svg: 'image/svg+xml' }[ext] || 'text/plain';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
          res.end(readFileSync(filePath));
          return;
        }
      }
    }

    res.writeHead(404); res.end('Not found');
  }

  // --- Permission handling ---
  _handlePermission(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (!session) { res.writeHead(403); res.end(JSON.stringify({ error: 'Session rejected' })); return; }

    const parsed = this.adapter.parseRequest(data);
    const requestId = parsed.requestId || randomBytes(8).toString('hex');
    const { toolName, toolInput, hookEvent, isQuestion } = parsed;

    // Agent tracking
    if (toolName === 'Agent') {
      session.agents.push({ id: requestId, description: toolInput?.description || '', status: 'running', startedAt: Date.now() });
      this._broadcast({ type: 'agent_start', session_id: session.id, data: { id: requestId } });
    }

    // Auto-approve check
    if (shouldAutoApprove(session, toolName, toolInput)) {
      const reason = `Auto-approved by ${session.trustLevel} trust level`;
      const responseBody = this.adapter.formatAutoApproveResponse(reason, { hookEvent });
      this._addActivity(session, { type: 'decision', tool_name: toolName, tool_input: toolInput, decision: 'auto-allowed', reason, session_id: session.id, timestamp: Date.now() });
      this.persistence.auditLog({ event: 'permission_decision', session_id: session.id, tool_name: toolName, decision: 'auto-allow', reason, requestId });
      this._broadcast({ type: 'auto_approved', session_id: session.id, data: { requestId, tool_name: toolName, reason } });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responseBody)); return;
    }

    // No-dashboard guard (stale server protection)
    if (this.sseClients.size === 0 && this.wsClients.size === 0) {
      const reason = 'Auto-approved: no dashboard clients connected (stale server guard)';
      const responseBody = this.adapter.formatAutoApproveResponse(reason, { hookEvent });
      this._addActivity(session, { type: 'decision', tool_name: toolName, tool_input: toolInput, decision: 'auto-allowed', reason, session_id: session.id, timestamp: Date.now() });
      this.persistence.auditLog({ event: 'permission_decision', session_id: session.id, tool_name: toolName, decision: 'auto-allow-no-dashboard', reason, requestId });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responseBody)); return;
    }

    // Enqueue for dashboard approval
    const event = {
      requestId, tool_name: toolName, tool_input: toolInput, isQuestion,
      session_id: session.id, session_label: session.label, session_color: session.color,
      permission_mode: data.permission_mode, cwd: data.cwd, hook_event_name: hookEvent,
      permission_suggestions: data.permission_suggestions,
    };

    this._broadcast({ type: 'permission_request', session_id: session.id, data: event });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (session.pending.has(requestId) && !resolved) {
        resolved = true;
        session.pending.delete(requestId);
        this._broadcast({ type: 'permission_expired', session_id: session.id, data: { requestId } });
        const denyBody = this.adapter.formatTimeoutResponse({ hookEvent });
        this.persistence.auditLog({ event: 'permission_decision', session_id: session.id, tool_name: toolName, decision: 'timeout', requestId });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(denyBody));
      }
    }, 120_000);

    session.pending.set(requestId, {
      resolve: (decision) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        session.pending.delete(requestId);

        const responseBody = this.adapter.formatResponse(decision, { hookEvent, isQuestion });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responseBody));

        this._addActivity(session, {
          type: 'decision', tool_name: toolName, tool_input: toolInput,
          decision: decision.allow ? 'allowed' : 'denied', reason: decision.reason,
          session_id: session.id, timestamp: Date.now(),
        });
        this.persistence.auditLog({
          event: 'permission_decision', session_id: session.id, tool_name: toolName,
          decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, requestId,
        });
        this._broadcast({ type: 'permission_resolved', session_id: session.id, data: { requestId, decision: decision.allow ? 'allowed' : 'denied' } });
      },
      data: event,
      timestamp: Date.now(),
    });
  }

  // --- Activity handling ---
  _handleActivity(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (!session) { res.writeHead(503); res.end(JSON.stringify({ error: 'Max sessions reached' })); return; }

    if (data.tool_name === 'Agent') {
      const agentId = data.tool_use_id || randomBytes(8).toString('hex');
      const a = session.agents.find(x => x.id === agentId);
      if (a) { a.status = 'done'; a.stoppedAt = Date.now(); }
      this._broadcast({ type: 'agent_stop', session_id: session.id, data: { id: agentId } });
    }

    this._addActivity(session, {
      type: data.hook_event_name === 'PostToolUseFailure' ? 'failure' : 'success',
      tool_name: data.tool_name, tool_input: data.tool_input,
      tool_result: data.tool_result ? summarizeResult(data.tool_result) : null,
      session_id: session.id, timestamp: Date.now(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  }

  // --- Notification handling ---
  _handleNotification(data, res, req) {
    const session = this._getSession(data.session_id, data.cwd, req);
    if (!session) { res.writeHead(503); res.end(JSON.stringify({ error: 'Max sessions reached' })); return; }

    const notif = this.adapter.parseNotification(data);
    const event = {
      requestId: data.tool_use_id || randomBytes(8).toString('hex'),
      type: 'question', tool_name: notif.toolName, prompt: notif.prompt,
      session_id: session.id, session_label: session.label, session_color: session.color,
      hook_event_name: notif.hookEvent, timestamp: Date.now(),
    };

    this._broadcast({ type: 'notification_card', session_id: session.id, data: event });
    this._addActivity(session, { type: 'notification', tool_name: notif.toolName, tool_input: { prompt: notif.prompt }, session_id: session.id, timestamp: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  }

  // --- Lifecycle handling ---
  _handleLifecycle(data, res, req) {
    const lc = this.adapter.parseLifecycle(data);
    if (lc.event === 'session_start') {
      const session = this._getSession(lc.sessionId, lc.cwd, req);
      if (!session) { res.writeHead(503); res.end(JSON.stringify({ error: 'Max sessions reached' })); return; }
      session.source = lc.source;
      session.status = 'active';
      this._broadcast({ type: 'session_start', session_id: lc.sessionId, data: this._sessionSummary(session) });
      // Replay buffered events
      const buffered = this.lifecycleBuffer.get(lc.sessionId);
      if (buffered?.length) {
        this.lifecycleBuffer.delete(lc.sessionId);
        for (const item of buffered) this._processSessionEnd(item.data, session);
      }
    } else if (lc.event === 'session_end') {
      const session = this.sessions.get(lc.sessionId);
      if (session) {
        this._processSessionEnd(data, session);
      } else {
        if (!this.lifecycleBuffer.has(lc.sessionId)) this.lifecycleBuffer.set(lc.sessionId, []);
        this.lifecycleBuffer.get(lc.sessionId).push({ data, receivedAt: Date.now() });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  }

  _processSessionEnd(data, session) {
    session.status = 'ended';
    session.endedAt = Date.now();
    session.endReason = data.reason;
    for (const [, entry] of session.pending) entry.resolve({ allow: false, reason: 'session ended' });
    this.sessionBindings.delete(session.id);
    this._broadcast({ type: 'session_end', session_id: session.id, data: { reason: data.reason } });
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
    if (!found) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request not found or expired' })); return; }
    if (found.data.isQuestion) {
      found.resolve({ response: response || '' });
    } else {
      found.resolve({ allow, reason });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  }

  // --- Trust level ---
  _handleTrustLevel(data, res) {
    const valid = ['paranoid', 'standard', 'autonomous'];
    if (!valid.includes(data.level)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid level' })); return;
    }
    if (data.session_id && this.sessions.has(data.session_id)) {
      const session = this.sessions.get(data.session_id);
      session.trustLevel = data.level;
      this._broadcast({ type: 'trust_level', session_id: session.id, data: { level: data.level } });
    } else {
      for (const [, session] of this.sessions) session.trustLevel = data.level;
      this._broadcast({ type: 'trust_level', data: { level: data.level } });
    }
    this.persistence.saveState(this.sessions);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, level: data.level }));
  }

  // --- Session rules ---
  _handleRules(data, res) {
    const { action, rule } = data;
    if (!rule?.tool) { res.writeHead(400); res.end(JSON.stringify({ error: 'rule.tool required' })); return; }
    const targets = (data.session_id && this.sessions.has(data.session_id))
      ? [this.sessions.get(data.session_id)]
      : [...this.sessions.values()];
    if (targets.length === 0) targets.push(this._getSession('default'));

    for (const session of targets) {
      if (action === 'add') {
        const exists = session.sessionRules.find(r => r.tool === rule.tool && (r.pattern || '') === (rule.pattern || ''));
        if (!exists) session.sessionRules.push({ tool: rule.tool, pattern: rule.pattern || null });
      } else if (action === 'remove') {
        const idx = session.sessionRules.findIndex(r => r.tool === rule.tool && (r.pattern || '') === (rule.pattern || ''));
        if (idx !== -1) session.sessionRules.splice(idx, 1);
      } else {
        res.writeHead(400); res.end(JSON.stringify({ error: 'action must be add or remove' })); return;
      }
    }
    this.persistence.saveState(this.sessions);
    this._broadcast({ type: 'rules_updated', data: { sessionRules: targets[0].sessionRules } });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, sessionRules: targets[0].sessionRules }));
  }

  // --- WebSocket upgrade ---
  _handleWsUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }

    // Origin check
    const origin = req.headers.origin || '';
    if (origin) {
      try {
        const o = new URL(origin);
        const isLocal = ['localhost', '127.0.0.1', '::1'].includes(o.hostname);
        const isSameHost = o.host === req.headers.host;
        if (!isLocal && !isSameHost) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      } catch { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const GUID = '258EAFA5-E914-47DA-95CA-5AB5DC799B07';
    const acceptKey = createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n');

    const client = { socket, buffer: Buffer.alloc(0), alive: true, authenticated: false, fragments: [] };
    this.wsClients.add(client);

    socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      if (client.buffer.length > this.MAX_WS_BUFFER_SIZE) { this.wsClients.delete(client); socket.destroy(); return; }
      while (true) {
        const frame = wsDecodeFrame(client.buffer);
        if (!frame) break;
        client.buffer = client.buffer.slice(frame.bytesConsumed);

        if (frame.opcode === 0x08) { // Close
          const cf = Buffer.alloc(2); cf[0] = 0x88; cf[1] = 0;
          try { socket.write(cf); } catch {}
          this.wsClients.delete(client); socket.destroy(); return;
        }
        if (frame.opcode === 0x09) { // Ping
          const pong = Buffer.alloc(2); pong[0] = 0x8a; pong[1] = 0;
          try { socket.write(pong); } catch {} continue;
        }
        if (frame.opcode === 0x0a) { client.alive = true; continue; } // Pong
        if (frame.opcode === 0x00) { // Continuation
          client.fragments.push(frame.payload);
          if (frame.fin) { this._handleWsText(client, Buffer.concat(client.fragments)); client.fragments = []; }
          continue;
        }
        if (frame.opcode === 0x01) { // Text
          if (!frame.fin) { client.fragments = [frame.payload]; continue; }
          this._handleWsText(client, frame.payload);
        }
      }
    });

    socket.on('close', () => this.wsClients.delete(client));
    socket.on('error', () => this.wsClients.delete(client));
    if (head?.length) socket.emit('data', head);
  }

  _handleWsText(client, payload) {
    const text = payload.toString('utf8');
    if (!client.authenticated) {
      let token = text;
      try { const msg = JSON.parse(text); if (msg.type === 'auth' && msg.token) token = msg.token; } catch {}
      if (this.tokenManager.matches(token)) {
        client.authenticated = true;
        const csrfToken = this.csrfManager.generate();
        this._wsSend(client, { type: 'init', data: this._initPayload(csrfToken) });
      } else {
        this._wsSend(client, { type: 'error', data: 'Authentication failed' });
        const cf = Buffer.alloc(2); cf[0] = 0x88; cf[1] = 0;
        try { client.socket.write(cf); } catch {}
        this.wsClients.delete(client);
        try { client.socket.destroy(); } catch {}
      }
      return;
    }
    // Authenticated — no client messages expected currently
  }

  _wsSend(client, msg) {
    try { client.socket.write(wsEncodeFrame(JSON.stringify(msg))); }
    catch { this.wsClients.delete(client); try { client.socket.destroy(); } catch {} }
  }

  // --- Init payload (shared between SSE + WS) ---
  _initPayload(csrfToken) {
    const defaultSession = this.sessions.get('default');
    return {
      pending: this._allPending(),
      activity: this._allActivity(),
      claims: null,
      compilation: null,
      trustLevel: defaultSession?.trustLevel || 'paranoid',
      sessionRules: defaultSession?.sessionRules || [],
      agents: this._allAgents(),
      sessions: this._allSessionsSummary(),
      csrfToken,
    };
  }

  // --- Timers ---
  _heartbeat() {
    const heartbeats = [];
    for (const [id, session] of this.sessions) {
      if (session.status === 'ended') continue;
      heartbeats.push({
        id, label: session.label, status: session.status,
        lastActivity: session.lastActivity, pending_count: session.pending.size,
        oldest_pending: session.pending.size > 0 ? Math.min(...[...session.pending.values()].map(p => p.timestamp)) : null,
      });
    }
    if (heartbeats.length > 0 || this.sseClients.size > 0 || this.wsClients.size > 0) {
      this._broadcast({ type: 'heartbeat', data: { serverTime: Date.now(), sessions: heartbeats } });
    }
  }

  _detectStale() {
    for (const [id, session] of this.sessions) {
      if (session.isStale()) {
        session.status = 'stale';
        this._broadcast({ type: 'session_stale', session_id: id, data: this._sessionSummary(session) });
      }
    }
  }

  _reapSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const age = now - session.lastActivity;
      if ((session.status === 'ended' && age > this.ENDED_TTL) || (session.status === 'stale' && age > this.STALE_TTL)) {
        this._evictSession(id);
      }
    }
  }

  _wsHeartbeat() {
    for (const client of this.wsClients) {
      if (!client.alive) { this.wsClients.delete(client); try { client.socket.destroy(); } catch {} continue; }
      client.alive = false;
      const ping = Buffer.alloc(2); ping[0] = 0x89; ping[1] = 0;
      try { client.socket.write(ping); } catch { this.wsClients.delete(client); try { client.socket.destroy(); } catch {} }
    }
  }

  _cleanLifecycleBuffer() {
    const now = Date.now();
    for (const [sid, items] of this.lifecycleBuffer) {
      const fresh = items.filter(i => now - i.receivedAt < 30_000);
      if (fresh.length === 0) this.lifecycleBuffer.delete(sid);
      else this.lifecycleBuffer.set(sid, fresh);
    }
  }

  // --- HTML pages ---
  _parseCookies(req) {
    const h = req.headers.cookie || '';
    const map = {};
    h.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) map[k] = v.join('='); });
    return map;
  }

  _loginPage() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Farmer — Login</title>
<style>
body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.login{background:#1e293b;padding:40px;border-radius:16px;border:1px solid rgba(255,255,255,0.06);max-width:380px;width:100%}
h1{font-size:20px;margin-bottom:8px}
p{color:#94a3b8;font-size:14px;margin-bottom:20px}
input{width:100%;padding:10px 14px;border:1px solid rgba(255,255,255,0.1);background:#0a0e1a;color:#f1f5f9;border-radius:8px;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.1)}
</style></head><body>
<div class="login"><h1>Farmer</h1><p>Enter the dashboard token from your terminal.</p>
<form onsubmit="location.href='/?token='+document.getElementById('t').value;return false;">
<input id="t" type="password" placeholder="Token" autofocus><button type="submit">Connect</button></form></div></body></html>`;
  }

  _dashboardPage() {
    const htmlPath = join(PUBLIC_DIR, 'index.html');
    try {
      let html = readFileSync(htmlPath, 'utf8');
      return html.replace('{{TOKEN}}', this.tokenManager.token);
    } catch {
      return '<html><body>Dashboard not found. Check public/index.html.</body></html>';
    }
  }
}
