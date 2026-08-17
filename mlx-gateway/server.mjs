import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createNonceCache,
  loadAgentState,
  parseSignatureHeaders,
  sendHeartbeat,
  verify as verifyGatewaySignature,
} from "./nodeAgent.mjs";

const NODE_AGENT_VERSION = "mlx-gateway-node-agent/0.1.0";

const listenHost = process.env.GATEWAY_HOST || "0.0.0.0";
const listenPort = positiveInt(process.env.GATEWAY_PORT, 18124);
const upstreamHost = process.env.GATEWAY_TARGET_HOST || "127.0.0.1";
const upstreamPort = positiveInt(process.env.GATEWAY_TARGET_PORT, 18123);
const parallelLimit = positiveInt(process.env.PARALLEL_REQUESTS, 1);
const maxBodyBytes = positiveInt(process.env.GATEWAY_MAX_BODY_BYTES, 20 * 1024 * 1024);
const requestLog = process.env.GATEWAY_REQUEST_LOG || path.resolve(".state/requests.jsonl");
const maxLogBytes = positiveInt(process.env.GATEWAY_LOG_MAX_BYTES, 10 * 1024 * 1024);
// Node-agent mode is entirely opt-in: it only activates once `join.mjs` has
// written enrollment state to disk. A gateway that has never enrolled behaves
// exactly as it always has -- no signature requirement, no heartbeat traffic,
// zero risk to the existing production deployment that predates this feature.
const nodeAgentStateFile = process.env.NODE_AGENT_STATE_FILE || path.resolve(".state/node-agent.json");
const heartbeatIntervalMs = positiveInt(process.env.NODE_AGENT_HEARTBEAT_INTERVAL_MS, 30_000);
const agentState = loadAgentState(nodeAgentStateFile);
const gatewaySignatureNonceCache = agentState ? createNonceCache() : null;

const queue = [];
const running = new Map();
const recent = loadRecent();

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function iso(timestamp = Date.now()) {
  return new Date(timestamp).toISOString();
}

function rotateLogIfNeeded() {
  try {
    if (fs.statSync(requestLog).size < maxLogBytes) return;
    const rotated = `${requestLog}.1`;
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    fs.renameSync(requestLog, rotated);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function logEvent(event) {
  fs.mkdirSync(path.dirname(requestLog), { recursive: true });
  rotateLogIfNeeded();
  fs.appendFileSync(requestLog, `${JSON.stringify({ timestamp: iso(), ...event })}\n`, { mode: 0o600 });
}

function loadRecent() {
  try {
    const lines = fs.readFileSync(requestLog, "utf8").trim().split("\n").slice(-400);
    return lines.flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return ["completed", "failed", "cancelled"].includes(event.event) ? [event] : [];
      } catch {
        return [];
      }
    }).slice(-50).reverse();
  } catch {
    return [];
  }
}

function addRecent(event) {
  recent.unshift(event);
  if (recent.length > 50) recent.length = 50;
}

function isInference(pathname, method) {
  return method === "POST" && ["/v1/chat/completions", "/v1/completions"].includes(pathname);
}

function publicEntry(job, state, now = Date.now()) {
  const outputWindowMs = job.firstTokenAt == null ? null : Math.max(now - job.firstTokenAt, 1);
  return {
    request_id: job.id,
    state,
    method: job.method,
    path: job.path,
    queue_ms: job.upstreamStartedAt == null ? Math.max(now - job.receivedAt, 0) : job.upstreamStartedAt - job.receivedAt,
    elapsed_ms: Math.max(now - job.receivedAt, 0),
    ttft_ms: job.firstTokenAt == null ? null : job.firstTokenAt - job.receivedAt,
    output_chunks: job.outputChunks,
    output_chunks_per_second: outputWindowMs == null ? null : job.outputChunks / (outputWindowMs / 1000),
    received_at: iso(job.receivedAt),
  };
}

