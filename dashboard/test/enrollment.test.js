import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { parseSignatureHeaders, sign, verify } from "../src/nodeAuth.js";

const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// server.js is a self-executing script (it calls app.listen() at import time), so
// it is exercised as a real child process here rather than imported in-process --
// the same reason the other end-to-end proxy behaviour is not unit-tested directly.
async function startDashboard({ port, upstreamBaseUrl }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-enrollment-test-"));
  const child = spawn("node", ["src/server.js"], {
    cwd: dashboardDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "test-admin-password",
      SESSION_SECRET: "test-session-secret",
      KEY_HASH_SECRET: "test-key-hash-secret",
      // Deliberately unreachable: these tests only exercise an enrolled node, not
      // the default node's own proxy behaviour (covered in proxy.test.js).
      UPSTREAM_BASE_URL: upstreamBaseUrl || "http://127.0.0.1:1/v1",
      UPSTREAM_API_KEY: "swiftlm-master-key",
      DEFAULT_NODE_ID: "mac-mini",
      MODEL_ID: "swiftlm-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    base,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function call(base, pathname, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, json, text };
}

async function adminCookie(base) {
  const login = await call(base, "/api/auth/login", { method: "POST", body: { password: "test-admin-password" } });
  return login.response.headers.getSetCookie()[0].split(";")[0];
}

test("enrollment issues a one-time token that a node agent redeems for a node secret", { timeout: 20_000 }, async (t) => {
  const dashboard = await startDashboard({ port: 18401 });
  t.after(() => dashboard.stop());
  const cookie = await adminCookie(dashboard.base);

  const issued = await call(dashboard.base, "/api/enrollment-tokens", {
    method: "POST", cookie, body: { label: "GPU 01", ttl_minutes: 10 },
  });
  assert.equal(issued.response.status, 201);
  assert.match(issued.json.token, /^enroll_/);

  const pending = await call(dashboard.base, "/api/enrollment-tokens", { cookie });
  assert.equal(pending.json.data.find((row) => row.id === issued.json.id)?.state, "pending");

  const enroll = await call(dashboard.base, "/api/node-agent/enroll", {
    method: "POST",
    body: {
      token: issued.json.token, name: "GPU 01", provider: "vllm",
      base_url: "http://127.0.0.1:2/v1", model_id: "Qwen/Qwen3-32B", model_name: "Qwen3 32B",
    },
  });
  assert.equal(enroll.response.status, 201);
  assert.ok(enroll.json.node_id);
  assert.ok(enroll.json.node_secret);

  const reused = await call(dashboard.base, "/api/node-agent/enroll", {
    method: "POST",
    body: {
      token: issued.json.token, name: "Duplicate", provider: "vllm",
      base_url: "http://127.0.0.1:2/v1/dup", model_id: "m", model_name: "m",
    },
  });
  assert.equal(reused.response.status, 409, "the same token cannot enroll a second node");

  const bogus = await call(dashboard.base, "/api/node-agent/enroll", {
    method: "POST",
    body: { token: "enroll_does-not-exist", name: "x", provider: "vllm", base_url: "http://x/v1", model_id: "m", model_name: "m" },
  });
  assert.equal(bogus.response.status, 401, "an unknown token is rejected outright");

  const afterList = await call(dashboard.base, "/api/enrollment-tokens", { cookie });
  assert.equal(afterList.json.data.find((row) => row.id === issued.json.id)?.state, "used");
});

test("only a validly signed, non-replayed heartbeat updates node state", { timeout: 20_000 }, async (t) => {
  const dashboard = await startDashboard({ port: 18402 });
  t.after(() => dashboard.stop());
  const cookie = await adminCookie(dashboard.base);

  const issued = await call(dashboard.base, "/api/enrollment-tokens", { method: "POST", cookie, body: {} });
  const enroll = await call(dashboard.base, "/api/node-agent/enroll", {
    method: "POST",
    body: {
      token: issued.json.token, name: "GPU 01", provider: "vllm",
      base_url: "http://127.0.0.1:2/v1", model_id: "Qwen/Qwen3-32B", model_name: "Qwen3 32B",
    },
  });
  const { node_id: nodeId, node_secret: nodeSecret } = enroll.json;
  const heartbeatPath = `/api/node-agent/${nodeId}/heartbeat`;
  const body = { agent_version: "node-agent/0.1.0", capabilities: { gpu: "RTX 4090" } };

  const forged = sign({ secret: "wrong-secret", method: "POST", path: heartbeatPath, nodeId, body });
  const forgedResult = await call(dashboard.base, heartbeatPath, { method: "POST", body, headers: forged.headers });
  assert.equal(forgedResult.response.status, 401);

  const signed = sign({ secret: nodeSecret, method: "POST", path: heartbeatPath, nodeId, body });
  const accepted = await call(dashboard.base, heartbeatPath, { method: "POST", body, headers: signed.headers });
  assert.equal(accepted.response.status, 200);

  const replayed = await call(dashboard.base, heartbeatPath, { method: "POST", body, headers: signed.headers });
  assert.equal(replayed.response.status, 401, "the exact same signed request cannot be replayed");

  const nodes = await call(dashboard.base, "/api/nodes", { cookie });
  const node = nodes.json.data.find((row) => row.id === nodeId);
  assert.equal(node.agent_version, "node-agent/0.1.0");
  assert.equal(node.capabilities.gpu, "RTX 4090");
  assert.ok(node.enrolled_at);
  assert.ok(node.last_heartbeat_at);

  // A heartbeat claiming a different node ID than the URL is rejected before the
  // signature is even checked, so it cannot be used to probe for valid secrets.
  const spoofed = sign({ secret: nodeSecret, method: "POST", path: `/api/node-agent/someone-else/heartbeat`, nodeId: "someone-else", body });
  const spoofedResult = await call(dashboard.base, heartbeatPath, {
    method: "POST", body, headers: { ...spoofed.headers, "X-Node-Id": "someone-else" },
  });
  assert.equal(spoofedResult.response.status, 401);
});

test("an enrolled node's proxied requests carry a Gateway-Identity signature the node agent can verify", { timeout: 20_000 }, async (t) => {
  let agentSecret = null;
  const calls = [];
  const fakeNode = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3-32B", owned_by: "vllm" }] }));
    }
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    const sig = parseSignatureHeaders(req.headers);
    const verified = agentSecret
      ? verify({ secret: agentSecret, method: req.method, path: req.url, nodeId: sig.nodeId, body, ...sig })
      : { ok: false, reason: "no_secret_yet" };
    calls.push({ url: req.url, verified });
    if (!verified.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: verified.reason } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
  });
  const agentPort = await listen(fakeNode);
  t.after(() => fakeNode.close());

  const dashboard = await startDashboard({ port: 18403 });
  t.after(() => dashboard.stop());
  const cookie = await adminCookie(dashboard.base);

  const issued = await call(dashboard.base, "/api/enrollment-tokens", { method: "POST", cookie, body: {} });
  const enroll = await call(dashboard.base, "/api/node-agent/enroll", {
    method: "POST",
    body: {
      token: issued.json.token, name: "GPU 01", provider: "vllm",
      base_url: `http://127.0.0.1:${agentPort}/v1`, model_id: "Qwen/Qwen3-32B", model_name: "Qwen3 32B",
    },
  });
  agentSecret = enroll.json.node_secret;

  const clientKey = await call(dashboard.base, "/api/keys", { method: "POST", cookie, body: { name: "GPU key", node_id: enroll.json.node_id } });
  const completion = await call(dashboard.base, "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${clientKey.json.key}` },
    body: { model: "Qwen/Qwen3-32B", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(completion.response.status, 200, completion.text);
  assert.ok(calls.some((c) => c.url === "/v1/chat/completions" && c.verified.ok === true));

  // A manually-added node (no node_secret) must not send signature headers at all --
  // Gateway Identity is additive, opt-in behaviour scoped to enrolled nodes.
  const manual = await call(dashboard.base, "/api/nodes", {
    method: "POST", cookie,
    body: {
      name: "Manual GPU", provider: "vllm", origin_base_url: `http://127.0.0.1:${agentPort}/manual/v1`,
      auth_type: "none", model_id: "manual-model", model_name: "manual-model",
    },
  });
  const manualKey = await call(dashboard.base, "/api/keys", { method: "POST", cookie, body: { name: "Manual key", node_id: manual.json.id } });
  calls.length = 0;
  await call(dashboard.base, "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${manualKey.json.key}` },
    body: { model: "manual-model", messages: [] },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verified.ok, false);
  assert.equal(calls[0].verified.reason, "missing_fields", "a manual node's request carries no signature headers");
});

test("enrollment tokens are revocable only until they are consumed", { timeout: 20_000 }, async (t) => {
  const dashboard = await startDashboard({ port: 18404 });
  t.after(() => dashboard.stop());
  const cookie = await adminCookie(dashboard.base);

  const spare = await call(dashboard.base, "/api/enrollment-tokens", { method: "POST", cookie, body: { label: "spare" } });
  const revoked = await call(dashboard.base, `/api/enrollment-tokens/${spare.json.id}`, { method: "DELETE", cookie });
  assert.equal(revoked.response.status, 200);

  const used = await call(dashboard.base, "/api/enrollment-tokens", { method: "POST", cookie, body: {} });
  await call(dashboard.base, "/api/node-agent/enroll", {
    method: "POST",
    body: { token: used.json.token, name: "n", provider: "vllm", base_url: "http://127.0.0.1:2/v1", model_id: "m", model_name: "m" },
  });
  const revokeUsed = await call(dashboard.base, `/api/enrollment-tokens/${used.json.id}`, { method: "DELETE", cookie });
  assert.equal(revokeUsed.response.status, 404, "a consumed token cannot be revoked after the fact");

  // Admin endpoints stay admin-only; the enrollment surface is the one deliberate
  // exception, gated by the token/signature instead of the session cookie.
  const noAuth = await call(dashboard.base, "/api/enrollment-tokens", { method: "POST", body: {} });
  assert.equal(noAuth.response.status, 401);
});
