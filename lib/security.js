/**
 * Security utilities — CSP headers, token auth, CSRF, audit logging.
 *
 * Zero npm dependencies.
 */

import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';

// --- Content Security Policy headers ---
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};

// --- Single-role token state (internal) ---
class RoleToken {
  constructor(token, gracePeriod) {
    this.token = token || randomBytes(16).toString('hex');
    this.gracePeriod = gracePeriod;
    this.retiredTokens = []; // [{ token, retiredAt }]
  }

  rotate() {
    const oldToken = this.token;
    this.token = randomBytes(16).toString('hex');
    this.retiredTokens.push({ token: oldToken, retiredAt: Date.now() });
    this._purgeRetired();
    return this.token;
  }

  matches(provided) {
    if (!provided) return false;
    if (_safeEqual(provided, this.token)) return true;
    const cutoff = Date.now() - this.gracePeriod * 1000;
    for (const rt of this.retiredTokens) {
      if (rt.retiredAt > cutoff && _safeEqual(provided, rt.token)) return true;
    }
    return false;
  }

  _purgeRetired() {
    const cutoff = Date.now() - this.gracePeriod * 1000;
    this.retiredTokens = this.retiredTokens.filter(t => t.retiredAt > cutoff);
  }
}

function _safeEqual(a, b) {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// --- Token management (dual-token: admin + viewer) ---
export class TokenManager {
  /**
   * @param {object} opts
   * @param {string}  opts.token - Initial admin token (or auto-generated)
   * @param {string}  opts.viewerToken - Initial viewer token (or auto-generated)
   * @param {number}  opts.rotationInterval - Seconds between rotations (0 = disabled)
   * @param {number}  opts.gracePeriod - Seconds old tokens remain valid
   */
  constructor(opts = {}) {
    this.gracePeriod = opts.gracePeriod || 60;
    this._admin = new RoleToken(opts.token || undefined, this.gracePeriod);
    this._viewer = new RoleToken(opts.viewerToken || undefined, this.gracePeriod);
    this.rotationInterval = opts.rotationInterval || 0;
    this._rotationTimer = null;

    // Backwards compat: expose admin token as .token
    Object.defineProperty(this, 'token', {
      get: () => this._admin.token,
      set: (v) => { this._admin.token = v; },
    });

    if (this.rotationInterval > 0) {
      this._rotationTimer = setInterval(() => this.rotate(), this.rotationInterval * 1000);
    }
  }

  /** The viewer token. */
  get viewerToken() { return this._viewer.token; }

  /** Rotate admin token, keeping old one valid during grace period. */
  rotate(broadcastFn) {
    const newToken = this._admin.rotate();
    console.log(`  [rotate] Admin token rotated. New: ${newToken.slice(0, 8)}...`);
    if (broadcastFn) {
      broadcastFn({ type: 'token_rotated', data: { newToken, gracePeriod: this.gracePeriod } });
    }
    return newToken;
  }

  /** Rotate viewer token independently. */
  rotateViewer(broadcastFn) {
    const newToken = this._viewer.rotate();
    console.log(`  [rotate] Viewer token rotated. New: ${newToken.slice(0, 8)}...`);
    if (broadcastFn) {
      broadcastFn({ type: 'viewer_token_rotated', data: { gracePeriod: this.gracePeriod } });
    }
    return newToken;
  }

  /**
   * Check if a provided token matches any role.
   * @returns {'admin' | 'viewer' | null}
   */
  matches(provided) {
    if (!provided) return null;
    if (this._admin.matches(provided)) return 'admin';
    if (this._viewer.matches(provided)) return 'viewer';
    return null;
  }

  /** Stop auto-rotation timer. */
  destroy() {
    if (this._rotationTimer) {
      clearInterval(this._rotationTimer);
      this._rotationTimer = null;
    }
  }

  /** Serialize both tokens to JSON for persistence. */
  toJSON() {
    return { admin: this._admin.token, viewer: this._viewer.token };
  }

  /**
   * Load tokens from persisted data.
   * Handles backwards compat: plain text = admin token, generate viewer.
   * @param {string} raw - Raw file content (plain text or JSON)
   * @returns {{ admin: string, viewer: string }}
   */
  static parseTokenFile(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { admin: '', viewer: '' };
    // Try JSON first
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return { admin: parsed.admin || '', viewer: parsed.viewer || '' };
      } catch { /* fall through to plain text */ }
    }
    // Plain text = old format, treat as admin token
    return { admin: trimmed, viewer: '' };
  }

  /**
   * Generate an HMAC signature for invite URLs.
   * @param {string} role - 'viewer' or 'admin'
   * @param {number} exp - expiration timestamp
   * @returns {string} hex HMAC
   */
  signInvite(role, exp) {
    const secret = this._admin.token;
    return createHmac('sha256', secret).update(`${role}:${exp}`).digest('hex');
  }

  /**
   * Verify an invite HMAC.
   * @returns {boolean}
   */
  verifyInvite(role, exp, sig) {
    const expected = this.signInvite(role, exp);
    return _safeEqual(sig, expected);
  }
}

