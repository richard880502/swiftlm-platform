import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sign } from "./nodeAgent.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      }
    } catch {
      // The child server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("an enrolled gateway rejects unsigned requests and accepts correctly signed ones", async (t) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const heartbeats = [];
  const fakeDashboard = http.createServer(async (request, response) => {
    heartbeats.push({ url: request.url, headers: request.headers, body: await readBody(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  const dashboardPort = await listen(fakeDashboard);
  t.after(() => fakeDashboard.close());

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-gateway-agent-test-"));
  const nodeId = "gpu-01";
  const nodeSecret = "test-node-secret";
  const stateFile = path.join(temporary, "node-agent.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    dashboard_url: `http://127.0.0.1:${dashboardPort}`, node_id: nodeId, node_secret: nodeSecret,
  }));

  const gatewayPort = await unusedPort();
  const child = spawn(process.execPath, [path.join(directory, "server.mjs")], {
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TARGET_HOST: "127.0.0.1",
      GATEWAY_TARGET_PORT: String(upstreamPort),
      GATEWAY_REQUEST_LOG: path.join(temporary, "requests.jsonl"),
      NODE_AGENT_STATE_FILE: stateFile,
      NODE_AGENT_HEARTBEAT_INTERVAL_MS: "200",
      PARALLEL_REQUESTS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${gatewayPort}`;
  await waitFor(`${base}/__mlx/health`, ({ ok }) => ok === true);

  const unsigned = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(unsigned.status, 401, "a request with no Gateway-Identity signature must be rejected");

  const body = { messages: [{ role: "user", content: "hi" }] };
  const signed = sign({ secret: nodeSecret, method: "POST", path: "/v1/chat/completions", nodeId, body });
  const authenticated = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed.headers },
    body: JSON.stringify(body),
  });
  assert.equal(authenticated.status, 200, await authenticated.text());

  const forged = sign({ secret: "wrong-secret", method: "POST", path: "/v1/chat/completions", nodeId, body });
  const rejected = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...forged.headers },
    body: JSON.stringify(body),
  });
  assert.equal(rejected.status, 401, "a signature from the wrong secret must be rejected");

  // Monitoring endpoints stay loopback-gated as before, unaffected by agent mode.
  const health = await fetch(`${base}/__mlx/health`);
  assert.equal(health.status, 200);

  // The gateway should have sent at least one signed heartbeat by now.
  await waitFor(`${base}/__mlx/health`, () => heartbeats.length > 0, 2000).catch(() => {});
  assert.ok(heartbeats.length > 0, "the gateway must send heartbeats once enrolled");
  const heartbeat = heartbeats[0];
  assert.equal(heartbeat.url, `/api/node-agent/${nodeId}/heartbeat`);
  const heartbeatSignature = {
    nodeId: heartbeat.headers["x-node-id"],
    timestamp: heartbeat.headers["x-node-timestamp"],
    nonce: heartbeat.headers["x-node-nonce"],
    signature: heartbeat.headers["x-node-signature"],
  };
  assert.equal(heartbeatSignature.nodeId, nodeId);
  const heartbeatBody = JSON.parse(heartbeat.body);
  assert.equal(heartbeatBody.agent_version, "mlx-gateway-node-agent/0.1.0");
});

test("a gateway with no enrollment state behaves exactly as it always has", async (t) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-gateway-noagent-test-"));
  const gatewayPort = await unusedPort();
  const child = spawn(process.execPath, [path.join(directory, "server.mjs")], {
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TARGET_HOST: "127.0.0.1",
      GATEWAY_TARGET_PORT: String(upstreamPort),
      GATEWAY_REQUEST_LOG: path.join(temporary, "requests.jsonl"),
      // No NODE_AGENT_STATE_FILE, and none exists at the default path relative to
      // this temp cwd, so node-agent mode must not activate.
      NODE_AGENT_STATE_FILE: path.join(temporary, "does-not-exist.json"),
      PARALLEL_REQUESTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${gatewayPort}`;
  const ready = await waitFor(`${base}/__mlx/health`, ({ ok }) => ok === true);
  assert.equal(ready.ok, true);

  const unsigned = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(unsigned.status, 200, "with no enrollment, no signature is required -- unchanged behaviour");
});