function snapshot() {
  const now = Date.now();
  const active = [
    ...[...running.values()].map((job) => publicEntry(job, "running", now)),
    ...queue.map((job) => publicEntry(job, "waiting", now)),
  ];
  return {
    summary: {
      running: running.size,
      waiting: queue.length,
      parallel_limit: parallelLimit,
    },
    active,
    recent: recent.slice(0, 20),
  };
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("aborted", () => reject(Object.assign(new Error("Client aborted request"), { cancelled: true })));
    request.on("error", reject);
  });
}

function finishJob(job, event, extra = {}) {
  if (job.finished) return null;
  job.finished = true;
  running.delete(job.id);
  const finishedAt = Date.now();
  const decodeMs = job.firstTokenAt == null ? null : Math.max(finishedAt - job.firstTokenAt, 1);
  const throughput = job.upstreamThroughput
    ?? (job.completionTokens == null || decodeMs == null
      ? null
      : job.completionTokens / (decodeMs / 1000));
  const streamChunksPerSecond = job.outputChunks === 0 || decodeMs == null
    ? null
    : job.outputChunks / (decodeMs / 1000);
  const record = {
    request_id: job.id,
    event,
    method: job.method,
    path: job.path,
    status: job.statusCode ?? extra.status ?? 502,
    queue_ms: job.upstreamStartedAt == null ? null : job.upstreamStartedAt - job.receivedAt,
    ttft_ms: job.firstTokenAt == null ? null : job.firstTokenAt - job.receivedAt,
    latency_ms: finishedAt - job.receivedAt,
    prompt_tokens: job.promptTokens,
    completion_tokens: job.completionTokens,
    throughput_tps: throughput == null ? null : Number(throughput.toFixed(3)),
    stream_chunks_per_second: streamChunksPerSecond == null
      ? null
      : Number(streamChunksPerSecond.toFixed(3)),
    output_chunks: job.outputChunks,
    error: extra.error ? String(extra.error).slice(0, 240) : undefined,
  };
  logEvent(record);
  addRecent({ timestamp: iso(finishedAt), ...record });
  drainQueue();
  return record;
}

function parseSse(job, chunk) {
  job.sseBuffer += chunk.toString("utf8").replace(/\r\n/g, "\n");
  let boundary;
  while ((boundary = job.sseBuffer.indexOf("\n\n")) >= 0) {
    const event = job.sseBuffer.slice(0, boundary);
    job.sseBuffer = job.sseBuffer.slice(boundary + 2);
    const data = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) {
        if (job.firstTokenAt == null) {
          job.firstTokenAt = Date.now();
          logEvent({ request_id: job.id, event: "first_token", ttft_ms: job.firstTokenAt - job.receivedAt });
        }
        job.outputChunks += 1;
      }
      if (parsed.usage) {
        job.promptTokens = parsed.usage.prompt_tokens ?? job.promptTokens;
        job.completionTokens = parsed.usage.completion_tokens ?? job.completionTokens;
      }
    } catch {
      // Preserve transparent proxying even if an upstream event is non-JSON.
    }
  }
}

function parseJsonMetrics(job) {
  if (!job.responseMetrics.length) return;
  try {
    const parsed = JSON.parse(Buffer.concat(job.responseMetrics).toString("utf8"));
    job.promptTokens = parsed.usage?.prompt_tokens ?? null;
    job.completionTokens = parsed.usage?.completion_tokens ?? null;
    job.upstreamThroughput = parsed.timings?.predicted_per_second ?? null;
  } catch {
    // Metrics are best-effort and never change the proxied response.
  }
}

