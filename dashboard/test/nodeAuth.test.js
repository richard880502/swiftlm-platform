import test from "node:test";
import assert from "node:assert/strict";
import {
  createNonceCache,
  generateEnrollmentToken,
  generateNodeSecret,
  sign,
  verify,
} from "../src/nodeAuth.js";

test("a request signed with the right secret verifies", () => {
  const secret = generateNodeSecret();
  const signed = sign({ secret, method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-01", body: { ok: true } });
  const result = verify({
    secret, method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-01", body: { ok: true },
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
  });
  assert.equal(result.ok, true);
});

test("the wrong secret is rejected", () => {
  const signed = sign({ secret: generateNodeSecret(), method: "POST", path: "/x", nodeId: "n1", body: {} });
  const result = verify({
    secret: generateNodeSecret(), method: "POST", path: "/x", nodeId: "n1", body: {},
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("a captured signature cannot be replayed against a different route or node", () => {
  const secret = generateNodeSecret();
  const signed = sign({ secret, method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-01", body: {} });
  const wrongPath = verify({
    secret, method: "POST", path: "/api/node-agent/gpu-02/heartbeat", nodeId: "gpu-01", body: {},
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
  });
  assert.equal(wrongPath.ok, false);
  const wrongNode = verify({
    secret, method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-02", body: {},
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
  });
  assert.equal(wrongNode.ok, false);
});

test("a swapped body invalidates the signature", () => {
  const secret = generateNodeSecret();
  const signed = sign({ secret, method: "POST", path: "/x", nodeId: "n1", body: { amount: 1 } });
  const result = verify({
    secret, method: "POST", path: "/x", nodeId: "n1", body: { amount: 999 },
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
  });
  assert.equal(result.ok, false);
});

test("a timestamp outside the window is rejected even with a valid signature", () => {
  const secret = generateNodeSecret();
  const staleTimestamp = Date.now() - 10 * 60 * 1000;
  const signed = sign({ secret, method: "GET", path: "/x", nodeId: "n1", body: undefined, timestamp: staleTimestamp });
  const result = verify({
    secret, method: "GET", path: "/x", nodeId: "n1", body: undefined,
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
    windowMs: 5 * 60 * 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timestamp_out_of_window");
});

test("a nonce cache rejects the exact same request replayed twice", () => {
  const secret = generateNodeSecret();
  const nonceCache = createNonceCache();
  const signed = sign({ secret, method: "POST", path: "/x", nodeId: "n1", body: {} });
  const args = {
    secret, method: "POST", path: "/x", nodeId: "n1", body: {},
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature, nonceCache,
  };
  assert.equal(verify(args).ok, true);
  const replayed = verify(args);
  assert.equal(replayed.ok, false);
  assert.equal(replayed.reason, "replayed_nonce");
});

test("two different nodes may pick the same nonce without colliding", () => {
  const nonceCache = createNonceCache();
  const secretA = generateNodeSecret();
  const secretB = generateNodeSecret();
  const nonce = "shared-nonce";
  const signedA = sign({ secret: secretA, method: "POST", path: "/x", nodeId: "node-a", body: {}, nonce });
  const signedB = sign({ secret: secretB, method: "POST", path: "/x", nodeId: "node-b", body: {}, nonce });
  assert.equal(verify({
    secret: secretA, method: "POST", path: "/x", nodeId: "node-a", body: {},
    timestamp: signedA.timestamp, nonce, signature: signedA.signature, nonceCache,
  }).ok, true);
  assert.equal(verify({
    secret: secretB, method: "POST", path: "/x", nodeId: "node-b", body: {},
    timestamp: signedB.timestamp, nonce, signature: signedB.signature, nonceCache,
  }).ok, true);
});

test("the nonce cache prunes entries once their window has passed", () => {
  const nonceCache = createNonceCache({ windowMs: 100 });
  const now = 1_000_000;
  assert.equal(nonceCache.claim("k", now), true);
  assert.equal(nonceCache.claim("k", now + 50), false);
  assert.equal(nonceCache.claim("k", now + 200), true);
});

test("missing signature fields fail closed rather than verifying", () => {
  const secret = generateNodeSecret();
  assert.equal(verify({ secret, method: "GET", path: "/x", nodeId: "n1" }).ok, false);
});

test("tokens and secrets are generated with the expected shape", () => {
  const token = generateEnrollmentToken();
  assert.match(token, /^enroll_[A-Za-z0-9_-]+$/);
  const secret = generateNodeSecret();
  assert.equal(typeof secret, "string");
  assert.ok(secret.length >= 32);
  // Randomness matters here: two calls must not collide.
  assert.notEqual(generateEnrollmentToken(), generateEnrollmentToken());
  assert.notEqual(generateNodeSecret(), generateNodeSecret());
});
