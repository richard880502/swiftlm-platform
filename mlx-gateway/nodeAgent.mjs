// Node Identity and Gateway Identity for a gateway acting as a node agent.
//
// This is the backend-agnostic half of "swiftlm-node-agent" from the platform's
// architecture proposal: enrollment state, signed heartbeats, and verifying that
// an inbound inference request actually came from the control plane. It has no
// dependency on SwiftLM specifically -- a future gateway fronting vLLM or
// llama.cpp can reuse this file unchanged; only the HTTP proxy/queueing core in
// server.mjs (which already parses SwiftLM's own SSE metrics) is backend-specific.
//
// Deliberately dependency-free (no npm install step) and duplicated rather than
// shared with dashboard/src/nodeAuth.js: this script is deployed standalone to a
// node machine, the dashboard is deployed separately to Zeabur, and neither
// should gain a runtime dependency on the other's package graph. The signing
// scheme itself (HMAC-SHA256 over METHOD/PATH/NODE_ID/TIMESTAMP/NONCE/SHA256(BODY))
// must stay byte-for-byte identical between the two copies; nodeAuth.test.js and
// this file's own tests both pin it down.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

function bodyHash(body) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(text).digest("hex");
}

function signingString({ method, path: routePath, nodeId, timestamp, nonce, body }) {
  return [method.toUpperCase(), routePath, nodeId, timestamp, nonce, bodyHash(body)].join("\n");
}

export function sign({ secret, method, path: routePath, nodeId, body, timestamp = Date.now(), nonce = randomBytes(12).toString("base64url") }) {
  const signature = createHmac("sha256", secret)
    .update(signingString({ method, path: routePath, nodeId, timestamp, nonce, body }))
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

export function createNonceCache({ windowMs = DEFAULT_TIMESTAMP_WINDOW_MS } = {}) {
  const seen = new Map();
  return {
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
  secret, method, path: routePath, nodeId, body, timestamp, nonce, signature,
  windowMs = DEFAULT_TIMESTAMP_WINDOW_MS, nonceCache, now = Date.now(),
}) {
  if (!secret || !timestamp || !nonce || !signature) return { ok: false, reason: "missing_fields" };
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > windowMs) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  const expected = createHmac("sha256", secret)
    .update(signingString({ method, path: routePath, nodeId, timestamp, nonce, body }))
    .digest("hex");
  if (!safeEqual(expected, signature)) return { ok: false, reason: "invalid_signature" };
  if (nonceCache && !nonceCache.claim(`${nodeId}:${nonce}`, now)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  return { ok: true };
}

export function parseSignatureHeaders(headers) {
  return {
    nodeId: headers["x-node-id"],
    timestamp: headers["x-node-timestamp"],
    nonce: headers["x-node-nonce"],
    signature: headers["x-node-signature"],
  };
}

// The enrolled identity this gateway was given: dashboard URL, node ID, and the
// shared secret used for both directions (Node -> Dashboard heartbeats and
// Dashboard -> Node request signatures). Absent entirely on a gateway that was
// never enrolled, in which case node-agent mode never activates.
export function loadAgentState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed?.dashboard_url && parsed?.node_id && parsed?.node_secret) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveAgentState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// A heartbeat failure is logged by the caller and retried on the next tick; it
// must never crash the gateway or interrupt inference the way a hard dependency
// on the dashboard being reachable would.
export async function sendHeartbeat({ dashboardUrl, nodeId, nodeSecret, agentVersion, capabilities, fetchImpl = fetch }) {
  const path = `/api/node-agent/${nodeId}/heartbeat`;
  const body = { agent_version: agentVersion, capabilities };
  const signed = sign({ secret: nodeSecret, method: "POST", path, nodeId, body });
  const response = await fetchImpl(`${dashboardUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signed.headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`heartbeat rejected: HTTP ${response.status} ${text}`.trim());
  }
  return response.json();
}

export async function enroll({ dashboardUrl, token, name, provider, baseUrl, modelId, modelName, fetchImpl = fetch }) {
  const response = await fetchImpl(`${dashboardUrl}/api/node-agent/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, name, provider, base_url: baseUrl, model_id: modelId, model_name: modelName,
    }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok || !data?.node_id || !data?.node_secret) {
    throw new Error(data?.error?.message || `enrollment failed: HTTP ${response.status} ${text}`.trim());
  }
  return { node_id: data.node_id, node_secret: data.node_secret };
}
