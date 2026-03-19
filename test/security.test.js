import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager, CsrfManager, PidLock, sourceFingerprint, deriveSessionId } from '../lib/security.js';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TokenManager', () => {
  it('generates tokens on construction', () => {
    const tm = new TokenManager();
    assert.ok(tm.token);
    assert.equal(tm.token.length, 32); // 16 bytes = 32 hex chars
    assert.ok(tm.viewerToken);
    assert.equal(tm.viewerToken.length, 32);
    assert.notEqual(tm.token, tm.viewerToken);
    tm.destroy();
  });

  it('uses provided tokens', () => {
    const tm = new TokenManager({ token: 'myadmin', viewerToken: 'myviewer' });
    assert.equal(tm.token, 'myadmin');
    assert.equal(tm.viewerToken, 'myviewer');
    tm.destroy();
  });

  it('matches returns role string for admin token', () => {
    const tm = new TokenManager({ token: 'abc123', viewerToken: 'viewer456' });
    assert.equal(tm.matches('abc123'), 'admin');
    assert.equal(tm.matches('viewer456'), 'viewer');
    assert.equal(tm.matches('wrong'), null);
    assert.equal(tm.matches(''), null);
    assert.equal(tm.matches(null), null);
    tm.destroy();
  });

  it('matches retired admin token within grace period', () => {
    const tm = new TokenManager({ token: 'old-token', viewerToken: 'v1', gracePeriod: 60 });
    tm.rotate();
    // Old admin token should still match during grace
    assert.equal(tm.matches('old-token'), 'admin');
    // New admin token should also match
    assert.equal(tm.matches(tm.token), 'admin');
    // Viewer token still works
    assert.equal(tm.matches('v1'), 'viewer');
    tm.destroy();
  });

  it('matches retired viewer token within grace period', () => {
    const tm = new TokenManager({ token: 'a1', viewerToken: 'old-viewer', gracePeriod: 60 });
    tm.rotateViewer();
    assert.equal(tm.matches('old-viewer'), 'viewer');
    assert.equal(tm.matches(tm.viewerToken), 'viewer');
    assert.equal(tm.matches('a1'), 'admin');
    tm.destroy();
  });

  it('rotate generates new admin token', () => {
    const tm = new TokenManager({ token: 'first' });
    const newToken = tm.rotate();
    assert.notEqual(newToken, 'first');
    assert.equal(tm.token, newToken);
    tm.destroy();
  });

  it('rotateViewer generates new viewer token', () => {
    const tm = new TokenManager({ viewerToken: 'v-first' });
    const newToken = tm.rotateViewer();
    assert.notEqual(newToken, 'v-first');
    assert.equal(tm.viewerToken, newToken);
    tm.destroy();
  });

  it('toJSON serializes both tokens', () => {
    const tm = new TokenManager({ token: 'adm', viewerToken: 'view' });
    const json = tm.toJSON();
    assert.deepEqual(json, { admin: 'adm', viewer: 'view' });
    tm.destroy();
  });

  it('parseTokenFile handles JSON format', () => {
    const result = TokenManager.parseTokenFile('{"admin":"a1","viewer":"v1"}');
    assert.equal(result.admin, 'a1');
    assert.equal(result.viewer, 'v1');
  });

  it('parseTokenFile handles plain text (backwards compat)', () => {
    const result = TokenManager.parseTokenFile('oldplaintoken');
    assert.equal(result.admin, 'oldplaintoken');
    assert.equal(result.viewer, '');
  });

  it('parseTokenFile handles empty input', () => {
    const result = TokenManager.parseTokenFile('');
    assert.equal(result.admin, '');
    assert.equal(result.viewer, '');
  });

  it('signInvite and verifyInvite round-trip', () => {
    const tm = new TokenManager({ token: 'secret-admin' });
    const exp = Date.now() + 60000;
    const sig = tm.signInvite('viewer', exp);
    assert.ok(tm.verifyInvite('viewer', exp, sig));
    assert.ok(!tm.verifyInvite('admin', exp, sig)); // wrong role
    assert.ok(!tm.verifyInvite('viewer', exp + 1, sig)); // wrong exp
    assert.ok(!tm.verifyInvite('viewer', exp, 'badsig')); // wrong sig
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
