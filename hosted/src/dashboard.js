/**
 * Hosted Farmer Dashboard — inline HTML served by the Worker.
 * WebSocket-based (not SSE) for DO hibernation compatibility.
 * Mobile-first, dark theme, swipe approve/deny.
 *
 * Placeholders replaced by Worker at serve time:
 *   __SPRINT_TOKEN__, __WS_URL__, __ROLE__
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Farmer</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%230a0e1a'/><text x='32' y='34' text-anchor='middle' dominant-baseline='central' fill='%233b82f6' font-family='-apple-system,system-ui,sans-serif' font-size='34' font-weight='800'>F</text></svg>">
<style>
:root {
  --bg: #0a0e1a;
  --bg2: rgba(255,255,255,0.06);
  --bg3: rgba(255,255,255,0.10);
  --glass: rgba(255,255,255,0.08);
  --glass-border: rgba(255,255,255,0.12);
  --accent: #3b82f6;
  --accent-light: #60a5fa;
  --accent-dim: rgba(59,130,246,0.10);
  --green: #22c55e;
  --orange: #f59e0b;
  --red: #ef4444;
  --purple: #a78bfa;
  --text: #f1f5f9;
  --muted: #94a3b8;
  --dim: #64748b;
  --border: rgba(255,255,255,0.08);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html { overflow: hidden; max-width: 100vw; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  background-image: radial-gradient(ellipse at 20% 50%, rgba(59,130,246,0.08) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 20%, rgba(167,139,250,0.06) 0%, transparent 50%);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
  height: 100dvh;
  overflow: hidden;
  position: fixed;
  width: 100%;
}
.app { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }

/* Header */
.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 16px;
  padding-top: calc(6px + env(safe-area-inset-top));
  background: var(--glass);
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}
.header h1 {
  font-size: 18px; font-weight: 800; letter-spacing: -0.03em;
  background: linear-gradient(135deg, #f0a030, #fbbf24, #f59e0b);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
}
.header .status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); transition: background 0.3s; }
.header .dot.connected { background: var(--green); }
.header .dot.reconnecting { background: var(--orange); animation: pulse 1s infinite; }

.trust-badge {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; padding: 3px 10px; border-radius: 12px; margin-left: 8px;
}
.trust-badge.paranoid { background: rgba(239,68,68,0.15); color: var(--red); }
.trust-badge.standard { background: rgba(245,158,11,0.15); color: var(--orange); }
.trust-badge.autonomous { background: rgba(34,197,94,0.15); color: var(--green); }

.role-badge {
  display: none; font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.1em; padding: 3px 12px; border-radius: 12px;
  margin-left: 8px; color: #60a5fa; border: 1px solid rgba(96,165,250,0.3);
  background: rgba(96,165,250,0.1);
}
body.viewer .role-badge { display: inline-block; }
body.viewer .perm-actions, body.viewer .trust-select, body.viewer .feedback-box { display: none !important; }

/* Connection banner */
.conn-banner {
  display: none; padding: 10px 16px; text-align: center; font-size: 13px; font-weight: 600;
}
.conn-banner.disconnected { display: block; background: rgba(245,158,11,0.12); color: var(--orange); border-bottom: 1px solid rgba(245,158,11,0.25); }
.conn-banner.failed { display: block; background: rgba(239,68,68,0.12); color: var(--red); border-bottom: 1px solid rgba(239,68,68,0.25); }
.conn-banner .sub { font-size: 11px; font-weight: 400; opacity: 0.7; margin-top: 2px; }

/* Tabs */
.tabs {
  display: flex; background: var(--glass); border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0; overflow-x: auto; scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  padding: 10px 20px; font-size: 13px; font-weight: 500; color: var(--muted);
  cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s;
  position: relative; white-space: nowrap;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent-light); border-bottom-color: var(--accent); }
.tab .badge {
  position: absolute; top: 6px; right: 4px;
  background: var(--red); color: white; font-size: 10px; font-weight: 700;
  min-width: 16px; height: 16px; line-height: 16px; text-align: center;
  padding: 0 4px; border-radius: 8px; animation: pulse 2s infinite;
}
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

