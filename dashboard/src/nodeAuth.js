// Node Identity and Gateway Identity: the two directions of trust between the
// control plane and a node agent, distinct from the client API key and from the
// node's own credential to its local backend (auth_type / upstream_api_key).
//
//   Node → Dashboard   (heartbeat, registration)   -- "Node Identity"
//   Dashboard → Node   (proxied inference request) -- "Gateway Identity"
//
// Both directions share one HMAC-SHA256 scheme and one per-node secret, matching
// the MVP path the platform's architecture proposal calls out explicitly:
// one-time enrollment token -> random node secret -> HMAC request authentication.
// Upgrading either direction to Ed25519 / mTLS later only replaces `sign`/`verify`;
// nothing else in the dashboard or the node agent needs to change.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ENROLLMENT_TOKEN_PREFIX = "enroll_";
export const NODE_SECRET_BYTES = 32;
export const DEFAULT_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export function generateEnrollmentToken() {
  return `${ENROLLMENT_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function generateNodeSecret() {
  return randomBytes(NODE_SECRET_BYTES).toString("base64url");
}

// Enrollment tokens and node secrets are bearer credentials, so only their SHA-256
// digest is ever persisted -- the same posture as client API keys.
export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bodyHash(body) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(text).digest("hex");
}

function signingString({ method, path, nodeId, timestamp, nonce, body }) {
  return [method.toUpperCase(), path, nodeId, timestamp, nonce, bodyHash(body)].join("\n");
}

// The signature covers method, path and node ID so a captured signature cannot be
// replayed against a different route or a different node, and covers a body hash
// so the payload cannot be swapped without invalidating it.
export function sign({ secret, method, path, nodeId, body, timestamp = Date.now(), nonce = randomBytes(12).toString("base64url") }) {
  const signature = createHmac("sha256", secret)
    .update(signingString({ method, path, nodeId, timestamp, nonce, body }))
    .digest("hex");
  return {
    signature,
    timestamp: String(timestamp),
    nonce,
    headers: {
      "X-Node-Id": nodeId,
      "X-Node-Timestamp": String(timestamp),
      "X-Node-Nonce": nonce,
      "X-Node-Signature": signature,
    },
  };
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

// A nonce cache defeats replay within the timestamp window: an attacker who
// captures one signed request cannot resend it, and cannot outlast the window by
// waiting, since expired entries are pruned as new ones arrive.
export function createNonceCache({ windowMs = DEFAULT_TIMESTAMP_WINDOW_MS } = {}) {
  const seen = new Map();
  return {
    // Returns true and records the nonce the first time it is seen within the
    // window; returns false on any repeat, which the caller must treat as a
    // replay attempt rather than a valid request.
    claim(key, now = Date.now()) {
      for (const [existingKey, expiresAt] of seen) {
        if (expiresAt <= now) seen.delete(existingKey);
      }
      if (seen.has(key)) return false;
      seen.set(key, now + windowMs);
      return true;
    },
    size: () => seen.size,
  };
}

export function verify({
  secret, method, path, nodeId, body, timestamp, nonce, signature,
  windowMs = DEFAULT_TIMESTAMP_WINDOW_MS, nonceCache, now = Date.now(),
}) {
  if (!secret || !timestamp || !nonce || !signature) return { ok: false, reason: "missing_fields" };
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > windowMs) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  const expected = createHmac("sha256", secret)
    .update(signingString({ method, path, nodeId, timestamp, nonce, body }))
    .digest("hex");
  if (!safeEqual(expected, signature)) return { ok: false, reason: "invalid_signature" };
  // The nonce is scoped to the node: two different nodes may legitimately pick the
  // same random nonce value without colliding with each other's replay cache.
  if (nonceCache && !nonceCache.claim(`${nodeId}:${nonce}`, now)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  return { ok: true };
}

export function parseSignatureHeaders(headers) {
  const header = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  return {
    nodeId: header("x-node-id") || header("X-Node-Id"),
    timestamp: header("x-node-timestamp") || header("X-Node-Timestamp"),
    nonce: header("x-node-nonce") || header("X-Node-Nonce"),
    signature: header("x-node-signature") || header("X-Node-Signature"),
  };
}
