import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence } from '../lib/persistence.js';
import { existsSync, unlinkSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Persistence', () => {
  let tempDir;
  let persistence;

  afterEach(() => {
    if (persistence) {
      // Clean up files
      try { unlinkSync(persistence.statePath); } catch {}
      try { unlinkSync(persistence.statePath + '.tmp'); } catch {}
      try { unlinkSync(persistence.auditLogPath); } catch {}
    }
  });

  it('saves and loads state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'farmer-test-'));
    persistence = new Persistence(tempDir);

    // Create a mock sessions map
    const sessions = new Map();
    sessions.set('test-session', {
      id: 'test-session',
      trustLevel: 'standard',
      sessionRules: [{ tool: 'Bash', pattern: null }],
      activity: [{ type: 'success', tool_name: 'Read', timestamp: Date.now() }],
      messages: [{ content: 'Hello', timestamp: Date.now() }],
      label: 'test',
      color: 120,
      cwd: '/tmp/test',
    });

    // Save
    persistence.saveState(sessions, true);
    assert.ok(existsSync(persistence.statePath));

    // Load
    const loaded = persistence.loadState();
    assert.ok(loaded);
    assert.equal(loaded.sessions.length, 1);
    assert.equal(loaded.sessions[0].id, 'test-session');
    assert.equal(loaded.sessions[0].trustLevel, 'standard');
    assert.equal(loaded.sessions[0].sessionRules.length, 1);
    assert.equal(loaded.sessions[0].activity.length, 1);
    assert.equal(loaded.sessions[0].messages.length, 1);
  });

  it('writes audit log entries', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'farmer-test-'));
    persistence = new Persistence(tempDir);

    persistence.auditLog({ event: 'test_event', data: 'hello' });
    assert.ok(existsSync(persistence.auditLogPath));

    const lines = readFileSync(persistence.auditLogPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, 'test_event');
    assert.equal(entry.data, 'hello');
    assert.ok(entry.timestamp);
  });

  it('returns null when no state file exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'farmer-test-'));
    persistence = new Persistence(tempDir);

    const result = persistence.loadState();
    assert.equal(result, null);
  });

  it('marks dirty and tracks dirty state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'farmer-test-'));
    persistence = new Persistence(tempDir);

    assert.equal(persistence.isDirty, false);
    persistence.markDirty();
    assert.equal(persistence.isDirty, true);
  });
});
