/**
 * Persistence layer — activity and message data survive server restarts.
 *
 * Uses atomic write-rename pattern (write .tmp, rename to final) to prevent
 * corruption from crashes. Debounces saves to avoid excessive disk writes.
 *
 * Zero npm dependencies — Node built-in only.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export class Persistence {
  /**
   * @param {string} dataDir - Directory for state + audit files
   * @param {object} opts
   * @param {number} opts.debounceMs - Debounce interval for saves (default 2000)
   */
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.statePath = join(dataDir, '.farmer-state.json');
    this.auditLogPath = join(dataDir, '.farmer-audit.jsonl');
    this.debounceMs = opts.debounceMs || 2000;

    this._dirty = false;
    this._debounceTimer = null;
  }

  /**
   * Append a structured entry to the audit log (JSONL format).
   * @param {object} entry
   */
  auditLog(entry) {
    try {
      const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
      appendFileSync(this.auditLogPath, line + '\n');
    } catch (err) {
      console.error('[audit] write failed:', err.message);
    }
  }

  /**
   * Save session state to disk. Debounced by default; force=true writes immediately.
   * @param {Map} sessions - session_id -> SessionState
   * @param {boolean} force
   */
  saveState(sessions, force = false) {
    if (force) {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._dirty = false;
      this._writeState(sessions);
    } else {
      this._dirty = true;
      if (!this._debounceTimer) {
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = null;
          if (this._dirty) {
            this._dirty = false;
            this._writeState(sessions);
          }
        }, this.debounceMs);
      }
    }
  }

  /**
   * Mark state as dirty (will be saved on next debounce tick).
   */
  markDirty() {
    this._dirty = true;
  }

  /** @returns {boolean} */
  get isDirty() {
    return this._dirty;
  }

  /**
   * Load saved state from disk.
   * @returns {object|null} - { savedAt, sessions: [...] } or null
   */
  loadState() {
    if (!existsSync(this.statePath)) return null;
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const state = JSON.parse(raw);
      console.log(`  Restored ${state.sessions?.length || 0} session(s) from ${basename(this.statePath)}`);
      return state;
    } catch (err) {
      console.error('[persist] load failed (corrupt state file?):', err.message);
      return null;
    }
  }

  /**
   * Internal: atomic write to state file.
   * @param {Map} sessions
   */
  _writeState(sessions) {
    const state = {
      savedAt: Date.now(),
      sessions: [...sessions.entries()].map(([id, s]) => ({
        id,
        trustLevel: s.trustLevel,
        sessionRules: s.sessionRules,
        activity: s.activity,
        messages: s.messages,
        label: s.label,
        color: s.color,
        cwd: s.cwd,
      })),
    };
    try {
      const tmp = this.statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.statePath);
    } catch (err) {
      console.error('[persist] save failed:', err.message);
    }
  }

  /**
   * Flush if dirty (for periodic saves).
   * @param {Map} sessions
   */
  flushIfDirty(sessions) {
    if (this._dirty) {
      this.saveState(sessions);
    }
  }
}
