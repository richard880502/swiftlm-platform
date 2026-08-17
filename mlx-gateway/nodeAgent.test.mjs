import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as gatewayNodeAgent from "./nodeAgent.mjs";
import * as dashboardNodeAuth from "../dashboard/src/nodeAuth.js";

test("a signature produced by the gateway's copy verifies against the dashboard's copy, and vice versa", () => {
  const secret = "shared-secret";
  const fromGateway = gatewayNodeAgent.sign({
    secret, method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-01", body: { agent_version: "x" },
  });
  const verifiedByDashboard = dashboardNodeAuth.verify({
    secret, method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-01", body: { agent_version: "x" },
    timestamp: fromGateway.timestamp, nonce: fromGateway.nonce, signature: fromGateway.signature,
  });
  assert.equal(verifiedByDashboard.ok, true, "the two independently-maintained copies must agree byte-for-byte");

  const fromDashboard = dashboardNodeAuth.sign({
    secret, method: "POST", path: "/v1/chat/completions", nodeId: "gpu-01", body: { messages: [] },
  });
  const verifiedByGateway = gatewayNodeAgent.verify({
    secret, method: "POST", path: "/v1/chat/completions", nodeId: "gpu-01", body: JSON.stringify({ messages: [] }),
    timestamp: fromDashboard.timestamp, nonce: fromDashboard.nonce, signature: fromDashboard.signature,
  });
  assert.equal(verifiedByGateway.ok, true);
});

test("the gateway verifies a raw request body exactly as bytes, without re-parsing it", () => {
  const secret = "shared-secret";
  // Key order in the literal below is deliberately unusual; if the gateway ever
  // JSON.parse'd and re-stringified before hashing, this would break.
  const rawBody = '{"z":1,"a":2}';
  const signed = dashboardNodeAuth.sign({ secret, method: "POST", path: "/x", nodeId: "n1", body: rawBody });
  const result = gatewayNodeAgent.verify({
    secret, method: "POST", path: "/x", nodeId: "n1", body: rawBody,
    timestamp: signed.timestamp, nonce: signed.nonce, signature: signed.signature,
  });
  assert.equal(result.ok, true);
});

test("loadAgentState returns null when the state file is missing or incomplete", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-agent-state-test-"));
  const missing = path.join(directory, "does-not-exist.json");
  assert.equal(gatewayNodeAgent.loadAgentState(missing), null);

  const incomplete = path.join(directory, "incomplete.json");
  fs.writeFileSync(incomplete, JSON.stringify({ dashboard_url: "https://example.com" }));
  assert.equal(gatewayNodeAgent.loadAgentState(incomplete), null);

  const complete = path.join(directory, "complete.json");
  const state = { dashboard_url: "https://example.com", node_id: "n1", node_secret: "s1" };
  gatewayNodeAgent.saveAgentState(complete, state);
  assert.deepEqual(gatewayNodeAgent.loadAgentState(complete), state);
});

test("saveAgentState writes the secret with restrictive permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-agent-perm-test-"));
  const statePath = path.join(directory, "node-agent.json");
  gatewayNodeAgent.saveAgentState(statePath, { dashboard_url: "https://x", node_id: "n1", node_secret: "s1" });
  const mode = fs.statSync(statePath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("sendHeartbeat signs the exact path and body it posts", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await gatewayNodeAgent.sendHeartbeat({
    dashboardUrl: "https://dashboard.example",
    nodeId: "gpu-01",
    nodeSecret: "s1",
    agentVersion: "test/1.0",
    capabilities: { gpu: "RTX 4090" },
    fetchImpl: fakeFetch,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dashboard.example/api/node-agent/gpu-01/heartbeat");
  const sentBody = JSON.parse(calls[0].init.body);
  const verified = gatewayNodeAgent.verify({
    secret: "s1", method: "POST", path: "/api/node-agent/gpu-01/heartbeat", nodeId: "gpu-01", body: calls[0].init.body,
    timestamp: calls[0].init.headers["X-Node-Timestamp"], nonce: calls[0].init.headers["X-Node-Nonce"],
    signature: calls[0].init.headers["X-Node-Signature"],
  });
  assert.equal(verified.ok, true);
  assert.equal(sentBody.agent_version, "test/1.0");
});

test("sendHeartbeat surfaces a rejected heartbeat as an error instead of failing silently", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "bad signature" });
  await assert.rejects(
    gatewayNodeAgent.sendHeartbeat({
      dashboardUrl: "https://dashboard.example", nodeId: "n1", nodeSecret: "s1",
      agentVersion: "x", capabilities: {}, fetchImpl: fakeFetch,
    }),
    /HTTP 401/,
  );
});

test("enroll returns the node identity on success and a clear error otherwise", async () => {
  const success = async () => ({
    ok: true,
    text: async () => JSON.stringify({ node_id: "n1", node_secret: "s1" }),
  });
  const identity = await gatewayNodeAgent.enroll({
    dashboardUrl: "https://dashboard.example", token: "enroll_x", name: "GPU 01",
    provider: "swiftlm", baseUrl: "https://gpu-01/v1", modelId: "m", modelName: "m",
    fetchImpl: success,
  });
  assert.deepEqual(identity, { node_id: "n1", node_secret: "s1" });

  const failure = async () => ({
    ok: false, status: 409,
    text: async () => JSON.stringify({ error: { message: "Enrollment token 已被使用過" } }),
  });
  await assert.rejects(
    gatewayNodeAgent.enroll({
      dashboardUrl: "https://dashboard.example", token: "enroll_x", name: "GPU 01",
      provider: "swiftlm", baseUrl: "https://gpu-01/v1", modelId: "m", modelName: "m",
      fetchImpl: failure,
    }),
    /已被使用過/,
  );
});
