import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  bearerToken,
  createSessionCookie,
  hmacHex,
  issueApiKey,
  parseCookies,
  verifyAdminPassword,
  verifySessionCookie,
} from "./auth.js";
import { loadConfig } from "./config.js";
import { createStore } from "./db.js";
import { preview, proxyOpenAI, streamDashboardChat, upstreamJson } from "./proxy.js";

const config = loadConfig();
const store = createStore(config.databasePath, {
  defaultNode: config.defaultNode,
  // Reuse the existing server-only secret to encrypt per-node Origin API keys at rest.
  nodeSecret: config.keyHashSecret,
});
const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const loginAttempts = new Map();
// Keep cancellation handles server-side. A browser disconnect intentionally does not
// abort generation, but an explicit stop action must cancel the upstream stream.
const activeGenerations = new Map();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});
app.use(express.json({ limit: config.requestBodyLimit }));

function adminSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionCookie(config.sessionSecret, cookies.swiftlm_admin);
}

function requireAdmin(req, res, next) {
  if (!adminSession(req)) {
    return res.status(401).json({ error: { message: "Admin login required" } });
  }
  next();
}

function requireApiKey(req, res, next) {
  const value = bearerToken(req.headers.authorization);
  if (!value) {
    return res.status(401).json({
      error: { message: "Missing API key", type: "invalid_request_error", code: "invalid_api_key" },
    });
  }
  const key = store.authenticateApiKey(hmacHex(config.keyHashSecret, value));
  if (!key) {
    return res.status(401).json({
      error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" },
    });
  }
  req.dashboardApiKey = key;
  next();
}

