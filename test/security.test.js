import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager, CsrfManager, PidLock, sourceFingerprint, deriveSessionId } from '../lib/security.js';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TokenManager', () => {
  it('generates a token on construction', () => {
    const tm = new TokenManager();
    assert.ok(tm.token);
    assert.equal(tm.token.length, 32); // 16 bytes = 32 hex chars
    tm.destroy();
  });

  it('uses provided token', () => {
    const tm = new TokenManager({ token: 'mytoken' });
    assert.equal(tm.token, 'mytoken');
    tm.destroy();
  });

  it('matches current token', () => {
    const tm = new TokenManager({ token: 'abc123' });
    assert.ok(tm.matches('abc123'));
    assert.ok(!tm.matches('wrong'));
    assert.ok(!tm.matches(''));
    assert.ok(!tm.matches(null));
    tm.destroy();
  });

  it('matches retired token within grace period', () => {
    const tm = new TokenManager({ token: 'old-token', gracePeriod: 60 });
    tm.rotate();
    // Old token should still match during grace
    assert.ok(tm.matches('old-token'));
    // New token should also match
    assert.ok(tm.matches(tm.token));
    tm.destroy();
  });

  it('rotate generates new token', () => {
    const tm = new TokenManager({ token: 'first' });
    const newToken = tm.rotate();
    assert.notEqual(newToken, 'first');
    assert.equal(tm.token, newToken);
    tm.destroy();
  });
});

describe('CsrfManager', () => {
  it('generates and validates tokens', () => {
    const cm = new CsrfManager();
    const token = cm.generate();
    assert.ok(cm.validate(token));
    assert.ok(!cm.validate('bogus'));
    assert.ok(!cm.validate(''));
    assert.ok(!cm.validate(null));
    cm.destroy();
  });

  it('rejects expired tokens', () => {
    const cm = new CsrfManager(1); // 1ms TTL
    const token = cm.generate();
    // Token should expire almost immediately
    setTimeout(() => {
      assert.ok(!cm.validate(token));
      cm.destroy();
    }, 10);
  });
});

describe('PidLock', () => {
  const pidPath = join(tmpdir(), `.farmer-test-${process.pid}.pid`);

  afterEach(() => {
    try { unlinkSync(pidPath); } catch {}
  });

  it('acquires and releases lock', () => {
    const lock = new PidLock(pidPath);
    lock.acquire();
    assert.ok(existsSync(pidPath));
    assert.equal(lock.readPid(), process.pid);
    assert.ok(lock.isRunning());
    lock.release();
    assert.ok(!existsSync(pidPath));
  });

  it('detects stale PID file', () => {
    const lock = new PidLock(pidPath);
    // Write a PID that doesn't exist (99999999)
    writeFileSync(pidPath, '99999999');
    // Should not throw — stale PID gets overwritten
    lock.acquire();
    assert.equal(lock.readPid(), process.pid);
    lock.release();
  });
});

describe('sourceFingerprint', () => {
  it('produces consistent hash', () => {
    const fp1 = sourceFingerprint('127.0.0.1', '1234');
    const fp2 = sourceFingerprint('127.0.0.1', '1234');
    assert.equal(fp1, fp2);
    assert.equal(fp1.length, 16);
  });

  it('different inputs produce different hashes', () => {
    const fp1 = sourceFingerprint('127.0.0.1', '1234');
    const fp2 = sourceFingerprint('127.0.0.1', '5678');
    assert.notEqual(fp1, fp2);
  });
});

describe('deriveSessionId', () => {
  it('produces unique IDs', () => {
    const id1 = deriveSessionId({ pid: '1', cwd: '/a' });
    const id2 = deriveSessionId({ pid: '1', cwd: '/a' });
    // Should be different because of timestamp + random component
    assert.notEqual(id1, id2);
    assert.ok(id1.startsWith('auto-'));
  });
});