// --- CSRF token management ---
export class CsrfManager {
  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.tokens = new Map(); // token -> { createdAt }
    this.ttl = ttlMs;

    // Periodic cleanup every hour
    this._cleanupTimer = setInterval(() => this._cleanup(), 60 * 60 * 1000);
  }

  generate() {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { createdAt: Date.now() });
    return token;
  }

  validate(token) {
    if (!token) return false;
    const entry = this.tokens.get(token);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > this.ttl) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [t, entry] of this.tokens) {
      if (now - entry.createdAt > this.ttl) this.tokens.delete(t);
    }
  }
}

// --- PID lock ---
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export class PidLock {
  constructor(pidPath) {
    this.pidPath = pidPath;
  }

  /**
   * Acquire the PID lock. Throws if another instance is running.
   */
  acquire() {
    if (existsSync(this.pidPath)) {
      try {
        const oldPid = parseInt(readFileSync(this.pidPath, 'utf8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          try {
            process.kill(oldPid, 0); // just checks if alive
            throw new Error(`Another Farmer instance is running (PID ${oldPid}). Kill it first: kill ${oldPid}`);
          } catch (e) {
            if (e.message.includes('Another Farmer')) throw e;
            // process doesn't exist — stale PID file, ok to overwrite
          }
        }
      } catch (e) {
        if (e.message.includes('Another Farmer')) throw e;
        // corrupt PID file, overwrite
      }
    }
    writeFileSync(this.pidPath, String(process.pid));
  }

  /**
   * Release the PID lock (only if it's ours).
   */
  release() {
    try {
      if (existsSync(this.pidPath) && readFileSync(this.pidPath, 'utf8').trim() === String(process.pid)) {
        unlinkSync(this.pidPath);
      }
    } catch { /* best effort */ }
  }

  /**
   * Read the PID from lock file (for status command).
   * @returns {number|null}
   */
  readPid() {
    if (!existsSync(this.pidPath)) return null;
    try {
      return parseInt(readFileSync(this.pidPath, 'utf8').trim(), 10);
    } catch {
      return null;
    }
  }

  /**
   * Check if the locked process is alive.
   * @returns {boolean}
   */
  isRunning() {
    const pid = this.readPid();
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// --- Utility: fingerprint for session binding ---
export function sourceFingerprint(addr, pid) {
  return createHash('sha256').update(`${addr}:${pid || ''}`).digest('hex').slice(0, 16);
}

// --- Utility: derive session ID when none provided ---
export function deriveSessionId(context) {
  const parts = [
    context?.pid || '',
    context?.cwd || '',
    Date.now().toString(36),
    randomBytes(4).toString('hex'),
  ];
  return 'auto-' + createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 12);
}

// --- Utility: client IP extraction ---
export function clientAddr(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}
