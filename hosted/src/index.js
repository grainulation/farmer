/**
 * Farmer Hosted — Cloudflare Worker entry point.
 *
 * Thin routing layer: JWT validation → Durable Object dispatch.
 * All state logic lives in SprintSession DO.
 *
 * URL pattern: farmer.grainulation.com/<sprintToken>/...
 */

import { verify, importPublicKeyJWK } from './jwt.js';
import { DASHBOARD_HTML } from './dashboard.js';

export { SprintSession } from './sprint-session.js';

// Cache the imported public key in module scope (survives across requests in same isolate)
let _cachedKey = null;
let _cachedKeyJSON = null;

async function getPublicKey(env) {
  const raw = env.JWT_PUBLIC_KEY;
  if (!raw) return null;
  if (raw === _cachedKeyJSON) return _cachedKey;
  _cachedKeyJSON = raw;
  _cachedKey = await importPublicKeyJWK(JSON.parse(raw));
  return _cachedKey;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Health check
    if (path === '/health') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }

    // Root redirect
    if (path === '/' || path === '') {
      return new Response('Farmer Hosted — use /<token> to access your dashboard', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Parse: /<token>[/subpath]
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) {
      return new Response('Not found', { status: 404 });
    }

    const token = segments[0];
    const subpath = '/' + segments.slice(1).join('/');

    // ── Auth ──
    const authResult = await authenticate(request, url, token, env);
    if (authResult.error) {
      return new Response(JSON.stringify({ error: authResult.error }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { role, sprintToken } = authResult;

    // ── Route to Durable Object ──
    const doId = env.SPRINT_SESSIONS.idFromName(sprintToken);
    const stub = env.SPRINT_SESSIONS.get(doId);

    // Dashboard HTML (GET /<token>)
    if (subpath === '/' && request.method === 'GET') {
      const html = DASHBOARD_HTML
        .replace('__SPRINT_TOKEN__', sprintToken)
        .replace('__WS_URL__', `wss://${url.host}/${token}/ws?role=${role}`)
        .replace('__ROLE__', role);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: ws:; frame-ancestors 'none';",
        },
      });
    }

    // WebSocket upgrade (GET /<token>/ws)
    if (subpath === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set('role', role);
      const doRequest = new Request(wsUrl.toString(), request);
      return stub.fetch(doRequest);
    }

    // Hook and API endpoints → forward to DO
    if (subpath.startsWith('/hooks/') || subpath.startsWith('/api/')) {
      // For hooks from CLI, enforce admin role
      if (subpath.startsWith('/hooks/') && role !== 'admin') {
        return new Response(JSON.stringify({ error: 'Hooks require admin role' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      // For sensitive API endpoints, enforce admin role
      const adminOnly = ['/api/decide', '/api/trust-level', '/api/rules', '/api/message'];
      if (adminOnly.some(p => subpath.startsWith(p)) && role !== 'admin') {
        return new Response(JSON.stringify({ error: 'Admin role required' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      const doUrl = new URL(request.url);
      doUrl.pathname = subpath;
      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return stub.fetch(doRequest);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Authentication ──

async function authenticate(request, url, token, env) {
  // Try Authorization header first (Bearer JWT)
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const jwt = authHeader.slice(7);
    return validateJWT(jwt, env);
  }

  // Try JWT in Sec-WebSocket-Protocol (for WebSocket upgrades)
  const wsProtocol = request.headers.get('Sec-WebSocket-Protocol');
  if (wsProtocol) {
    const protocols = wsProtocol.split(',').map(s => s.trim());
    for (const p of protocols) {
      if (p.startsWith('jwt.')) {
        return validateJWT(p.slice(4), env);
      }
    }
  }

  // Try token as query parameter (for initial dashboard load)
  const jwtParam = url.searchParams.get('jwt');
  if (jwtParam) {
    return validateJWT(jwtParam, env);
  }

  // Fallback: treat the URL token as a shared secret (simple mode, no JWT infra)
  // This is the default for open-source users without JWT setup
  if (!env.JWT_PUBLIC_KEY) {
    return { role: 'admin', sprintToken: token };
  }

  return { error: 'Authentication required' };
}

async function validateJWT(jwt, env) {
  try {
    const publicKey = await getPublicKey(env);
    if (!publicKey) return { error: 'JWT public key not configured' };
    const payload = await verify(publicKey, jwt);
    return { role: payload.role || 'viewer', sprintToken: payload.sub };
  } catch (err) {
    return { error: err.message };
  }
}
