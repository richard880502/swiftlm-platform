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
import {
  preview,
  proxyOpenAI,
  resolveCredential,
  streamDashboardChat,
  upstreamJson,
} from "./proxy.js";
import {
  DEFAULT_PROTOCOL,
  DEFAULT_PROVIDER,
  authRequiresCredential,
  buildAuthHeaders,
  capabilitiesFor,
  detectProvider,
  isSupportedAuthType,
  isSupportedProtocol,
  isSupportedProvider,
  providerCatalog,
} from "./providers.js";
import {
  createNonceCache,
  digest as sha256Hex,
  ENROLLMENT_TOKEN_PREFIX,
  generateEnrollmentToken,
  generateNodeSecret,
  parseSignatureHeaders,
  verify as verifySignature,
} from "./nodeAuth.js";

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
// Bounds replay for Node Identity heartbeats. Scoped to this process: a dashboard
// restart re-widens the window briefly, which is an acceptable MVP trade-off since
// the timestamp window alone still bounds it.
const heartbeatNonceCache = createNonceCache();

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
    // A node agent may mount its OpenAI surface under a prefix, so any path is
    // accepted as long as it ends at the `/v1` root the adapter appends routes to.
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname.endsWith("/v1")) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function safeHeaderName(value) {
  const name = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(name) ? name : "";
}

// Auth style and credential are validated together: a credential is required only
// when the chosen strategy actually uses one, which is what makes a keyless private
// node such as vLLM behind a node agent expressible at all.
function parseAuthInput(body, { defaultAuthType = "bearer" } = {}) {
  const authType = String(body?.auth_type || defaultAuthType).trim();
  const credential = String(body?.upstream_api_key || "").trim();
  const authHeader = body?.auth_header ? safeHeaderName(body.auth_header) : null;
  if (!isSupportedAuthType(authType)) {
    return { error: "驗證方式必須是 none、bearer 或 api_key_header（mTLS 尚未支援）。" };
  }
  if (authType === "api_key_header" && body?.auth_header && !authHeader) {
    return { error: "API Key header 名稱只能包含英數字與連字號。" };
  }
  if (authRequiresCredential(authType) && !credential) {
    return { error: "這個驗證方式需要一組上游憑證。" };
  }
  return {
    authType,
    authHeader: authType === "api_key_header" ? authHeader : null,
    credential: authType === "none" ? null : credential,
  };
}

async function checkNode(node) {
  const started = Date.now();
  if (!node.enabled) {
    return { state: "disabled", ok: false, latency_ms: null, checked_at: new Date().toISOString() };
  }
  try {
    const proxyNode = store.getNodeForProxy(node.id);
    if (!proxyNode) throw new Error("Node is unavailable");
    // Only a strategy that uses a credential needs one present. A private node
    // reachable over Wonder Mesh with auth_type "none" is checked unauthenticated.
    if (authRequiresCredential(proxyNode.auth_type)
      && !resolveCredential(config, proxyNode).credential) {
      throw new Error("Node credential is unavailable");
    }
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
    capabilities: capabilitiesFor(node),
    is_default: node.id === config.defaultNode.id,
    usage: store.getNodeUsage(node.id),
    status: await checkNode(node),
    models: store.listNodeModels(node.id),
  };
}

function resolveEnabledNode(nodeId) {
  const node = store.getNode(nodeId);
  return node?.enabled ? node : null;
}