function secureCookie(req, value, maxAgeSeconds) {
  const attributes = [
    `swiftlm_admin=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (req.secure || process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

function safeNodeId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_-]{1,62}$/i.test(id) ? id : "";
}

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname) return "";
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname !== "/v1") return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function checkNode(node) {
  const started = Date.now();
  if (!node.enabled) {
    return { state: "disabled", ok: false, latency_ms: null, checked_at: new Date().toISOString() };
  }
  try {
    const proxyNode = store.getNodeForProxy(node.id);
    if (!proxyNode?.upstream_api_key) throw new Error("Node API key is unavailable");
    const upstream = await upstreamJson(config, proxyNode, "/models", undefined, {
      signal: AbortSignal.timeout(5_000),
    });
    return {
      state: upstream.response.ok ? "online" : "offline",
      ok: upstream.response.ok,
      upstream_status: upstream.response.status,
      latency_ms: Date.now() - started,
      checked_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      state: "offline",
      ok: false,
      error: error.message,
      latency_ms: Date.now() - started,
      checked_at: new Date().toISOString(),
    };
  }
}

async function nodeWithStatus(node) {
  return {
    ...node,
    is_default: node.id === config.defaultNode.id,
    usage: store.getNodeUsage(node.id),
    status: await checkNode(node),
  };
}

function resolveEnabledNode(nodeId) {
  const node = store.getNode(nodeId);
  return node?.enabled ? node : null;
}

function resolveEnabledProxyNode(nodeId) {
  const node = store.getNodeForProxy(nodeId);
  return node?.enabled && node.upstream_api_key ? node : null;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "swiftlm-dashboard", default_node: config.defaultNode.id });
});

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip || "unknown";
  const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (attempt.blockedUntil > Date.now()) {
    return res.status(429).json({ error: { message: "Too many attempts. Try again later." } });
  }
  if (!verifyAdminPassword(req.body?.password, config.adminPassword)) {
    attempt.count += 1;
    if (attempt.count >= 8) {
      attempt.count = 0;
      attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
    }
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: { message: "Invalid password" } });
  }
  loginAttempts.delete(ip);
  const token = createSessionCookie(config.sessionSecret, config.sessionHours);
  res.setHeader("Set-Cookie", secureCookie(req, token, config.sessionHours * 3600));
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "swiftlm_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.status(adminSession(req) ? 200 : 401).json({ authenticated: adminSession(req) });
});

app.get("/api/status", requireAdmin, async (req, res) => {
  const node = store.getNode(safeNodeId(req.query.node_id) || config.defaultNode.id);
  if (!node) return res.status(404).json({ error: { message: "Node not found" } });
  const result = await nodeWithStatus(node);
  res.status(result.status.ok ? 200 : 502).json(result);
});

app.get("/api/nodes", requireAdmin, async (_req, res) => {
  const nodes = store.listNodes();
  res.json({ data: await Promise.all(nodes.map(nodeWithStatus)) });
});

app.post("/api/nodes", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const modelId = String(req.body?.model_id || "").trim().slice(0, 240);
  const modelName = String(req.body?.model_name || modelId).trim().slice(0, 120);
  const originBaseUrl = normalizedOrigin(req.body?.origin_base_url);
  const upstreamApiKey = String(req.body?.upstream_api_key || "").trim();
  if (!name || !modelId || !modelName || !originBaseUrl || !upstreamApiKey) {
    return res.status(400).json({ error: { message: "請填入機器名稱、模型、以 /v1 結尾的 Origin URL 與該機器的 API Key" } });
  }
  try {
    const node = store.createNode({ name, modelId, modelName, originBaseUrl, upstreamApiKey });
    return res.status(201).json(node);
  } catch (error) {
    return res.status(409).json({ error: { message: error.message.includes("UNIQUE") ? "這個 Origin URL 已存在" : "無法建立節點" } });
  }
});

app.post("/api/nodes/:id/enabled", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  const node = store.getNode(id);
  if (!node) return res.status(404).json({ error: { message: "Node not found" } });
  const enabled = Boolean(req.body?.enabled);
  if (id === config.defaultNode.id && !enabled) {
    return res.status(400).json({ error: { message: "預設節點不可停用；請先設定另一個預設節點。" } });
  }
  store.setNodeEnabled(id, enabled);
  return res.json(store.getNode(id));
});

app.patch("/api/nodes/:id/upstream-key", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  if (id === config.defaultNode.id) {
    return res.status(400).json({
      error: { message: "預設機器的上游 Key 由 Zeabur 環境設定管理，無法在此修改。" },
    });
  }
  if (!store.getNode(id)) return res.status(404).json({ error: { message: "Node not found" } });
  const upstreamApiKey = String(req.body?.upstream_api_key || "").trim();
  if (!upstreamApiKey) {
    return res.status(400).json({ error: { message: "請輸入新的上游 API Key" } });
  }
  store.updateNodeUpstreamKey(id, upstreamApiKey);
  return res.json({ ok: true, node: store.getNode(id) });
});

app.delete("/api/nodes/:id", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  if (id === config.defaultNode.id) {
    return res.status(400).json({ error: { message: "預設機器不可刪除" } });
  }
  const node = store.getNode(id);
  if (!node) return res.status(404).json({ error: { message: "Node not found" } });
  const usage = store.getNodeUsage(id);
  const purge = req.body?.purge === true;
  if ((usage.api_key_count || usage.conversation_count || usage.request_count) && !purge) {
    return res.status(409).json({
      error: {
        message: `此機器仍有 ${usage.api_key_count} 把 API Key、${usage.conversation_count} 個對話與 ${usage.request_count} 筆使用紀錄；請明確確認後再刪除。`,
      },
    });
  }
  const deleted = store.deleteNode(id, { purge });
  return res.status(deleted ? 200 : 409).json(deleted
    ? { ok: true, purged: usage }
    : { error: { message: "無法刪除這台機器" } });
});

app.get("/api/keys", requireAdmin, (_req, res) => res.json({ data: store.listApiKeys() }));

app.post("/api/keys", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "API Key").trim().slice(0, 80);
  const nodeId = safeNodeId(req.body?.node_id) || config.defaultNode.id;
  const node = resolveEnabledNode(nodeId);
  if (!node) return res.status(400).json({ error: { message: "請選擇一台在線用的機器" } });
  const issued = issueApiKey();
  store.createApiKey({
    id: issued.id,
    name,
    prefix: issued.prefix,
    digest: hmacHex(config.keyHashSecret, issued.value),
    nodeId: node.id,
  });
  res.status(201).json({
    id: issued.id,
    name,
    prefix: issued.prefix,
    node_id: node.id,
    node_name: node.name,
    model_id: node.model_id,
    key: issued.value,
    warning: "This key is shown only once.",
  });
});

app.post("/api/keys/:id/revoke", requireAdmin, (req, res) => {
  const revoked = store.revokeApiKey(req.params.id);
  res.status(revoked ? 200 : 404).json({ ok: revoked });
});

app.get("/api/conversations", requireAdmin, (_req, res) => {
  res.json({ data: store.listConversations() });
});

app.post("/api/conversations", requireAdmin, (req, res) => {
  const nodeId = safeNodeId(req.body?.node_id) || config.defaultNode.id;
  const node = resolveEnabledNode(nodeId);
  if (!node) return res.status(400).json({ error: { message: "請選擇一台可用的機器" } });
  const modelId = String(req.body?.model_id || node.model_id).trim();
  if (modelId !== node.model_id) {
    return res.status(400).json({ error: { message: "這台機器未提供指定模型" } });
  }
  const conversation = store.createConversation({
    title: String(req.body?.title || "新對話").trim().slice(0, 80),
    systemPrompt: String(
      req.body?.system_prompt || "你是一位專業助理，請使用繁體中文回答。",
    ).slice(0, 4000),
    nodeId: node.id,
    modelId,
  });
  res.status(201).json(conversation);
});

app.patch("/api/conversations/:id/target", requireAdmin, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: { message: "Conversation not found" } });
  if (conversation.messages.length > 0) {
    return res.status(409).json({ error: { message: "已有訊息的對話不能切換機器或模型，請建立新對話。" } });
  }
  const nodeId = safeNodeId(req.body?.node_id);
  const node = resolveEnabledNode(nodeId);
  const modelId = String(req.body?.model_id || "").trim();
  if (!node || modelId !== node.model_id) {
    return res.status(400).json({ error: { message: "機器或模型無法使用" } });
  }
  store.updateConversationTarget(conversation.id, node.id, modelId);
  return res.json(store.getConversation(conversation.id));
});

app.get("/api/conversations/:id", requireAdmin, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  res.status(conversation ? 200 : 404).json(conversation
    ? { ...conversation, generation_in_progress: activeGenerations.has(conversation.id) }
    : { error: { message: "Not found" } });
});

app.delete("/api/conversations/:id", requireAdmin, (req, res) => {
  const deleted = store.deleteConversation(req.params.id);
  res.status(deleted ? 200 : 404).json({ ok: deleted });
});

app.post("/api/conversations/:id/stop", requireAdmin, (req, res) => {
  const controller = activeGenerations.get(req.params.id);
  if (!controller) {
    return res.status(409).json({ error: { message: "目前沒有進行中的生成" } });
  }
  if (!controller.signal.aborted) controller.abort();
  return res.status(202).json({ ok: true, state: "stopping" });
});

app.post("/api/conversations/:id/messages", requireAdmin, async (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: { message: "Conversation not found" } });
  if (activeGenerations.has(conversation.id)) {
    return res.status(409).json({ error: { message: "A response is already being generated" } });
  }

  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: { message: "Message is required" } });
  if (content.length > 200_000) return res.status(413).json({ error: { message: "Message too large" } });
  const node = resolveEnabledNode(conversation.node_id);
  const proxyNode = resolveEnabledProxyNode(conversation.node_id);
  if (!node || !proxyNode || conversation.model_id !== node.model_id) {
    return res.status(503).json({ error: { message: "這台機器或模型目前無法使用" } });
  }

  const abortController = new AbortController();
  activeGenerations.set(conversation.id, abortController);
  try {
    store.addMessage(conversation.id, "user", content);
    if (conversation.messages.length === 0 && conversation.title === "新對話") {
      store.setConversationTitle(conversation.id, content.replace(/\s+/g, " ").slice(0, 36));
    }
    const updated = store.getConversation(conversation.id);
    const requestBody = {
      model: node.model_id,
      messages: [
        { role: "system", content: updated.system_prompt },
        ...updated.messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
      ],
      max_tokens: Math.min(Math.max(Number(req.body?.max_tokens) || 2048, 1), 32768),
      temperature: Math.min(Math.max(Number(req.body?.temperature) || 0.7, 0), 2),
      enable_thinking: Boolean(req.body?.enable_thinking),
    };
    // Store one assistant row up front so streamed text survives a browser refresh.
    const assistantMessage = store.addMessage(conversation.id, "assistant", "");
    const started = Date.now();

    await streamDashboardChat({
      config,
      node: proxyNode,
      requestBody,
      response: res,
      signal: abortController.signal,
      onProgress: ({ assistant }) => {
        store.updateMessageContent(assistantMessage.id, conversation.id, assistant);
      },
      onComplete: ({ assistant, usage, metrics, completed = true, cancelled = false }) => {
        store.updateMessageContent(assistantMessage.id, conversation.id, assistant);
        const message = { ...assistantMessage, content: assistant };
        store.recordRequest({
          route: "/api/conversations/:id/messages",
          nodeId: node.id,
          model: node.model_id,
          status: cancelled ? 499 : completed ? 200 : 502,
          latencyMs: Date.now() - started,
          promptTokens: metrics?.prompt_tokens ?? usage?.prompt_tokens,
          completionTokens: metrics?.completion_tokens ?? usage?.completion_tokens,
          queueMs: metrics?.queue_ms,
          ttftMs: metrics?.ttft_ms,
          throughputTps: metrics?.throughput_tps,
          requestPreview: preview({ content, settings: req.body }),
          responsePreview: preview(assistant),
        });
        return { message, usage };
      },
    });
  } finally {
    if (activeGenerations.get(conversation.id) === abortController) {
      activeGenerations.delete(conversation.id);
    }
  }
});

app.get("/api/activity", requireAdmin, (req, res) => {
  res.json({ data: store.listRequests(Number(req.query.limit) || 100) });
});

app.all("/v1/models", requireApiKey, (req, res) => {
  proxyOpenAI({ config, req, res, apiKey: req.dashboardApiKey, store });
});
app.all("/v1/chat/completions", requireApiKey, (req, res) => {
  proxyOpenAI({ config, req, res, apiKey: req.dashboardApiKey, store });
});

// The dashboard is a single-page app. Revalidate assets on every reload so a
// deployed UI fix is never hidden behind an hour of browser cache.
app.use(express.static(publicDir, { maxAge: 0, etag: true }));
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    event: "ready",
    service: "swiftlm-dashboard",
    port: config.port,
    model: config.modelId,
    data_dir: config.dataDir,
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", signal }));
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
