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
const store = createStore(config.databasePath);
const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const loginAttempts = new Map();
const activeGenerations = new Set();

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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "swiftlm-dashboard", model: config.modelId });
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

app.get("/api/status", requireAdmin, async (_req, res) => {
  const started = Date.now();
  try {
    const upstream = await upstreamJson(config, "/models", undefined, {
      signal: AbortSignal.timeout(15_000),
    });
    res.status(upstream.response.ok ? 200 : 502).json({
      ok: upstream.response.ok,
      upstream_status: upstream.response.status,
      latency_ms: Date.now() - started,
      model: config.modelId,
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message, latency_ms: Date.now() - started });
  }
});

app.get("/api/keys", requireAdmin, (_req, res) => res.json({ data: store.listApiKeys() }));

app.post("/api/keys", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "API Key").trim().slice(0, 80);
  const issued = issueApiKey();
  store.createApiKey({
    id: issued.id,
    name,
    prefix: issued.prefix,
    digest: hmacHex(config.keyHashSecret, issued.value),
  });
  res.status(201).json({
    id: issued.id,
    name,
    prefix: issued.prefix,
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
  const conversation = store.createConversation({
    title: String(req.body?.title || "新對話").trim().slice(0, 80),
    systemPrompt: String(
      req.body?.system_prompt || "你是一位專業助理，請使用繁體中文回答。",
    ).slice(0, 4000),
  });
  res.status(201).json(conversation);
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

app.post("/api/conversations/:id/messages", requireAdmin, async (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: { message: "Conversation not found" } });
  if (activeGenerations.has(conversation.id)) {
    return res.status(409).json({ error: { message: "A response is already being generated" } });
  }

  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: { message: "Message is required" } });
  if (content.length > 200_000) return res.status(413).json({ error: { message: "Message too large" } });

  activeGenerations.add(conversation.id);
  try {
    store.addMessage(conversation.id, "user", content);
    if (conversation.messages.length === 0 && conversation.title === "新對話") {
      store.setConversationTitle(conversation.id, content.replace(/\s+/g, " ").slice(0, 36));
    }
    const updated = store.getConversation(conversation.id);
    const requestBody = {
      model: config.modelId,
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
      requestBody,
      response: res,
      onProgress: ({ assistant }) => {
        store.updateMessageContent(assistantMessage.id, conversation.id, assistant);
      },
      onComplete: ({ assistant, usage, completed = true }) => {
        store.updateMessageContent(assistantMessage.id, conversation.id, assistant);
        const message = { ...assistantMessage, content: assistant };
        store.recordRequest({
          route: "/api/conversations/:id/messages",
          model: config.modelId,
          status: completed ? 200 : 502,
          latencyMs: Date.now() - started,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          requestPreview: preview({ content, settings: req.body }),
          responsePreview: preview(assistant),
        });
        return { message, usage };
      },
    });
  } finally {
    activeGenerations.delete(conversation.id);
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

app.use(express.static(publicDir, { maxAge: "1h", etag: true }));
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
