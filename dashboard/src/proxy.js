const PREVIEW_LIMIT = 12_000;

export function preview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

export async function upstreamJson(config, path, body, { signal } = {}) {
  const response = await fetch(`${config.upstreamBaseUrl}${path}`, {
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

export async function streamDashboardChat({ config, requestBody, response, onComplete }) {
  let clientConnected = true;
  let completionAttempted = false;
  response.on("close", () => {
    clientConnected = false;
  });

  const upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.upstreamApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...requestBody, stream: true }),
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

  const canWrite = () => clientConnected && !response.writableEnded && !response.destroyed;
  const emitData = (data) => {
    if (canWrite()) response.write(`data: ${data}\n\n`);
  };
  const persistCompletion = async (completed) => {
    if (completionAttempted || !assistant.trim()) return null;
    completionAttempted = true;
    return onComplete({ assistant, usage, completed });
  };
  const consumeEvent = (eventText) => {
    const data = eventText
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data);
      assistant += chunk.choices?.[0]?.delta?.content || "";
      usage = chunk.usage || usage;
      emitData(JSON.stringify(chunk));
    } catch {
      emitData(JSON.stringify({ choices: [{ delta: { content: data } }] }));
      assistant += data;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        consumeEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
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

  try {
    if (route === "/models") {
      const upstream = await upstreamJson(config, "/models");
      status = upstream.response.status;
      responsePreview = upstream.text;
      if (!upstream.response.ok) return res.status(status).json(upstream.data);
      return res.json({
        object: "list",
        data: [{
          id: config.modelId,
          object: "model",
          created: 0,
          owned_by: "local-swiftlm",
        }],
      });
    }

    const upstream = await fetch(`${config.upstreamBaseUrl}${route}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${config.upstreamApiKey}`,
        "Content-Type": "application/json",
        Accept: req.headers.accept || "application/json",
      },
      body: JSON.stringify(body),
    });
    status = upstream.status;
    res.status(status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");

    if (body?.stream && upstream.body) {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        responsePreview = preview(responsePreview + chunk);
        res.write(chunk);
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
      route: req.path,
      model: body?.model || config.modelId,
      status,
      latencyMs: Date.now() - started,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      requestPreview: preview(body ?? {}),
      responsePreview,
    });
  }
}
