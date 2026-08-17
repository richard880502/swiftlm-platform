import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

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

async function startDashboard({ port, upstreamBaseUrl }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-multimodel-test-"));
  const child = spawn("node", ["src/server.js"], {
    cwd: dashboardDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "test-admin-password",
      SESSION_SECRET: "test-session-secret",
      KEY_HASH_SECRET: "test-key-hash-secret",
      UPSTREAM_BASE_URL: upstreamBaseUrl,
      UPSTREAM_API_KEY: "swiftlm-master-key",
      DEFAULT_NODE_ID: "mac-mini",
      MODEL_ID: "default-model",
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

async function call(base, pathname, { method = "GET", body, cookie, token } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

test("a node serving two models routes each request to the model the client asked for", { timeout: 20_000 }, async (t) => {
  const receivedModels = [];
  const backend = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ object: "list", data: [] }));
    }
    const raw = await readBody(request);
    const body = JSON.parse(raw);
    receivedModels.push(body.model);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: `reply for ${body.model}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  const backendPort = await listen(backend);
  t.after(() => backend.close());

  const dashboard = await startDashboard({ port: 18501, upstreamBaseUrl: "http://127.0.0.1:1/v1" });
  t.after(() => dashboard.stop());
  const cookie = await adminCookie(dashboard.base);

  const created = await call(dashboard.base, "/api/nodes", {
    method: "POST", cookie,
    body: {
      name: "Multi Model Node", provider: "vllm", auth_type: "none",
      origin_base_url: `http://127.0.0.1:${backendPort}/v1`,
      model_id: "model-a", model_name: "Model A",
    },
  });
  assert.equal(created.response.status, 201);
  const nodeId = created.json.id;

  const models = await call(dashboard.base, `/api/nodes/${nodeId}/models`, { cookie });
  assert.equal(models.json.data.length, 1);

  const added = await call(dashboard.base, `/api/nodes/${nodeId}/models`, {
    method: "POST", cookie, body: { model_id: "model-b", model_name: "Model B" },
  });
  assert.equal(added.response.status, 201);
  assert.equal(added.json.data.length, 2);

  const duplicate = await call(dashboard.base, `/api/nodes/${nodeId}/models`, {
    method: "POST", cookie, body: { model_id: "model-b", model_name: "dup" },
  });
  assert.equal(duplicate.response.status, 409);

  const key = await call(dashboard.base, "/api/keys", { method: "POST", cookie, body: { name: "test", node_id: nodeId } });

  const clientModels = await call(dashboard.base, "/v1/models", { token: key.json.key });
  assert.deepEqual(clientModels.json.data.map((m) => m.id).sort(), ["model-a", "model-b"]);

  const replyA = await call(dashboard.base, "/v1/chat/completions", {
    method: "POST", token: key.json.key, body: { model: "model-a", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(replyA.response.status, 200);
  assert.match(replyA.json.choices[0].message.content, /model-a/);

  const replyB = await call(dashboard.base, "/v1/chat/completions", {
    method: "POST", token: key.json.key, body: { model: "model-b", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(replyB.response.status, 200);
  assert.match(replyB.json.choices[0].message.content, /model-b/);
  assert.deepEqual(receivedModels, ["model-a", "model-b"], "each request must reach upstream with the model actually requested");

  const rejected = await call(dashboard.base, "/v1/chat/completions", {
    method: "POST", token: key.json.key, body: { model: "model-c", messages: [] },
  });
  assert.equal(rejected.response.status, 400, "a model never registered on this node must be refused");

  // Disabling a model takes it out of client reach even though it still exists.
  const modelBRow = added.json.data.find((m) => m.model_id === "model-b");
  const disabled = await call(dashboard.base, `/api/nodes/${nodeId}/models/${modelBRow.id}/enabled`, {
    method: "PATCH", cookie, body: { enabled: false },
  });
  assert.equal(disabled.response.status, 200);
  const afterDisable = await call(dashboard.base, "/v1/chat/completions", {
    method: "POST", token: key.json.key, body: { model: "model-b", messages: [] },
  });
  assert.equal(afterDisable.response.status, 400, "a disabled model must be refused even though the row still exists");

  const modelsAfterDisable = await call(dashboard.base, "/v1/models", { token: key.json.key });
  assert.deepEqual(modelsAfterDisable.json.data.map((m) => m.id), ["model-a"]);

  // Removing the model row entirely, then trying to remove the very last one.
  const removed = await call(dashboard.base, `/api/nodes/${nodeId}/models/${modelBRow.id}`, { method: "DELETE", cookie });
  assert.equal(removed.response.status, 200);
  const modelARow = removed.json.data[0];
  const blocked = await call(dashboard.base, `/api/nodes/${nodeId}/models/${modelARow.id}`, { method: "DELETE", cookie });
  assert.equal(blocked.response.status, 409, "the last remaining model on a node cannot be removed");
});

test("a conversation targeting a node's second model sends that model, not the node's default", { timeout: 20_000 }, async (t) => {
  const receivedModels = [];
  const backend = http.createServer(async (request, response) => {
    const raw = await readBody(request);
    const body = JSON.parse(raw);
    receivedModels.push(body.model);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  const backendPort = await listen(backend);
  t.after(() => backend.close());

  const dashboard = await startDashboard({ port: 18502, upstreamBaseUrl: "http://127.0.0.1:1/v1" });
  t.after(() => dashboard.stop());
  const cookie = await adminCookie(dashboard.base);

  const created = await call(dashboard.base, "/api/nodes", {
    method: "POST", cookie,
    body: {
      name: "Chat Multi Model", provider: "vllm", auth_type: "none",
      origin_base_url: `http://127.0.0.1:${backendPort}/v1`,
      model_id: "model-a", model_name: "Model A",
    },
  });
  const nodeId = created.json.id;
  await call(dashboard.base, `/api/nodes/${nodeId}/models`, {
    method: "POST", cookie, body: { model_id: "model-b", model_name: "Model B" },
  });

  const conversation = await call(dashboard.base, "/api/conversations", {
    method: "POST", cookie, body: { node_id: nodeId, model_id: "model-b" },
  });
  assert.equal(conversation.response.status, 201);
  assert.equal(conversation.json.model_id, "model-b");

  await call(dashboard.base, `/api/conversations/${conversation.json.id}/messages`, {
    method: "POST", cookie, body: { content: "hi" },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(receivedModels, ["model-b"], "the conversation's own model must reach upstream, not the node's default");

  const activity = await call(dashboard.base, "/api/activity", { cookie });
  const row = activity.json.data.find((r) => r.route === "/api/conversations/:id/messages");
  assert.equal(row.model, "model-b", "activity history must record the model actually used");

  // A conversation cannot be created against a model the node doesn't have.
  const invalid = await call(dashboard.base, "/api/conversations", {
    method: "POST", cookie, body: { node_id: nodeId, model_id: "model-c" },
  });
  assert.equal(invalid.response.status, 400);
});
