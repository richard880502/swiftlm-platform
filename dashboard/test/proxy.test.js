import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proxyOpenAI, resolveCredential, streamDashboardChat, upstreamHeaders } from "../src/proxy.js";
import { verify } from "../src/nodeAuth.js";
import { createStore } from "../src/db.js";

class DisconnectingResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.writes = [];
    this.statusCode = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader() {}
  flushHeaders() {}
  json() {}

  write(value) {
    this.writes.push(value);
    if (this.writes.length === 1) {
      this.destroyed = true;
      this.emit("close");
    }
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

class MemoryResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.headersSent = false;
    this.writes = [];
    this.statusCode = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader() {}
  flushHeaders() { this.headersSent = true; }

  write(value) {
    this.headersSent = true;
    this.writes.push(value);
    return true;
  }

  end() { this.writableEnded = true; }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

test("the default node's environment key is never lent to another node", () => {
  const config = {
    upstreamApiKey: "swiftlm-master-key",
    defaultNode: { id: "mac-mini" },
  };
  assert.equal(
    resolveCredential(config, { id: "mac-mini", auth_type: "bearer" }).credential,
    "swiftlm-master-key",
  );
  // A third-party endpoint must not receive the SwiftLM master key just because it
  // was added without a credential of its own.
  assert.equal(resolveCredential(config, { id: "gpu-01", auth_type: "bearer" }).credential, null);
  assert.deepEqual(upstreamHeaders(config, { id: "gpu-01", auth_type: "bearer" }), {});
  assert.deepEqual(
    upstreamHeaders(config, { id: "gpu-01", auth_type: "none", upstream_api_key: null }),
    {},
  );
});

test("an enrolled node gets a Gateway-Identity signature on top of its own auth_type", () => {
  const config = { defaultNode: { id: "mac-mini" } };
  const enrolled = {
    id: "gpu-01", auth_type: "none", node_secret: "shared-node-secret",
    origin_base_url: "http://127.0.0.1:19999/v1",
  };
  const headers = upstreamHeaders(config, enrolled, {
    method: "POST", path: "/chat/completions", body: { messages: [] }, inference: true,
  });
  assert.equal(headers.Authorization, undefined, "auth_type none still sends no bearer header");
  assert.equal(headers["X-Node-Id"], "gpu-01");
  const verified = verify({
    secret: "shared-node-secret", method: "POST", path: "/v1/chat/completions", nodeId: "gpu-01",
    body: { messages: [] },
    timestamp: headers["X-Node-Timestamp"], nonce: headers["X-Node-Nonce"], signature: headers["X-Node-Signature"],
  });
  assert.equal(verified.ok, true);

  // A manually-added node without node_secret must not get a signature at all.
  const manual = { id: "mac-mini-manual", auth_type: "bearer", upstream_api_key: "k" };
  assert.equal(upstreamHeaders(config, manual, { method: "GET", path: "/models" })["X-Node-Signature"], undefined);
});

test("a keyless vLLM node streams through the shared adapter", async (t) => {
  let received = null;
  const upstream = http.createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    // Mirror vLLM's strictness: an unknown top-level field is a 400, so a
    // SwiftLM-specific switch reaching this backend would break the request.
    if ("enable_thinking" in body) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unknown field enable_thinking" } }));
      return;
    }
    received = { body, headers: request.headers };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    setTimeout(() => {
      response.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      response.end('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    }, 12);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const response = new MemoryResponse();
  let persisted;
  await streamDashboardChat({
    config: { upstreamApiKey: "swiftlm-master-key", defaultNode: { id: "mac-mini" } },
    node: {
      id: "gpu-01",
      origin_base_url: `http://127.0.0.1:${upstream.address().port}`,
      provider: "vllm",
      auth_type: "none",
    },
    requestBody: { messages: [], enable_thinking: true },
    response,
    onComplete: async (result) => {
      persisted = result;
      return { ok: true };
    },
  });

  assert.equal(persisted.assistant, "你好");
  assert.deepEqual(received.body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(received.body.stream_options.include_usage, true);
  assert.equal(received.headers.authorization, undefined);
  assert.equal(received.headers["x-mlx-include-metrics"], undefined);
  // Usage still lands, and the gateway fills in the timings vLLM does not report
  // inline. Queue time is the one value it cannot observe, so it stays null.
  assert.equal(persisted.metrics.prompt_tokens, 7);
  assert.equal(persisted.metrics.completion_tokens, 2);
  assert.equal(persisted.metrics.queue_ms, null);
  assert.ok(persisted.metrics.ttft_ms >= 0, "gateway-measured TTFT is recorded");
  assert.ok(persisted.metrics.throughput_tps > 0, "gateway-measured throughput is recorded");
});

test("dashboard generation is fully persisted after the browser disconnects", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"保"}}]}\n\n');
    setTimeout(() => {
      response.write('data: {"choices":[{"delta":{"content":"存"}}]}\n\n');
      response.end('event: mlx-metrics\ndata: {"prompt_tokens":4,"completion_tokens":2,"queue_ms":3,"ttft_ms":20,"throughput_tps":12.5}\n\ndata: [DONE]\n\n');
    }, 15);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const address = upstream.address();
  const response = new DisconnectingResponse();
  let persisted;
  const progress = [];
  await streamDashboardChat({
    config: {
      upstreamApiKey: "test-only",
    },
    node: { origin_base_url: `http://127.0.0.1:${address.port}` },
    requestBody: { messages: [] },
    response,
    onProgress: ({ assistant }) => progress.push(assistant),
    onComplete: async (result) => {
      persisted = result;
      return { ok: true };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.writes.length, 1);
  assert.deepEqual(progress, ["保", "保存"]);
  assert.equal(persisted.assistant, "保存");
  assert.equal(persisted.completed, true);
  assert.equal(persisted.metrics.throughput_tps, 12.5);
});

test("explicit cancellation stops the upstream stream and preserves partial output", async (t) => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  const upstream = http.createServer((request, response) => {
    request.on("close", resolveUpstreamClosed);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const address = upstream.address();
  const response = new MemoryResponse();
  const controller = new AbortController();
  let persisted;
  await streamDashboardChat({
    config: { upstreamApiKey: "test-only" },
    node: { origin_base_url: `http://127.0.0.1:${address.port}` },
    requestBody: { messages: [] },
    response,
    signal: controller.signal,
    onProgress: ({ assistant }) => {
      if (assistant === "部分") controller.abort();
    },
    onComplete: async (result) => {
      persisted = result;
      return { ok: true };
    },
  });

  assert.equal(persisted.assistant, "部分");
  assert.equal(persisted.completed, false);
  assert.equal(persisted.cancelled, true);
  assert.equal(response.statusCode, 200);
  assert.match(response.writes.join(""), /event: stopped/);
  assert.equal(response.writableEnded, true);
  const closed = await Promise.race([
    upstreamClosed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(closed, true);
});

class FakeApiResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.body = null;
    this.headersSent = false;
  }

  status(code) {
    this.statusCode = code;
    this.headersSent = true;
    return this;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  json(value) {
    this.body = value;
    return this;
  }

  send(value) {
    this.body = value;
    return this;
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("a node with two registered models forwards whichever one the client asked for", async (t) => {
  const receivedBodies = [];
  const upstream = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ object: "list", data: [] }));
      }
      receivedBodies.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-proxy-multimodel-test-"));
  const store = createStore(path.join(directory, "test.sqlite"), {
    defaultNode: {
      id: "mac-mini", name: "Mac mini", originBaseUrl: "https://unused.example/v1",
      modelId: "unused-model", modelName: "unused", upstreamApiKey: "unused",
    },
    nodeSecret: "test-secret",
  });
  t.after(() => store.close());
  const node = store.createNode({
    id: "multi-node", name: "Multi", originBaseUrl: `http://127.0.0.1:${port}`,
    modelId: "model-a", modelName: "Model A", provider: "vllm", authType: "none",
  });
  store.addNodeModel(node.id, { modelId: "model-b", modelName: "Model B" });
  store.createApiKey({ id: "key-1", name: "Test", prefix: "sk-mlx-test…", digest: "digest-1", nodeId: node.id });
  const config = { defaultNode: { id: "mac-mini" } };
  const apiKey = {
    id: "key-1", node_id: node.id, node_name: node.name, origin_base_url: node.origin_base_url,
    model_id: node.model_id, model_name: node.model_name, upstream_api_key: null, node_secret: null,
    provider: node.provider, protocol: node.protocol, auth_type: node.auth_type, auth_header: null,
  };

  const modelsRes = new FakeApiResponse();
  await proxyOpenAI({
    config, store, apiKey,
    req: { path: "/v1/models", method: "GET", headers: {} },
    res: modelsRes,
  });
  assert.deepEqual(modelsRes.body.data.map((m) => m.id).sort(), ["model-a", "model-b"]);

  const secondModelRes = new FakeApiResponse();
  await proxyOpenAI({
    config, store, apiKey,
    req: {
      path: "/v1/chat/completions", method: "POST", headers: {},
      body: { model: "model-b", messages: [{ role: "user", content: "hi" }] },
    },
    res: secondModelRes,
  });
  assert.equal(secondModelRes.statusCode, 200, JSON.stringify(secondModelRes.body));
  assert.equal(receivedBodies[0].model, "model-b", "the requested model must reach upstream unmodified");

  const rejectedRes = new FakeApiResponse();
  await proxyOpenAI({
    config, store, apiKey,
    req: {
      path: "/v1/chat/completions", method: "POST", headers: {},
      body: { model: "model-c", messages: [] },
    },
    res: rejectedRes,
  });
  assert.equal(rejectedRes.statusCode, 400);
  assert.equal(receivedBodies.length, 1, "an unregistered model must never reach upstream");
});
