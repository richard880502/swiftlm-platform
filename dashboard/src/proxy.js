import {
  buildAuthHeaders,
  prepareRequestBody,
  providerHeaders,
  readJsonMetrics,
  readStreamEvent,
} from "./providers.js";
import { sign } from "./nodeAuth.js";

const PREVIEW_LIMIT = 12_000;
const UPSTREAM_UNAVAILABLE = "Inference node unavailable";

export function preview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

function upstreamUrl(node, path) {
  return `${node.origin_base_url}${path}`;
}

// The default node's credential lives in the server environment rather than the
// database. It must never be lent to any other node: a third-party endpoint would
// otherwise receive the SwiftLM master key.
export function resolveCredential(config, node) {
  const isDefaultNode = Boolean(config?.defaultNode?.id) && node?.id === config.defaultNode.id;
  return {
    authType: node?.auth_type || "bearer",
    authHeader: node?.auth_header,
    credential: node?.upstream_api_key || (isDefaultNode ? config.upstreamApiKey : null),
  };
}

// Gateway Identity: an enrolled node's own signature layer, orthogonal to whatever
// credential its local backend needs. It is additive -- a node keeps whatever
// auth_type it was configured with, and gets a signature on top the moment it has
// a node_secret, regardless of that auth_type. A manually-added node has no
// node_secret and this is a no-op, so its behaviour is unchanged.
function gatewayIdentityHeaders(node, { method, path, body }) {
  if (!node?.node_secret) return {};
  const signaturePath = new URL(upstreamUrl(node, path)).pathname;
  return sign({ secret: node.node_secret, method, path: signaturePath, nodeId: node.id, body }).headers;
}

export function upstreamHeaders(config, node, {
  method = "GET", path = "", body, stream = false, json = false, inference = false,
} = {}) {
  return {
    ...buildAuthHeaders(resolveCredential(config, node)),
    ...(inference ? providerHeaders(node, { stream }) : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...gatewayIdentityHeaders(node, { method, path, body }),
  };
}

// Metrics are normalized into one vocabulary across backends. A provider that
// reports its own numbers always wins; otherwise the gateway falls back to what it
// can observe from the stream itself, so a vLLM or llama.cpp request still shows
// throughput instead of a blank row. Gateway-measured TTFT includes the network
// round trip to the node, which is why a provider-reported value takes precedence.
// queue_ms stays null unless the backend reports it, because the gateway cannot see
// upstream queueing.
export function createMetricsCollector() {
  const startedAt = Date.now();
  let firstTokenAt = null;
  let reported = null;
  let usage = null;

  return {
    markFirstToken() {
      if (firstTokenAt == null) firstTokenAt = Date.now();
    },
    setReported(metrics) {
      if (metrics) reported = metrics;
    },
    setUsage(value) {
      if (value) usage = value;
    },
    get usage() {
      return usage;
    },
    result() {
      const promptTokens = reported?.prompt_tokens ?? usage?.prompt_tokens ?? null;
      const completionTokens = reported?.completion_tokens ?? usage?.completion_tokens ?? null;
      const decodeMs = firstTokenAt == null ? null : Math.max(Date.now() - firstTokenAt, 1);
      const measured = completionTokens == null || decodeMs == null
        ? null
        : Number((completionTokens / (decodeMs / 1000)).toFixed(3));
      return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        queue_ms: reported?.queue_ms ?? null,
        ttft_ms: reported?.ttft_ms ?? (firstTokenAt == null ? null : firstTokenAt - startedAt),
        throughput_tps: reported?.throughput_tps ?? measured,
      };
    },
  };
}

function sseEventName(eventText) {
  return eventText
    .split("\n")
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
}