function startUpstream(job) {
  if (job.cancelled || job.finished) return drainQueue();
  job.upstreamStartedAt = Date.now();
  running.set(job.id, job);
  logEvent({
    request_id: job.id,
    event: "started",
    method: job.method,
    path: job.path,
    queue_ms: job.upstreamStartedAt - job.receivedAt,
    running: running.size,
    waiting: queue.length,
  });

  const headers = { ...job.headers, host: `${upstreamHost}:${upstreamPort}` };
  delete headers["content-length"];
  headers["content-length"] = String(job.body.length);
  const upstream = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: job.method,
    path: job.upstreamPath,
    headers,
  });
  job.upstream = upstream;
  upstream.setTimeout(0);
  upstream.on("response", (upstreamResponse) => {
    job.statusCode = upstreamResponse.statusCode || 502;
    job.isSse = (upstreamResponse.headers["content-type"] || "").includes("text/event-stream");
    if (!job.response.headersSent && !job.response.destroyed) {
      job.response.writeHead(job.statusCode, {
        ...upstreamResponse.headers,
        "x-mlx-request-id": job.id,
      });
    }
    upstreamResponse.on("data", (chunk) => {
      if (job.isSse) parseSse(job, chunk);
      else if (job.responseMetricBytes < 2 * 1024 * 1024) {
        job.responseMetrics.push(chunk);
        job.responseMetricBytes += chunk.length;
      }
      if (!job.response.destroyed && !job.response.write(chunk)) {
        upstreamResponse.pause();
        job.response.once("drain", () => upstreamResponse.resume());
      }
    });
    upstreamResponse.on("end", () => {
      if (!job.isSse) parseJsonMetrics(job);
      const record = finishJob(job, job.statusCode >= 200 && job.statusCode < 400 ? "completed" : "failed");
      // Dashboard opts into this final SSE event so it can save exact Gateway
      // metrics without exposing the local monitoring endpoint through Wonder Mesh.
      if (record && job.isSse && job.headers["x-mlx-include-metrics"] === "1"
        && !job.response.destroyed && !job.response.writableEnded) {
        job.response.write(`event: mlx-metrics\ndata: ${JSON.stringify(record)}\n\n`);
      }
      if (!job.response.destroyed && !job.response.writableEnded) job.response.end();
    });
    upstreamResponse.on("error", (error) => finishJob(job, "failed", { error: error.message }));
  });
  upstream.on("error", (error) => {
    if (!job.response.headersSent && !job.response.destroyed) {
      writeJson(job.response, 502, { error: { message: "SwiftLM upstream unavailable" }, request_id: job.id });
    } else if (!job.response.destroyed && !job.response.writableEnded) {
      job.response.end();
    }
    finishJob(job, "failed", { error: error.message, status: 502 });
  });
  upstream.end(job.body);
}

function drainQueue() {
  while (running.size < parallelLimit && queue.length) {
    startUpstream(queue.shift());
  }
}

function enqueue(job) {
  queue.push(job);
  logEvent({
    request_id: job.id,
    event: "queued",
    method: job.method,
    path: job.path,
    running: running.size,
    waiting: queue.length,
  });
  drainQueue();
}

function proxyUnqueued(request, response, body, requestId, displayPath) {
  const startedAt = Date.now();
  const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
  delete headers["content-length"];
  headers["content-length"] = String(body.length);
  logEvent({ request_id: requestId, event: "started", method: request.method, path: displayPath });
  const upstream = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    const status = upstreamResponse.statusCode || 502;
    response.writeHead(status, { ...upstreamResponse.headers, "x-mlx-request-id": requestId });
    upstreamResponse.pipe(response);
    upstreamResponse.on("end", () => {
      const record = {
        request_id: requestId,
        event: status >= 200 && status < 400 ? "completed" : "failed",
        method: request.method,
        path: displayPath,
        status,
        latency_ms: Date.now() - startedAt,
      };
      logEvent(record);
      addRecent({ timestamp: iso(), ...record });
    });
  });
  upstream.setTimeout(0);
  upstream.on("error", (error) => {
    if (!response.headersSent) writeJson(response, 502, { error: { message: "SwiftLM upstream unavailable" }, request_id: requestId });
    const record = { request_id: requestId, event: "failed", method: request.method, path: displayPath, status: 502, latency_ms: Date.now() - startedAt, error: error.message.slice(0, 240) };
    logEvent(record);
    addRecent({ timestamp: iso(), ...record });
  });
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
  upstream.end(body);
}

