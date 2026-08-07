const PREVIEW_LIMIT = 12_000;

export function preview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

function upstreamUrl(node, path) {
  return `${node.origin_base_url}${path}`;
}

export async function upstreamJson(config, node, path, body, { signal } = {}) {
  const response = await fetch(upstreamUrl(node, path), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${config.upstreamApiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
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

export async function streamDashboardChat({ config, node, requestBody, response, onProgress, onComplete }) {
  let clientConnected = true;
  let completionAttempted = false;
  response.on("close", () => {
    clientConnected = false;
  });

  const upstream = await fetch(upstreamUrl(node, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.upstreamApiKey}`,
      "Content-Type": "application/json",
      "X-MLX-Include-Metrics": "1",
    },
    body: JSON.stringify({
      ...requestBody,
      stream: true,
      // SwiftLM only sends usage in its final SSE chunk when explicitly requested.
      stream_options: { ...requestBody.stream_options, include_usage: true },
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    if (clientConnected) {
      response.status(upstream.status || 502).json({
        error: { message: text || "SwiftLM upstream unavailable" },
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
  let usage = null;
  let metrics = null;
  let lastPersistedAssistant = "";

  const canWrite = () => clientConnected && !response.writableEnded && !response.destroyed;
  const emitData = (data) => {
    if (canWrite()) response.write(`data: ${data}\n\n`);
  };
  const persistCompletion = async (completed) => {
    if (completionAttempted || !assistant.trim()) return null;
    completionAttempted = true;
    return onComplete({ assistant, usage, metrics, completed });
  };
  const persistProgress = async () => {
    if (!onProgress || assistant === lastPersistedAssistant) return;
    lastPersistedAssistant = assistant;
    await onProgress({ assistant, usage });
  };
  const consumeEvent = async (eventText) => {
    const eventName = eventText
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = eventText
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data);
      if (eventName === "mlx-metrics") {
        metrics = chunk;
        return;
      }
      assistant += chunk.choices?.[0]?.delta?.content || "";
      usage = chunk.usage || usage;
      emitData(JSON.stringify(chunk));
    } catch {
      emitData(JSON.stringify({ choices: [{ delta: { content: data } }] }));
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
    try {
      await persistCompletion(false);
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
  let status = 502;
  let responsePreview = "";
  let usage = null;
  let metrics = null;
  const node = {
    id: apiKey.node_id,
    name: apiKey.node_name,
    origin_base_url: apiKey.origin_base_url,
    model_id: apiKey.model_id,
    model_name: apiKey.model_name,
  };

  try {
    if (route === "/models") {
      const upstream = await upstreamJson(config, node, "/models");
      status = upstream.response.status;
      responsePreview = upstream.text;
      if (!upstream.response.ok) return res.status(status).json(upstream.data);
      return res.json({
        object: "list",
        data: [{
          id: node.model_id,
          object: "model",
          created: 0,
          owned_by: "local-swiftlm",
        }],
      });
    }

    if (route === "/chat/completions" && body?.model && body.model !== node.model_id) {
      status = 400;
      responsePreview = `Model is not available on ${node.name}`;
      return res.status(400).json({
        error: {
          message: `This API key is restricted to ${node.model_id} on ${node.name}`,
          type: "invalid_request_error",
          code: "model_not_available",
        },
      });
    }

    const upstream = await fetch(upstreamUrl(node, route), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${config.upstreamApiKey}`,
        "Content-Type": "application/json",
        Accept: req.headers.accept || "application/json",
        "X-MLX-Include-Metrics": body?.stream ? "1" : "0",
      },
      body: JSON.stringify(route === "/chat/completions" && body?.stream
        ? {
          ...body,
          model: node.model_id,
          stream_options: { ...body.stream_options, include_usage: true },
        }
        : route === "/chat/completions" ? { ...body, model: node.model_id } : body),
    });
    status = upstream.status;
    res.status(status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");

    if (body?.stream && upstream.body) {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const eventText = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const eventName = eventText.split("\n")
            .find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = eventText.split("\n").filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n");
          if (eventName === "mlx-metrics") {
            try { metrics = JSON.parse(data); } catch { /* keep transparent streaming on malformed metrics */ }
            continue;
          }
          responsePreview = preview(responsePreview + eventText);
          res.write(`${eventText}\n\n`);
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
      usage = parsed.usage || null;
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
          message: "SwiftLM upstream unavailable",
          type: "upstream_error",
          code: "upstream_unavailable",
        },
      });
    }
    res.end();
  } finally {
    store.recordRequest({
      apiKeyId: apiKey.id,
      nodeId: node.id,
      route: req.path,
      model: node.model_id,
      status,
      latencyMs: Date.now() - started,
      promptTokens: metrics?.prompt_tokens ?? usage?.prompt_tokens,
      completionTokens: metrics?.completion_tokens ?? usage?.completion_tokens,
      queueMs: metrics?.queue_ms,
      ttftMs: metrics?.ttft_ms,
      throughputTps: metrics?.throughput_tps,
      requestPreview: preview(body ?? {}),
      responsePreview,
    });
  }
}