function sseData(eventText) {
  return eventText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export async function upstreamJson(config, node, path, body, { signal } = {}) {
  const method = body === undefined ? "GET" : "POST";
  const response = await fetch(upstreamUrl(node, path), {
    method,
    headers: upstreamHeaders(config, node, { method, path, body, json: body !== undefined }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: text || `Upstream returned HTTP ${response.status}` } };
  }
  return { response, data, text };
}

export async function streamDashboardChat({
  config, node, requestBody, response, onProgress, onComplete, signal,
}) {
  let clientConnected = true;
  let completionAttempted = false;
  response.on("close", () => {
    clientConnected = false;
  });

  const metricsCollector = createMetricsCollector();
  const preparedBody = prepareRequestBody(node, { ...requestBody, stream: true }, { stream: true });
  const upstream = await fetch(upstreamUrl(node, "/chat/completions"), {
    method: "POST",
    headers: upstreamHeaders(config, node, {
      method: "POST", path: "/chat/completions", body: preparedBody,
      stream: true, json: true, inference: true,
    }),
    body: JSON.stringify(preparedBody),
    signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    if (clientConnected) {
      response.status(upstream.status || 502).json({
        error: { message: text || UPSTREAM_UNAVAILABLE },
      });
    }
    return;
  }

  if (clientConnected) {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistant = "";
  let lastPersistedAssistant = "";

  const canWrite = () => clientConnected && !response.writableEnded && !response.destroyed;
  const emitData = (data) => {
    if (canWrite()) response.write(`data: ${data}\n\n`);
  };
  const persistCompletion = async (completed, { cancelled = false } = {}) => {
    if (completionAttempted || (!assistant.trim() && !cancelled)) return null;
    completionAttempted = true;
    return onComplete({
      assistant,
      usage: metricsCollector.usage,
      metrics: metricsCollector.result(),
      completed,
      cancelled,
    });
  };
  const persistProgress = async () => {
    if (!onProgress || assistant === lastPersistedAssistant) return;
    lastPersistedAssistant = assistant;
    await onProgress({ assistant, usage: metricsCollector.usage });
  };
  const consumeEvent = async (eventText) => {
    const eventName = sseEventName(eventText);
    const data = sseData(eventText);
    if (!data || data === "[DONE]") return;
    const providerEvent = readStreamEvent(node, { eventName, data });
    if (providerEvent.consumed) {
      metricsCollector.setReported(providerEvent.metrics);
      return;
    }
    try {
      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) metricsCollector.markFirstToken();
      assistant += delta;
      metricsCollector.setUsage(chunk.usage);
      emitData(JSON.stringify(chunk));
    } catch {
      emitData(JSON.stringify({ choices: [{ delta: { content: data } }] }));
      metricsCollector.markFirstToken();
      assistant += data;
    }
    await persistProgress();
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        await consumeEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consumeEvent(buffer);
    const saved = await persistCompletion(true);
    if (canWrite()) response.write(`event: dashboard\ndata: ${JSON.stringify(saved)}\n\n`);
    emitData("[DONE]");
    if (canWrite()) response.end();
  } catch (error) {
    const cancelled = Boolean(signal?.aborted);
    try {
      const saved = await persistCompletion(false, { cancelled });
      if (cancelled && canWrite()) {
        if (!response.headersSent) {
          response.status(200);
          response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache, no-transform");
          response.flushHeaders();
        }
        response.write(`event: stopped\ndata: ${JSON.stringify(saved)}\n\n`);
        emitData("[DONE]");
        response.end();
        return;
      }
    } catch {
      // Preserve the original streaming error for the connected client.
    }
    if (canWrite()) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      response.end();
    }
  }
}

export async function proxyOpenAI({ config, req, res, apiKey, store }) {
  const started = Date.now();
  const route = req.path.replace(/^\/v1/, "") || "/";
  const body = req.method === "GET" ? undefined : req.body;
  const stream = Boolean(body?.stream);
  let status = 502;
  let responsePreview = "";
  const metricsCollector = createMetricsCollector();
  const node = {
    id: apiKey.node_id,
    name: apiKey.node_name,
    origin_base_url: apiKey.origin_base_url,
    model_id: apiKey.model_id,
    model_name: apiKey.model_name,
    upstream_api_key: apiKey.upstream_api_key,
    node_secret: apiKey.node_secret,
    provider: apiKey.provider,
    protocol: apiKey.protocol,
    auth_type: apiKey.auth_type,
    auth_header: apiKey.auth_header,
  };

  try {
    if (route === "/models") {
      const upstream = await upstreamJson(config, node, "/models");
      status = upstream.response.status;
      responsePreview = upstream.text;
      if (!upstream.response.ok) return res.status(status).json(upstream.data);
      // Clients see the models this key is allowed to use, never the backend's own
      // catalogue -- a node registered with two models lists both even if the
      // backend itself happens to expose more.
      return res.json({
        object: "list",
        data: store.listNodeModels(node.id)
          .filter((model) => model.enabled)
          .map((model) => ({
            id: model.model_id,
            object: "model",
            created: 0,
            owned_by: node.provider || "swiftlm",
          })),
      });
    }

    if (route === "/chat/completions" && body?.model && !store.isModelAllowedOnNode(node.id, body.model)) {
      status = 400;
      responsePreview = `Model is not available on ${node.name}`;
      return res.status(400).json({
        error: {
          message: `This API key is restricted to models registered on ${node.name}`,
          type: "invalid_request_error",
          code: "model_not_available",
        },
      });
    }

    const isChat = route === "/chat/completions";
    // The client's requested model is forwarded as-is (defaulting to the node's
    // primary model only when omitted) -- a node can serve more than one model,
    // so silently overwriting whatever the client asked for would route every
    // request to the wrong one.
    const preparedBody = isChat
      ? prepareRequestBody(node, { ...body, model: body?.model || node.model_id }, { stream })
      : body;
    const upstream = await fetch(upstreamUrl(node, route), {
      method: req.method,
      headers: {
        ...upstreamHeaders(config, node, {
          method: req.method, path: route, body: preparedBody, stream, json: true, inference: true,
        }),
        Accept: req.headers.accept || "application/json",
      },
      body: JSON.stringify(preparedBody),
    });
    status = upstream.status;
    res.status(status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");

    if (stream && upstream.body) {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const forwardEvent = (eventText) => {
        const data = sseData(eventText);
        const providerEvent = readStreamEvent(node, { eventName: sseEventName(eventText), data });
        // Provider-specific metrics events are consumed here so a client only ever
        // sees standard OpenAI chunks, whatever backend produced them.
        if (providerEvent.consumed) {
          metricsCollector.setReported(providerEvent.metrics);
          return;
        }
        observeChunk(metricsCollector, data);
        responsePreview = preview(responsePreview + eventText);
        res.write(`${eventText}\n\n`);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          forwardEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
        }
      }
      buffer += decoder.decode();
      if (buffer) {
        responsePreview = preview(responsePreview + buffer);
        res.write(buffer);
      }
      res.end();
      return;
    }

    const text = await upstream.text();
    responsePreview = preview(text);
    try {
      const parsed = JSON.parse(text);
      metricsCollector.setUsage(parsed.usage);
      metricsCollector.setReported(readJsonMetrics(node, parsed));
      return res.json(parsed);
    } catch {
      return res.send(text);
    }
  } catch (error) {
    status = 502;
    responsePreview = error.message;
    if (!res.headersSent) {
      return res.status(502).json({
        error: {
          message: UPSTREAM_UNAVAILABLE,
          type: "upstream_error",
          code: "upstream_unavailable",
        },
      });
    }
    res.end();
  } finally {
    const metrics = metricsCollector.result();
    store.recordRequest({
      apiKeyId: apiKey.id,
      nodeId: node.id,
      route: req.path,
      model: node.model_id,
      status,
      latencyMs: Date.now() - started,
      promptTokens: metrics.prompt_tokens,
      completionTokens: metrics.completion_tokens,
      queueMs: metrics.queue_ms,
      ttftMs: metrics.ttft_ms,
      throughputTps: metrics.throughput_tps,
      requestPreview: preview(body ?? {}),
      responsePreview,
    });
  }
}

// Client traffic is forwarded verbatim, but the chunk is still inspected so usage
// and timing are recorded for backends that report no metrics of their own.
function observeChunk(metricsCollector, data) {
  if (!data || data === "[DONE]") return;
  try {
    const chunk = JSON.parse(data);
    if (chunk.choices?.[0]?.delta?.content) metricsCollector.markFirstToken();
    metricsCollector.setUsage(chunk.usage);
  } catch {
    // Metrics are best-effort and never change what the client receives.
  }
}