/* Content area */
.content {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 16px; max-width: 100%; word-break: break-word;
  scrollbar-width: none;
}
.content::-webkit-scrollbar { display: none; }
.panel { display: none; }
.panel.active { display: block; }

/* Permission cards */
.perm-card {
  background: var(--glass); border: 1px solid var(--glass-border);
  border-radius: 12px; padding: 16px; margin-bottom: 12px;
  position: relative; overflow: hidden;
  touch-action: pan-y;
}
.perm-card .tool-name {
  font-weight: 700; font-size: 15px; color: var(--accent-light);
  display: flex; align-items: center; gap: 8px;
}
.perm-card .tool-name .session-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
}
.perm-card .tool-input {
  margin-top: 8px; font-size: 12px; color: var(--muted);
  background: var(--bg2); padding: 8px 12px; border-radius: 8px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
}
.perm-card .perm-actions {
  display: flex; gap: 8px; margin-top: 12px;
}
.perm-card .perm-actions button {
  flex: 1; padding: 10px; border: none; border-radius: 8px;
  font-size: 14px; font-weight: 700; cursor: pointer;
  min-height: 48px; /* WCAG touch target */
}
.btn-approve { background: rgba(34,197,94,0.2); color: var(--green); }
.btn-approve:active { background: rgba(34,197,94,0.35); }
.btn-deny { background: rgba(239,68,68,0.2); color: var(--red); }
.btn-deny:active { background: rgba(239,68,68,0.35); }

/* Swipe reveal */
.perm-card .swipe-bg {
  position: absolute; top: 0; bottom: 0; width: 100%; display: flex;
  align-items: center; font-weight: 800; font-size: 18px; padding: 0 24px;
  pointer-events: none; z-index: 0;
}
.perm-card .perm-actions { position: relative; z-index: 1; }
.perm-card .swipe-bg.approve { left: 0; background: rgba(34,197,94,0.25); color: var(--green); justify-content: flex-start; }
.perm-card .swipe-bg.deny { right: 0; background: rgba(239,68,68,0.25); color: var(--red); justify-content: flex-end; }

/* Activity feed */
.activity-item {
  padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px;
}
.activity-item .tool { font-weight: 600; color: var(--accent-light); }
.activity-item .result { color: var(--muted); font-size: 12px; margin-top: 2px; }
.activity-item .time { color: var(--dim); font-size: 11px; float: right; }
.activity-item.decision-allowed .tool::before { content: '\\2713 '; color: var(--green); }
.activity-item.decision-denied .tool::before { content: '\\2717 '; color: var(--red); }
.activity-item.auto-allowed .tool::before { content: '\\2713 '; color: var(--dim); }

/* Trust selector */
.trust-select {
  display: flex; gap: 8px; padding: 12px 0;
}
.trust-select button {
  flex: 1; padding: 10px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--muted); font-size: 12px; font-weight: 600;
  cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em;
  min-height: 48px;
}
.trust-select button.active { border-color: var(--accent); color: var(--accent-light); background: var(--accent-dim); }

/* Feedback */
.feedback-box {
  display: flex; gap: 8px; padding: 12px 0;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
  position: sticky; bottom: 0; background: var(--bg);
}
.feedback-box input {
  flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg2); color: var(--text); font-size: 14px; outline: none;
  min-height: 48px;
}
.feedback-box input:focus { border-color: var(--accent); }
.feedback-box button {
  padding: 10px 20px; border: none; border-radius: 8px;
  background: var(--accent); color: white; font-weight: 700; cursor: pointer;
  min-height: 48px;
}

/* Empty state */
.empty {
  text-align: center; padding: 48px 24px; color: var(--dim); font-size: 14px;
}

/* Session sidebar (desktop) */
@media (min-width: 768px) {
  .app { flex-direction: row; }
  .sidebar {
    width: 240px; flex-shrink: 0; border-right: 1px solid var(--glass-border);
    display: flex; flex-direction: column; overflow-y: auto;
  }
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .header { display: none; }
  .sidebar .header { display: flex; border-bottom: 1px solid var(--glass-border); }
}
@media (max-width: 767px) {
  .sidebar { display: none; }
}