function resolveEnabledProxyNode(nodeId) {
  const node = store.getNodeForProxy(nodeId);
  if (!node?.enabled) return null;
  if (authRequiresCredential(node.auth_type) && !resolveCredential(config, node).credential) {
    return null;
  }
  return node;
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

app.get("/api/providers", requireAdmin, (_req, res) => {
  res.json({ data: providerCatalog(), protocols: [DEFAULT_PROTOCOL] });
});

// Backend detection before a node is created: one authenticated `/models` probe
// identifies the runtime and lists the models it already serves.
app.post("/api/nodes/probe", requireAdmin, async (req, res) => {
  const baseUrl = normalizedOrigin(req.body?.base_url);
  if (!baseUrl) {
    return res.status(400).json({ error: { message: "請輸入以 /v1 結尾的節點網址" } });
  }
  const auth = parseAuthInput(req.body, { defaultAuthType: "none" });
  if (auth.error) return res.status(400).json({ error: { message: auth.error } });
  try {
    const upstream = await fetch(`${baseUrl}/models`, {
      headers: buildAuthHeaders(auth),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!upstream.ok) {
      return res.status(502).json({
        error: { message: `節點回應 HTTP ${upstream.status}；請確認網址與驗證方式。` },
      });
    }
    const models = Array.isArray(parsed?.data) ? parsed.data : [];
    const detected = detectProvider({ headers: upstream.headers, models });
    return res.json({
      ...detected,
      protocol: DEFAULT_PROTOCOL,
      capabilities: capabilitiesFor({ provider: detected.provider }),
      models: models.slice(0, 50).map((model) => ({
        id: String(model?.id || ""),
        owned_by: model?.owned_by ?? null,
        max_model_len: model?.max_model_len ?? null,
      })).filter((model) => model.id),
    });
  } catch (error) {
    return res.status(502).json({
      error: { message: `無法連線到節點：${error.message}` },
    });
  }
});

app.post("/api/nodes", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const modelId = String(req.body?.model_id || "").trim().slice(0, 240);
  const modelName = String(req.body?.model_name || modelId).trim().slice(0, 120);
  const originBaseUrl = normalizedOrigin(req.body?.origin_base_url);
  const provider = String(req.body?.provider || DEFAULT_PROVIDER).trim().toLowerCase();
  const protocol = String(req.body?.protocol || DEFAULT_PROTOCOL).trim().toLowerCase();
  if (!name || !modelId || !modelName || !originBaseUrl) {
    return res.status(400).json({ error: { message: "請填入機器名稱、模型與以 /v1 結尾的節點網址" } });
  }
  if (!isSupportedProvider(provider)) {
    return res.status(400).json({ error: { message: "不支援這個 backend；可選 swiftlm、vllm、llamacpp 或 generic。" } });
  }
  if (!isSupportedProtocol(protocol)) {
    return res.status(400).json({ error: { message: "目前只支援 OpenAI-compatible protocol。" } });
  }
  // Existing callers post only a key, so bearer stays the default and their nodes
  // behave exactly as before.
  const auth = parseAuthInput(req.body, { defaultAuthType: "bearer" });
  if (auth.error) return res.status(400).json({ error: { message: auth.error } });
  try {
    const node = store.createNode({
      name,
      modelId,
      modelName,
      originBaseUrl,
      provider,
      protocol,
      authType: auth.authType,
      authHeader: auth.authHeader,
      upstreamApiKey: auth.credential,
    });
    return res.status(201).json({ ...node, capabilities: capabilitiesFor(node) });
  } catch (error) {
    return res.status(409).json({ error: { message: error.message.includes("UNIQUE") ? "這個節點網址已存在" : "無法建立節點" } });
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

function updateNodeAuth(req, res) {
  const id = safeNodeId(req.params.id);
  if (id === config.defaultNode.id) {
    return res.status(400).json({
      error: { message: "預設機器的上游憑證由 Zeabur 環境設定管理，無法在此修改。" },
    });
  }
  const existing = store.getNode(id);
  if (!existing) return res.status(404).json({ error: { message: "Node not found" } });
  const auth = parseAuthInput(req.body, { defaultAuthType: existing.auth_type || "bearer" });
  if (auth.error) return res.status(400).json({ error: { message: auth.error } });
  store.updateNodeAuth(id, {
    authType: auth.authType,
    authHeader: auth.authHeader,
    upstreamApiKey: auth.credential,
  });
  return res.json({ ok: true, node: store.getNode(id) });
}

app.patch("/api/nodes/:id/auth", requireAdmin, updateNodeAuth);
// Kept so an existing dashboard build can still rotate a bearer credential.
app.patch("/api/nodes/:id/upstream-key", requireAdmin, updateNodeAuth);

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

// A node's model set only makes sense for a backend that natively multiplexes
// several models behind the one endpoint it already has (vLLM, Ollama, LM
// Studio, ...) -- a second physical port is a second node, not a second entry
// here. See docs/inference-nodes.md.
app.get("/api/nodes/:id/models", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  if (!store.getNode(id)) return res.status(404).json({ error: { message: "Node not found" } });
  res.json({ data: store.listNodeModels(id) });
});

app.post("/api/nodes/:id/models", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  if (!store.getNode(id)) return res.status(404).json({ error: { message: "Node not found" } });
  const modelId = String(req.body?.model_id || "").trim().slice(0, 240);
  const modelName = String(req.body?.model_name || modelId).trim().slice(0, 120);
  if (!modelId) return res.status(400).json({ error: { message: "請輸入模型 ID" } });
  try {
    const models = store.addNodeModel(id, { modelId, modelName });
    return res.status(201).json({ data: models });
  } catch (error) {
    return res.status(409).json({
      error: { message: error.message.includes("UNIQUE") ? "這個模型已經在這台機器上" : "無法新增模型" },
    });
  }
});

app.patch("/api/nodes/:id/models/:modelRowId/enabled", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  if (!store.getNode(id)) return res.status(404).json({ error: { message: "Node not found" } });
  const enabled = Boolean(req.body?.enabled);
  const updated = store.setNodeModelEnabled(id, req.params.modelRowId, enabled);
  return res.status(updated ? 200 : 404).json(updated
    ? { data: store.listNodeModels(id) }
    : { error: { message: "Model not found" } });
});

app.delete("/api/nodes/:id/models/:modelRowId", requireAdmin, (req, res) => {
  const id = safeNodeId(req.params.id);
  if (!store.getNode(id)) return res.status(404).json({ error: { message: "Node not found" } });
  const result = store.deleteNodeModel(id, req.params.modelRowId);
  if (!result.ok) {
    return res.status(result.reason === "last_model" ? 409 : 404).json({
      error: {
        message: result.reason === "last_model"
          ? "機器至少要保留一個模型；請改為刪除整台機器。"
          : "Model not found",
      },
    });
  }
  return res.json({ data: store.listNodeModels(id) });
});

function enrollmentTokenState(token) {
  if (token.used_at) return "used";
  if (Date.parse(token.expires_at) <= Date.now()) return "expired";
  return "pending";
}

// Enrollment tokens are the credential that lets a node agent register itself: the
// admin generates one out of band and hands it to whoever is bringing up the new
// machine, matching the `swiftlm-node join <token>` UX the platform is aiming for.
app.get("/api/enrollment-tokens", requireAdmin, (_req, res) => {
  store.pruneExpiredEnrollmentTokens();
  res.json({ data: store.listEnrollmentTokens().map((token) => ({ ...token, state: enrollmentTokenState(token) })) });
});

app.post("/api/enrollment-tokens", requireAdmin, (req, res) => {
  store.pruneExpiredEnrollmentTokens();
  const label = String(req.body?.label || "").trim().slice(0, 80) || null;
  const ttlMinutes = Math.min(Math.max(Number(req.body?.ttl_minutes) || 10, 1), 60);
  const rawToken = generateEnrollmentToken();
  const created = store.createEnrollmentToken({
    tokenDigest: sha256Hex(rawToken), label, ttlMs: ttlMinutes * 60_000,
  });
  // The raw token is returned exactly once, like an issued client API key; only
  // its digest is ever persisted from this point on.
  res.status(201).json({ ...created, token: rawToken, state: "pending", warning: "This token is shown only once." });
});

app.delete("/api/enrollment-tokens/:id", requireAdmin, (req, res) => {
  const deleted = store.deleteEnrollmentToken(req.params.id);
  res.status(deleted ? 200 : 404).json({ ok: deleted });
});

// Node-agent facing endpoints. These are intentionally not behind requireAdmin:
// the enrollment token and, after enrollment, the node's own HMAC signature are
// the credentials here, exactly as Client API Key and Node Identity are separate
// credential channels from the admin session.
app.post("/api/node-agent/enroll", async (req, res) => {
  store.pruneExpiredEnrollmentTokens();
  const rawToken = String(req.body?.token || "").trim();
  if (!rawToken.startsWith(ENROLLMENT_TOKEN_PREFIX)) {
    return res.status(400).json({ error: { message: "缺少或格式錯誤的 enrollment token" } });
  }
  const tokenDigest = sha256Hex(rawToken);
  const existing = store.peekEnrollmentToken(tokenDigest);
  if (!existing) return res.status(401).json({ error: { message: "Enrollment token 不存在或已被撤銷" } });
  if (existing.used_at) return res.status(409).json({ error: { message: "Enrollment token 已被使用過" } });
  if (Date.parse(existing.expires_at) <= Date.now()) {
    return res.status(410).json({ error: { message: "Enrollment token 已過期" } });
  }

  const name = String(req.body?.name || "").trim().slice(0, 80);
  const modelId = String(req.body?.model_id || "").trim().slice(0, 240);
  const modelName = String(req.body?.model_name || modelId).trim().slice(0, 120);
  const originBaseUrl = normalizedOrigin(req.body?.base_url);
  const provider = String(req.body?.provider || DEFAULT_PROVIDER).trim().toLowerCase();
  const protocol = String(req.body?.protocol || DEFAULT_PROTOCOL).trim().toLowerCase();
  if (!name || !modelId || !modelName || !originBaseUrl) {
    return res.status(400).json({ error: { message: "請提供機器名稱、模型與以 /v1 結尾的節點網址" } });
  }
  if (!isSupportedProvider(provider)) {
    return res.status(400).json({ error: { message: "不支援這個 backend" } });
  }
  if (!isSupportedProtocol(protocol)) {
    return res.status(400).json({ error: { message: "目前只支援 OpenAI-compatible protocol" } });
  }
  // An enrolled node defaults to auth_type "none": the Gateway-Identity signature
  // this endpoint sets up is the intended protection, not a bearer key to the
  // local backend. The operator can still layer a backend credential on top.
  const auth = parseAuthInput(req.body, { defaultAuthType: "none" });
  if (auth.error) return res.status(400).json({ error: { message: auth.error } });

  let node;
  try {
    node = store.createNode({
      name, modelId, modelName, originBaseUrl, provider, protocol,
      authType: auth.authType, authHeader: auth.authHeader, upstreamApiKey: auth.credential,
    });
  } catch (error) {
    return res.status(409).json({ error: { message: error.message.includes("UNIQUE") ? "這個節點網址已存在" : "無法建立節點" } });
  }

  const nodeSecret = generateNodeSecret();
  store.setNodeSecret(node.id, nodeSecret);
  // Claimed after the node exists so a lost race here just leaves an inert,
  // never-enrolled node behind instead of a token that vanished with nothing to
  // show for it; self-heal by removing that orphan immediately.
  if (!store.consumeEnrollmentToken(tokenDigest, node.id)) {
    store.deleteNode(node.id, { purge: true });
    return res.status(409).json({ error: { message: "Enrollment token 已被使用過或已過期" } });
  }

  return res.status(201).json({ node_id: node.id, node_secret: nodeSecret, warning: "node_secret is shown only once." });
});

app.post("/api/node-agent/:id/heartbeat", (req, res) => {
  const nodeId = safeNodeId(req.params.id);
  const node = store.getNodeForProxy(nodeId);
  if (!node || !node.node_secret) {
    return res.status(404).json({ error: { message: "Node not found or not enrolled" } });
  }
  const { nodeId: claimedNodeId, timestamp, nonce, signature } = parseSignatureHeaders(req.headers);
  if (claimedNodeId !== nodeId) {
    return res.status(401).json({ error: { message: "Signature does not match this node" } });
  }
  const verified = verifySignature({
    secret: node.node_secret, method: req.method, path: req.path, nodeId,
    body: req.body, timestamp, nonce, signature, nonceCache: heartbeatNonceCache,
  });
  if (!verified.ok) {
    return res.status(401).json({ error: { message: `Invalid heartbeat signature (${verified.reason})` } });
  }
  store.recordHeartbeat(nodeId, {
    agentVersion: req.body?.agent_version,
    capabilities: req.body?.capabilities,
  });
  return res.json({ ok: true });
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
  if (!store.isModelAllowedOnNode(node.id, modelId)) {
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
  if (activeGenerations.has(conversation.id)) {
    return res.status(409).json({ error: { message: "模型正在生成，完成後才能切換機器或模型。" } });
  }
  const nodeId = safeNodeId(req.body?.node_id);
  const node = resolveEnabledNode(nodeId);
  const modelId = String(req.body?.model_id || "").trim();
  if (!node || !modelId || !store.isModelAllowedOnNode(node.id, modelId)) {
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
  if (!node || !proxyNode || !store.isModelAllowedOnNode(node.id, conversation.model_id)) {
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
      model: conversation.model_id,
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
          model: conversation.model_id,
          status: cancelled ? 499 : completed ? 200 : 502,
          latencyMs: Date.now() - started,
          // The adapter already merged provider metrics with stream-observed usage,
          // so unsupported values arrive as null rather than being missing.
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
