/**
 * JWT auth via WebCrypto — ES256 (ECDSA P-256 + SHA-256).
 * Zero dependencies. Runs in Cloudflare Workers runtime.
 */

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" };

// ── Base64url helpers ──

function base64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  const pad = str.length % 4;
  const padded = str + "====".slice(pad || 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Key import ──

/** Import a PEM-encoded ECDSA P-256 public key for verification. */
export async function importPublicKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = base64urlDecode(
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  );
  return crypto.subtle.importKey("spki", der, ALG, false, ["verify"]);
}

/** Import a JWK-format ECDSA P-256 public key for verification. */
export async function importPublicKeyJWK(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { ...jwk, key_ops: ["verify"] },
    ALG,
    false,
    ["verify"],
  );
}

/** Import a PEM-encoded ECDSA P-256 private key for signing. */
export async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN EC PRIVATE KEY-----/, "")
    .replace(/-----END EC PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = base64urlDecode(
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  );
  return crypto.subtle.importKey("pkcs8", der, ALG, false, ["sign"]);
}

// ── JWT signing ──

/**
 * Create a signed JWT.
 * @param {CryptoKey} privateKey
 * @param {object} payload — must include `sub` (sprint token), `role`, `exp`
 * @returns {Promise<string>} compact JWT
 */
export async function sign(privateKey, payload) {
  const header = { alg: "ES256", typ: "JWT" };
  const enc = new TextEncoder();
  const headerB64 = base64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const rawSig = await crypto.subtle.sign(
    SIGN_ALG,
    privateKey,
    enc.encode(signingInput),
  );
  // WebCrypto returns IEEE P1363 (r||s) — JWT expects the same format
  const sigB64 = base64urlEncode(rawSig);

  return `${signingInput}.${sigB64}`;
}

// ── JWT verification ──

/**
 * Verify and decode a JWT.
 * @param {CryptoKey} publicKey
 * @param {string} token — compact JWT string
 * @returns {Promise<object>} decoded payload
 * @throws on invalid signature, expired token, or malformed JWT
 */
export async function verify(publicKey, token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const [headerB64, payloadB64, sigB64] = parts;

  // Decode and validate header
  const header = JSON.parse(
    new TextDecoder().decode(base64urlDecode(headerB64)),
  );
  if (header.alg !== "ES256") throw new Error(`Unsupported alg: ${header.alg}`);

  // Verify signature
  const enc = new TextEncoder();
  const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlDecode(sigB64);

  const valid = await crypto.subtle.verify(
    SIGN_ALG,
    publicKey,
    signature,
    signingInput,
  );
  if (!valid) throw new Error("Invalid signature");

  // Decode payload
  const payload = JSON.parse(
    new TextDecoder().decode(base64urlDecode(payloadB64)),
  );

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return payload;
}

// ── Key generation (for CLI / setup) ──

/**
 * Generate an ECDSA P-256 key pair.
 * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey, publicKeyJWK: object, privateKeyJWK: object}>}
 */
export async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(ALG, true, [
    "sign",
    "verify",
  ]);
  const publicKeyJWK = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJWK = await crypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey,
  );
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyJWK,
    privateKeyJWK,
  };
}

/**
 * Create a short-lived JWT for a sprint session.
 * @param {CryptoKey} privateKey
 * @param {string} sprintToken — opaque sprint identifier
 * @param {'admin'|'viewer'} role
 * @param {number} [ttlSeconds=86400] — default 24h
 */
export async function createSprintJWT(
  privateKey,
  sprintToken,
  role = "admin",
  ttlSeconds = 86400,
) {
  const now = Math.floor(Date.now() / 1000);
  return sign(privateKey, {
    sub: sprintToken,
    role,
    iat: now,
    exp: now + ttlSeconds,
  });
}