.session-item {
  padding: 10px 16px; border-bottom: 1px solid var(--border); cursor: pointer;
  display: flex; align-items: center; gap: 10px; font-size: 13px;
}
.session-item:hover { background: var(--bg2); }
.session-item.active { background: var(--accent-dim); }
.session-item .sdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.session-item .slabel { font-weight: 600; color: var(--text); }
.session-item .sstatus { font-size: 11px; color: var(--dim); margin-left: auto; }

/* Stealth: farmer-unlock */
.unlock-overlay {
  display: none; position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.92); backdrop-filter: blur(8px);
  justify-content: center; align-items: center; flex-direction: column;
  gap: 16px; padding: 24px;
}
.unlock-overlay.active { display: flex; }
.unlock-overlay .ul-title {
  font-size: 24px; font-weight: 800;
  background: linear-gradient(135deg, #f0a030, #fbbf24); -webkit-background-clip: text;
  -webkit-text-fill-color: transparent; background-clip: text;
}
.unlock-overlay .ul-grid {
  display: grid; grid-template-columns: repeat(3, 64px); gap: 8px;
}
.unlock-overlay .ul-cell {
  width: 64px; height: 64px; border-radius: 12px;
  background: var(--glass); border: 1px solid var(--glass-border);
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; cursor: pointer; transition: all 0.15s;
  user-select: none; -webkit-user-select: none;
}
.unlock-overlay .ul-cell:active { transform: scale(0.9); }
.unlock-overlay .ul-cell.matched { background: rgba(34,197,94,0.3); border-color: var(--green); }
.unlock-overlay .ul-msg { font-size: 14px; color: var(--muted); min-height: 20px; }
</style>
</head>
<body class="__ROLE__">
<div class="app">
  <!-- Mobile header -->
  <div class="header">
    <h1>Farmer</h1>
    <div class="status">
      <div class="dot" id="connDot"></div>
      <span id="connLabel">connecting</span>
      <span class="trust-badge" id="trustBadge"></span>
      <span class="role-badge">viewer</span>
    </div>
  </div>

  <!-- Connection banner -->
  <div class="conn-banner" id="connBanner">
    <div class="conn-text" id="connText"></div>
    <div class="sub" id="connSub"></div>
  </div>

  <!-- Desktop sidebar -->
  <div class="sidebar">
    <div class="header">
      <h1>Farmer</h1>
      <div class="status">
        <div class="dot" id="connDot2"></div>
        <span class="trust-badge" id="trustBadge2"></span>
        <span class="role-badge">viewer</span>
      </div>
    </div>
    <div id="sessionList"></div>
  </div>

  <div class="main">
    <!-- Tabs -->
    <div class="tabs">
      <div class="tab active" data-tab="permissions" onclick="switchTab('permissions')">
        Permissions<span class="badge" id="permBadge" style="display:none"></span>
      </div>
      <div class="tab" data-tab="activity" onclick="switchTab('activity')">Activity</div>
      <div class="tab" data-tab="settings" onclick="switchTab('settings')">Settings</div>
    </div>

    <!-- Panels -->
    <div class="content">
      <div class="panel active" id="panel-permissions">
        <div id="permList"></div>
        <div class="empty" id="permEmpty">No pending permissions</div>
      </div>

      <div class="panel" id="panel-activity">
        <div id="activityList"></div>
        <div class="empty" id="activityEmpty">No activity yet</div>
      </div>

      <div class="panel" id="panel-settings">
        <h3 style="margin-bottom:8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.1em">Trust Level</h3>
        <div class="trust-select" id="trustSelect">
          <button data-level="paranoid" onclick="setTrust('paranoid')">Paranoid</button>
          <button data-level="standard" onclick="setTrust('standard')">Standard</button>
          <button data-level="autonomous" onclick="setTrust('autonomous')">Autonomous</button>
        </div>
        <h3 style="margin:16px 0 8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.1em">Sessions</h3>
        <div id="sessionGrid"></div>
      </div>

      <!-- Feedback input (admin only) -->
      <div class="feedback-box">
        <input type="text" id="feedbackInput" placeholder="Send feedback to agent..." />
        <button onclick="sendFeedback()">Send</button>
      </div>
    </div>
  </div>
</div>

<!-- Farmer-unlock stealth overlay -->
<div class="unlock-overlay" id="unlockOverlay">
  <div class="ul-title">farmer unlock</div>
  <div class="ul-grid" id="unlockGrid"></div>
  <div class="ul-msg" id="unlockMsg"></div>
</div>

<script>
(function() {
  'use strict';

  const SPRINT_TOKEN = '__SPRINT_TOKEN__';
  const WS_URL = '__WS_URL__';
  const ROLE = '__ROLE__';

  // ── State ──
  let state = { sessions: [], pending: [], activity: [], trustLevel: 'paranoid', sessionRules: [] };
  let ws = null;
  let lastCursor = parseInt(localStorage.getItem('farmer_cursor_' + SPRINT_TOKEN) || '0', 10);
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  // ── WebSocket connection with reconnection ──

  function connect() {
    const url = WS_URL + (lastCursor ? '&cursor=' + lastCursor : '');
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempt = 0;
      setConnState('connected');
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      // Track cursor for replay
      if (msg.cursor) {
        lastCursor = msg.cursor;
        localStorage.setItem('farmer_cursor_' + SPRINT_TOKEN, String(lastCursor));
      }

      handleMessage(msg);
    };

    ws.onclose = () => {
      setConnState('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      setConnState('disconnected');
    };

    // Keepalive: send ping every 30s to reset CF's 100s idle timeout
    const pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
      else clearInterval(pingInterval);
    }, 30000);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + Math.random() * 500, 30000);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    }, delay);
  }

  // Reconnect on tab focus (iOS kills WS in background)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState !== WebSocket.OPEN)) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempt = 0;
      connect();
    }
  });

  // ── Connection state UI ──

  function setConnState(s) {
    const dot = document.getElementById('connDot');
    const dot2 = document.getElementById('connDot2');
    const label = document.getElementById('connLabel');
    const banner = document.getElementById('connBanner');
    const text = document.getElementById('connText');
    const sub = document.getElementById('connSub');

    dot.className = 'dot' + (s === 'connected' ? ' connected' : s === 'disconnected' ? ' reconnecting' : '');
    if (dot2) dot2.className = dot.className;
    label.textContent = s;
    banner.className = 'conn-banner' + (s === 'disconnected' ? ' disconnected' : s === 'failed' ? ' failed' : '');
    if (s === 'disconnected') {
      text.textContent = 'Reconnecting...';
      sub.textContent = 'Attempt ' + (reconnectAttempt + 1);
    }
  }

  // ── Message handling ──

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        state = msg.data;
        renderAll();
        break;
      case 'replay': {
        const d = msg.data;
        if (d) handleEvent(d);
        break;
      }
      case 'permission_request':
        state.pending.push({ id: msg.data.requestId, ...msg.data });
        renderPermissions();
        break;
      case 'permission_resolved':
      case 'permission_expired':
        state.pending = state.pending.filter(p => p.id !== (msg.data?.requestId || msg.data?.id));
        renderPermissions();
        // fall through to log
      case 'auto_approved':
      case 'activity':
      case 'success':
      case 'failure':
      case 'notification_card':
      case 'decision':
        state.activity.unshift({ type: msg.type, ...msg.data, timestamp: msg.data?.timestamp || Date.now() });
        if (state.activity.length > 200) state.activity.length = 200;
        renderActivity();
        break;
      case 'trust_level':
        state.trustLevel = msg.data.level;
        renderTrust();
        break;
      case 'rules_updated':
        state.sessionRules = msg.data.rules || [];
        break;
      case 'session_new':
      case 'session_start':
        upsertSession(msg.data);
        renderSessions();
        break;
      case 'session_end':
      case 'session_idle':
        updateSessionStatus(msg.session_id || msg.data?.id, msg.type === 'session_end' ? 'ended' : 'idle');
        renderSessions();
        break;
      case 'user_feedback':
      case 'message':
        break; // visual only
    }
  }

  function handleEvent(d) {
    // Replay events from activity_log
    state.activity.unshift(d);
    if (state.activity.length > 200) state.activity.length = 200;
    renderActivity();
  }

  // ── Session helpers ──

  function upsertSession(s) {
    const idx = state.sessions.findIndex(x => x.id === s.id);
    if (idx >= 0) Object.assign(state.sessions[idx], s);
    else state.sessions.push(s);
  }

  function updateSessionStatus(id, status) {
    const s = state.sessions.find(x => x.id === id);
    if (s) s.status = status;
  }

  // ── Rendering ──

  function renderAll() {
    renderPermissions();
    renderActivity();
    renderTrust();
    renderSessions();
  }

  function renderPermissions() {
    const list = document.getElementById('permList');
    const empty = document.getElementById('permEmpty');
    const badge = document.getElementById('permBadge');

    if (!state.pending.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      badge.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    badge.style.display = 'inline-block';
    badge.textContent = state.pending.length;

    list.innerHTML = state.pending.map(p => {
      const color = 'hsl(' + (p.session_color || 200) + ', 70%, 60%)';
      const input = escHtml(typeof p.tool_input === 'string' ? p.tool_input : JSON.stringify(p.tool_input || '').slice(0, 500));
      return '<div class="perm-card" data-id="' + p.id + '">' +
        '<div class="tool-name"><span class="session-dot" style="background:' + color + '"></span>' + escHtml(p.tool_name || 'unknown') + '</div>' +
        (input ? '<div class="tool-input">' + input + '</div>' : '') +
        '<div class="perm-actions">' +
        '<button class="btn-approve" onclick="decide(\\'' + p.id + '\\',true)">Approve</button>' +
        '<button class="btn-deny" onclick="decide(\\'' + p.id + '\\',false)">Deny</button>' +
        '</div></div>';
    }).join('');

    // Setup swipe on cards
    list.querySelectorAll('.perm-card').forEach(setupSwipe);
  }

  function renderActivity() {
    const list = document.getElementById('activityList');
    const empty = document.getElementById('activityEmpty');

    if (!state.activity.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = state.activity.slice(0, 100).map(a => {
      const cls = a.decision === 'allowed' || a.decision === 'auto-allowed'
        ? 'decision-allowed' : a.decision === 'denied' ? 'decision-denied'
        : a.type === 'auto_approved' ? 'auto-allowed' : '';
      const time = a.timestamp ? timeAgo(a.timestamp) : '';
      return '<div class="activity-item ' + cls + '">' +
        '<span class="time">' + time + '</span>' +
        '<span class="tool">' + escHtml(a.tool_name || a.type || '') + '</span>' +
        (a.tool_result ? '<div class="result">' + escHtml(String(a.tool_result).slice(0, 200)) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderTrust() {
    const badge = document.getElementById('trustBadge');
    const badge2 = document.getElementById('trustBadge2');
    const level = state.trustLevel || 'paranoid';
    [badge, badge2].forEach(b => {
      if (!b) return;
      b.textContent = level;
      b.className = 'trust-badge ' + level;
    });
    document.querySelectorAll('.trust-select button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === level);
    });
  }

  function renderSessions() {
    const list = document.getElementById('sessionList');
    const grid = document.getElementById('sessionGrid');
    if (!state.sessions.length) {
      if (list) list.innerHTML = '<div class="empty">No sessions</div>';
      if (grid) grid.innerHTML = '<div class="empty">No sessions</div>';
      return;
    }
    const html = state.sessions.map(s => {
      const color = 'hsl(' + (s.color || 200) + ', 70%, 60%)';
      return '<div class="session-item">' +
        '<span class="sdot" style="background:' + color + '"></span>' +
        '<span class="slabel">' + escHtml(s.label) + '</span>' +
        '<span class="sstatus">' + s.status + '</span>' +
        '</div>';
    }).join('');
    if (list) list.innerHTML = html;
    if (grid) grid.innerHTML = html;
  }

  // ── Actions ──

  window.decide = function(requestId, allow) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'decide', requestId, allow, reason: allow ? null : 'Denied by user' }));
    }
    // Optimistic remove
    state.pending = state.pending.filter(p => p.id !== requestId);
    renderPermissions();
  };

  window.setTrust = function(level) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'trust_level', level }));
    }
    state.trustLevel = level;
    renderTrust();
  };

  window.sendFeedback = function() {
    const input = document.getElementById('feedbackInput');
    const text = input.value.trim();
    if (!text) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'feedback', text }));
    }
    input.value = '';
  };

  window.switchTab = function(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
  };

  // Enter key for feedback
  document.getElementById('feedbackInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendFeedback(); }
  });

  // ── Swipe-to-decide ──

  function setupSwipe(card) {
    let startX = 0, deltaX = 0, swiping = false;
    const threshold = 80;

    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      deltaX = 0;
      swiping = true;
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!swiping) return;
      deltaX = e.touches[0].clientX - startX;
      card.style.transform = 'translateX(' + deltaX + 'px)';
      card.style.opacity = String(1 - Math.abs(deltaX) / 300);
    }, { passive: true });

    card.addEventListener('touchend', () => {
      if (!swiping) return;
      swiping = false;
      const id = card.dataset.id;
      if (deltaX > threshold) {
        card.style.transform = 'translateX(100vw)';
        card.style.opacity = '0';
        setTimeout(() => decide(id, true), 200);
      } else if (deltaX < -threshold) {
        card.style.transform = 'translateX(-100vw)';
        card.style.opacity = '0';
        setTimeout(() => decide(id, false), 200);
      } else {
        card.style.transform = '';
        card.style.opacity = '';
      }
    });
  }

  // ── farmer-unlock stealth feature ──
  // Activated by typing "farmer unlock" anywhere on the page.
  // A 3x3 emoji grid puzzle — match pairs to unlock autonomous mode.

  let unlockBuffer = '';
  const UNLOCK_PHRASE = 'farmer unlock';

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    unlockBuffer += e.key.toLowerCase();
    if (unlockBuffer.length > 30) unlockBuffer = unlockBuffer.slice(-30);
    if (unlockBuffer.endsWith(UNLOCK_PHRASE)) {
      unlockBuffer = '';
      startUnlock();
    }
  });

  const UNLOCK_EMOJIS = ['\\u{1F33E}','\\u{1F331}','\\u{1F33B}','\\u{1F344}','\\u{2728}','\\u{1F525}','\\u{1F30A}','\\u{26A1}','\\u{1F48E}'];

  function startUnlock() {
    const overlay = document.getElementById('unlockOverlay');
    const grid = document.getElementById('unlockGrid');
    const msg = document.getElementById('unlockMsg');
    overlay.classList.add('active');
    msg.textContent = 'Match the pattern to unlock';

    // Generate a random 3x3 grid with 4 pairs + 1 center unique
    const pool = [...UNLOCK_EMOJIS].sort(() => Math.random() - 0.5);
    const pairs = pool.slice(0, 4);
    const center = pool[4];
    const cells = [...pairs, ...pairs, center].sort(() => Math.random() - 0.5);

    const solution = pairs.map(p => cells.indexOf(p)); // first occurrence of each pair
    let selected = [];
    let matchCount = 0;

    grid.innerHTML = cells.map((emoji, i) =>
      '<div class="ul-cell" data-idx="' + i + '">' + emoji + '</div>'
    ).join('');

    grid.querySelectorAll('.ul-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const idx = parseInt(cell.dataset.idx, 10);
        if (cell.classList.contains('matched')) return;

        selected.push(idx);
        cell.style.background = 'rgba(59,130,246,0.3)';

        if (selected.length === 2) {
          const [a, b] = selected;
          const ea = cells[a], eb = cells[b];
          if (a !== b && ea === eb) {
            matchCount++;
            grid.children[a].classList.add('matched');
            grid.children[b].classList.add('matched');
            msg.textContent = matchCount + '/4 matched';

            if (matchCount >= 4) {
              msg.textContent = 'Unlocked! Switching to autonomous...';
              setTimeout(() => {
                overlay.classList.remove('active');
                setTrust('autonomous');
              }, 800);
            }
          } else {
            setTimeout(() => {
              grid.children[a].style.background = '';
              grid.children[b].style.background = '';
            }, 400);
          }
          selected = [];
        }
      });
    });

    // Close on escape
    const closeHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.classList.remove('active');
        document.removeEventListener('keydown', closeHandler);
      }
    };
    document.addEventListener('keydown', closeHandler);
  }

  // ── Helpers ──

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'now';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h';
  }

  // ── Boot ──
  connect();
})();
</script>
</body>
</html>`;