// Gateway Identity: once enrolled, every request that would reach the local
// backend must be signed by the Dashboard's copy of this node's secret. This is
// what actually closes the gap a manually-added node still has -- knowing this
// gateway's network address is no longer enough to use the GPU behind it.
// Monitoring endpoints (`/__mlx/*`) stay loopback-only as before and are not
// affected, since they are checked before this runs.
function verifyGatewayRequest(request, body) {
  const signature = parseSignatureHeaders(request.headers);
  if (signature.nodeId !== agentState.node_id) return "node id mismatch";
  const result = verifyGatewaySignature({
    secret: agentState.node_secret,
    method: request.method,
    path: request.url,
    nodeId: agentState.node_id,
    body: body.toString("utf8"),
    timestamp: signature.timestamp,
    nonce: signature.nonce,
    signature: signature.signature,
    nonceCache: gatewaySignatureNonceCache,
  });
  return result.ok ? null : result.reason;
}

function startHeartbeatLoop() {
  const beat = async () => {
    try {
      await sendHeartbeat({
        dashboardUrl: agentState.dashboard_url,
        nodeId: agentState.node_id,
        nodeSecret: agentState.node_secret,
        agentVersion: NODE_AGENT_VERSION,
        capabilities: { running: running.size, waiting: queue.length, parallel_limit: parallelLimit },
      });
    } catch (error) {
      // A missed heartbeat just leaves the node looking stale in the dashboard
      // until the next tick; it must never take inference down.
      console.error(JSON.stringify({ event: "heartbeat_failed", error: error.message }));
    }
  };
  beat();
  return setInterval(beat, heartbeatIntervalMs).unref();
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/__mlx/requests" || pathname === "/__mlx/health") {
    if (!isLoopback(request.socket.remoteAddress)) return writeJson(response, 404, { error: "Not found" });
    return writeJson(response, 200, pathname.endsWith("health")
      ? { ok: true, service: "mlx-gateway", upstream: `${upstreamHost}:${upstreamPort}`, ...snapshot().summary }
      : snapshot());
  }

  const id = randomUUID();
  try {
    const body = await collectBody(request);
    if (agentState) {
      const rejection = verifyGatewayRequest(request, body);
      if (rejection) {
        return writeJson(response, 401, { error: { message: `Gateway signature rejected: ${rejection}` }, request_id: id });
      }
    }
    if (!isInference(pathname, request.method)) {
      return proxyUnqueued(request, response, body, id, pathname);
    }
    const job = {
      id,
      request,
      response,
      method: request.method,
      path: pathname,
      upstreamPath: request.url,
      headers: request.headers,
      body,
      receivedAt: Date.now(),
      upstreamStartedAt: null,
      firstTokenAt: null,
      outputChunks: 0,
      promptTokens: null,
      completionTokens: null,
      upstreamThroughput: null,
      responseMetrics: [],
      responseMetricBytes: 0,
      sseBuffer: "",
      finished: false,
      cancelled: false,
    };
    response.setHeader("x-mlx-request-id", id);
    response.on("close", () => {
      if (response.writableEnded || job.finished) return;
      job.cancelled = true;
      const queueIndex = queue.indexOf(job);
      if (queueIndex >= 0) queue.splice(queueIndex, 1);
      if (job.upstream) job.upstream.destroy();
      finishJob(job, "cancelled", { status: 499 });
    });
    enqueue(job);
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      writeJson(response, error.statusCode || 400, { error: { message: error.message }, request_id: id });
    }
    const record = { request_id: id, event: error.cancelled ? "cancelled" : "failed", method: request.method, path: request.url, status: error.statusCode || 400, error: error.message.slice(0, 240) };
    logEvent(record);
    addRecent({ timestamp: iso(), ...record });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

server.listen(listenPort, listenHost, () => {
  console.log(JSON.stringify({
    event: "ready",
    service: "mlx-gateway",
    listen: `${listenHost}:${listenPort}`,
    upstream: `${upstreamHost}:${upstreamPort}`,
    parallel: parallelLimit,
    request_log: requestLog,
    node_agent: agentState ? { node_id: agentState.node_id, dashboard_url: agentState.dashboard_url } : null,
  }));
  if (agentState) startHeartbeatLoop();
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", service: "mlx-gateway", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
