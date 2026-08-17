import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function now() {
  return new Date().toISOString();
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function encryptionKey(secret) {
  return secret ? createHash("sha256").update(secret).digest() : null;
}

function encryptNodeKey(value, key) {
  if (!value) return null;
  if (!key) throw new Error("A node secret key is required to store an upstream API key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptNodeKey(value, key) {
  if (!value || !value.startsWith("v1:")) return value || null;
  if (!key) return null;
  try {
    const [, version, ivText, tagText, encryptedText] = value.match(/^(v1):([^:]+):([^:]+):([^:]+)$/) || [];
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function createStore(databasePath, { defaultNode, nodeSecret } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      origin_base_url TEXT NOT NULL UNIQUE,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_requests (
      id TEXT PRIMARY KEY,
      api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
      route TEXT NOT NULL,
      model TEXT,
      status INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      request_preview TEXT,
      response_preview TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id TEXT PRIMARY KEY,
      token_digest TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL
    );
  `);

  // Keep existing installations compatible: SQLite cannot add a non-null foreign key
  // to a populated table, so legacy records are backfilled below after the default node exists.
  addColumnIfMissing(db, "api_keys", "node_id", "node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT");
  addColumnIfMissing(db, "nodes", "upstream_api_key", "upstream_api_key TEXT");
  // Nodes started out as SwiftLM-only, so every backend descriptor defaults to the
  // behaviour existing rows already relied on: SwiftLM over OpenAI with a bearer key.
  addColumnIfMissing(db, "nodes", "provider", "provider TEXT NOT NULL DEFAULT 'swiftlm'");
  addColumnIfMissing(db, "nodes", "protocol", "protocol TEXT NOT NULL DEFAULT 'openai'");
  addColumnIfMissing(db, "nodes", "auth_type", "auth_type TEXT NOT NULL DEFAULT 'bearer'");
  addColumnIfMissing(db, "nodes", "auth_header", "auth_header TEXT");
  addColumnIfMissing(db, "nodes", "capabilities", "capabilities TEXT");
  // Node Identity / Gateway Identity: a separate shared secret from the node's own
  // credential to its local backend (upstream_api_key). NULL until the node
  // enrolls through a one-time token; a manually-added node never gets one and is
  // trusted only as far as its network path (Wonder Mesh, private LAN) allows.
  addColumnIfMissing(db, "nodes", "node_secret", "node_secret TEXT");
  addColumnIfMissing(db, "nodes", "enrolled_at", "enrolled_at TEXT");
  addColumnIfMissing(db, "nodes", "last_heartbeat_at", "last_heartbeat_at TEXT");
  addColumnIfMissing(db, "nodes", "agent_version", "agent_version TEXT");
  addColumnIfMissing(db, "conversations", "node_id", "node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT");
  addColumnIfMissing(db, "conversations", "model_id", "model_id TEXT");
  addColumnIfMissing(db, "api_requests", "node_id", "node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "api_requests", "queue_ms", "queue_ms INTEGER");
  addColumnIfMissing(db, "api_requests", "ttft_ms", "ttft_ms INTEGER");
  addColumnIfMissing(db, "api_requests", "throughput_tps", "throughput_tps REAL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS api_requests_created_idx ON api_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS api_requests_node_idx ON api_requests(node_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS api_keys_node_idx ON api_keys(node_id);
    CREATE INDEX IF NOT EXISTS enrollment_tokens_expires_idx ON enrollment_tokens(expires_at);
  `);

  if (!defaultNode?.id) throw new Error("A default SwiftLM node is required");
  const timestamp = now();
  const nodeKey = encryptionKey(nodeSecret);
  db.prepare(`
    INSERT INTO nodes(id, name, origin_base_url, model_id, model_name, upstream_api_key, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      origin_base_url = excluded.origin_base_url,
      model_id = excluded.model_id,
      model_name = excluded.model_name,
      upstream_api_key = COALESCE(nodes.upstream_api_key, excluded.upstream_api_key),
      updated_at = excluded.updated_at
  `).run(
    defaultNode.id,
    defaultNode.name,
    defaultNode.originBaseUrl,
    defaultNode.modelId,
    defaultNode.modelName,
    encryptNodeKey(defaultNode.upstreamApiKey, nodeKey),
    timestamp,
    timestamp,
  );
  db.prepare("UPDATE api_keys SET node_id = ? WHERE node_id IS NULL").run(defaultNode.id);
  db.prepare("UPDATE conversations SET node_id = ?, model_id = ? WHERE node_id IS NULL")
    .run(defaultNode.id, defaultNode.modelId);
  db.prepare("UPDATE conversations SET model_id = ? WHERE model_id IS NULL").run(defaultNode.modelId);
  db.prepare("UPDATE api_requests SET node_id = ? WHERE node_id IS NULL").run(defaultNode.id);

  // Every node read shares one column list so a new backend descriptor field cannot
  // be exposed on one code path and silently missing on another.
  const NODE_COLUMNS = `id, name, origin_base_url, model_id, model_name,
      provider, protocol, auth_type, auth_header, capabilities,
      enabled, enrolled_at, last_heartbeat_at, agent_version, created_at, updated_at`;

  const statements = {
    insertNode: db.prepare(`
      INSERT INTO nodes(
        id, name, origin_base_url, model_id, model_name,
        provider, protocol, auth_type, auth_header, capabilities,
        upstream_api_key, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `),
    listNodes: db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY created_at ASC`),
    getNode: db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`),
    getNodeForProxy: db.prepare(`SELECT ${NODE_COLUMNS}, upstream_api_key, node_secret FROM nodes WHERE id = ?`),
    setNodeEnabled: db.prepare("UPDATE nodes SET enabled = ?, updated_at = ? WHERE id = ?"),
    updateNodeUpstreamKey: db.prepare(
      "UPDATE nodes SET upstream_api_key = ?, updated_at = ? WHERE id = ?",
    ),
    updateNodeAuth: db.prepare(`
      UPDATE nodes SET auth_type = ?, auth_header = ?, upstream_api_key = ?, updated_at = ?
      WHERE id = ?
    `),
    setNodeSecret: db.prepare(
      "UPDATE nodes SET node_secret = ?, enrolled_at = ?, updated_at = ? WHERE id = ?",
    ),
    // A heartbeat that reports no capabilities must not erase what an earlier
    // heartbeat already established, so the column only advances via COALESCE.
    recordHeartbeat: db.prepare(`
      UPDATE nodes
      SET last_heartbeat_at = ?, agent_version = COALESCE(?, agent_version),
          capabilities = COALESCE(?, capabilities), updated_at = ?
      WHERE id = ?
    `),
    nodeUsage: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM api_keys WHERE node_id = ?) AS api_key_count,
        (SELECT COUNT(*) FROM conversations WHERE node_id = ?) AS conversation_count,
        (SELECT COUNT(*) FROM api_requests WHERE node_id = ?) AS request_count
    `),
    deleteNodeRequests: db.prepare("DELETE FROM api_requests WHERE node_id = ?"),
    deleteNodeKeys: db.prepare("DELETE FROM api_keys WHERE node_id = ?"),
    deleteNodeConversations: db.prepare("DELETE FROM conversations WHERE node_id = ?"),
    deleteNode: db.prepare("DELETE FROM nodes WHERE id = ?"),
    insertKey: db.prepare(`
      INSERT INTO api_keys(id, name, prefix, digest, node_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getKeyByDigest: db.prepare(`
      SELECT k.id, k.name, k.prefix, k.node_id, k.created_at, k.last_used_at, k.revoked_at,
             n.name AS node_name, n.origin_base_url, n.model_id, n.model_name,
             n.upstream_api_key, n.node_secret,
             n.provider, n.protocol, n.auth_type, n.auth_header, n.capabilities,
             n.enabled AS node_enabled
      FROM api_keys k JOIN nodes n ON n.id = k.node_id WHERE k.digest = ?
    `),
    touchKey: db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?"),
    listKeys: db.prepare(`
      SELECT k.id, k.name, k.prefix, k.node_id, k.created_at, k.last_used_at, k.revoked_at,
             n.name AS node_name, n.model_id, n.model_name, n.enabled AS node_enabled
      FROM api_keys k JOIN nodes n ON n.id = k.node_id ORDER BY k.created_at DESC
    `),
    revokeKey: db.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?"),
    insertConversation: db.prepare(`
      INSERT INTO conversations(id, title, system_prompt, node_id, model_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listConversations: db.prepare(`
      SELECT c.id, c.title, c.system_prompt, c.node_id, c.model_id, c.created_at, c.updated_at,
             n.name AS node_name, n.model_name,
             COUNT(m.id) AS message_count,
             COALESCE((SELECT content FROM messages lm
               WHERE lm.conversation_id = c.id ORDER BY lm.created_at DESC LIMIT 1), '') AS last_message
      FROM conversations c
      JOIN nodes n ON n.id = c.node_id
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `),
    getConversation: db.prepare(`
      SELECT c.*, n.name AS node_name, n.model_name, n.origin_base_url, n.enabled AS node_enabled
      FROM conversations c JOIN nodes n ON n.id = c.node_id WHERE c.id = ?
    `),
    getMessages: db.prepare(`
      SELECT id, role, content, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC
    `),
    insertMessage: db.prepare(`
      INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
    `),
    updateMessageContent: db.prepare("UPDATE messages SET content = ? WHERE id = ?"),
    updateConversation: db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?"),
    updateConversationTarget: db.prepare("UPDATE conversations SET node_id = ?, model_id = ?, updated_at = ? WHERE id = ?"),
    touchConversation: db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?"),
    deleteConversation: db.prepare("DELETE FROM conversations WHERE id = ?"),
    insertRequest: db.prepare(`
      INSERT INTO api_requests(
        id, api_key_id, node_id, route, model, status, latency_ms,
        prompt_tokens, completion_tokens, queue_ms, ttft_ms, throughput_tps,
        request_preview, response_preview, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listRequests: db.prepare(`
      SELECT r.id, r.route, r.model, r.node_id, r.status, r.latency_ms,
             r.prompt_tokens, r.completion_tokens, r.queue_ms, r.ttft_ms, r.throughput_tps,
             r.request_preview, r.response_preview, r.created_at,
             k.name AS api_key_name, k.prefix AS api_key_prefix, n.name AS node_name, n.model_name
      FROM api_requests r
      LEFT JOIN api_keys k ON k.id = r.api_key_id
      LEFT JOIN nodes n ON n.id = r.node_id
      ORDER BY r.created_at DESC LIMIT ?
    `),
    insertEnrollmentToken: db.prepare(`
      INSERT INTO enrollment_tokens(id, token_digest, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    listEnrollmentTokens: db.prepare(`
      SELECT id, label, created_at, expires_at, used_at, node_id
      FROM enrollment_tokens ORDER BY created_at DESC LIMIT 100
    `),
    // A single UPDATE ... WHERE guards single-use atomically: a second concurrent
    // enrollment attempt with the same token cannot both succeed, because only the
    // request that actually flips used_at from NULL sees changes > 0.
    consumeEnrollmentToken: db.prepare(`
      UPDATE enrollment_tokens SET used_at = ?, node_id = ?
      WHERE token_digest = ? AND used_at IS NULL AND expires_at > ?
    `),
    getEnrollmentTokenByDigest: db.prepare(
      "SELECT id, expires_at, used_at FROM enrollment_tokens WHERE token_digest = ?",
    ),
    deleteEnrollmentToken: db.prepare(
      "DELETE FROM enrollment_tokens WHERE id = ? AND used_at IS NULL",
    ),
    pruneExpiredEnrollmentTokens: db.prepare(
      "DELETE FROM enrollment_tokens WHERE used_at IS NULL AND expires_at <= ?",
    ),
  };

  return {
    close: () => db.close(),
    createNode({
      id = randomUUID(),
      name,
      originBaseUrl,
      modelId,
      modelName,
      upstreamApiKey,
      provider = "swiftlm",
      protocol = "openai",
      authType = "bearer",
      authHeader = null,
      capabilities = null,
    }) {
      const createdAt = now();
      statements.insertNode.run(
        id, name, originBaseUrl, modelId, modelName,
        provider, protocol, authType, authHeader || null,
        capabilities ? JSON.stringify(capabilities) : null,
        encryptNodeKey(upstreamApiKey, nodeKey), createdAt, createdAt,
      );
      return statements.getNode.get(id);
    },
    listNodes: () => statements.listNodes.all(),
    getNode: (id) => statements.getNode.get(id) || null,
    getNodeForProxy(id) {
      const node = statements.getNodeForProxy.get(id);
      if (!node) return null;
      return {
        ...node,
        upstream_api_key: decryptNodeKey(node.upstream_api_key, nodeKey),
        node_secret: decryptNodeKey(node.node_secret, nodeKey),
      };
    },
    // Only set once, at enrollment. There is no rotation endpoint yet: re-enrolling
    // with a fresh token issues a new node ID rather than replacing this secret,
    // the same way a client API key is revoked and reissued rather than edited.
    setNodeSecret(id, secret) {
      const timestamp = now();
      return statements.setNodeSecret.run(encryptNodeKey(secret, nodeKey), timestamp, timestamp, id).changes > 0;
    },
    recordHeartbeat(id, { agentVersion, capabilities } = {}) {
      const timestamp = now();
      return statements.recordHeartbeat.run(
        timestamp, agentVersion || null, capabilities ? JSON.stringify(capabilities) : null, timestamp, id,
      ).changes > 0;
    },
    setNodeEnabled(id, enabled) {
      return statements.setNodeEnabled.run(enabled ? 1 : 0, now(), id).changes > 0;
    },
    updateNodeUpstreamKey(id, upstreamApiKey) {
      return statements.updateNodeUpstreamKey.run(
        encryptNodeKey(upstreamApiKey, nodeKey), now(), id,
      ).changes > 0;
    },
    // A credential is only one of several strategies, so changing it and changing the
    // strategy is a single operation: switching a node to "none" must also clear the key.
    updateNodeAuth(id, { authType, authHeader = null, upstreamApiKey = null }) {
      return statements.updateNodeAuth.run(
        authType,
        authHeader || null,
        authType === "none" ? null : encryptNodeKey(upstreamApiKey, nodeKey),
        now(),
        id,
      ).changes > 0;
    },
    getNodeUsage(id) {
      return statements.nodeUsage.get(id, id, id);
    },
    deleteNode(id, { purge = false } = {}) {
      const usage = statements.nodeUsage.get(id, id, id);
      if ((usage.api_key_count || usage.conversation_count || usage.request_count) && !purge) return false;
      if (!purge) return statements.deleteNode.run(id).changes > 0;
      try {
        db.exec("BEGIN IMMEDIATE");
        statements.deleteNodeRequests.run(id);
        statements.deleteNodeKeys.run(id);
        statements.deleteNodeConversations.run(id);
        const deleted = statements.deleteNode.run(id).changes > 0;
        db.exec("COMMIT");
        return deleted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    createApiKey({ id, name, prefix, digest, nodeId }) {
      statements.insertKey.run(id, name, prefix, digest, nodeId, now());
      return { id, name, prefix, node_id: nodeId };
    },
    authenticateApiKey(digest) {
      const key = statements.getKeyByDigest.get(digest);
      if (!key || key.revoked_at || !key.node_enabled) return null;
      statements.touchKey.run(now(), key.id);
      return {
        ...key,
        upstream_api_key: decryptNodeKey(key.upstream_api_key, nodeKey),
        node_secret: decryptNodeKey(key.node_secret, nodeKey),
      };
    },
    listApiKeys: () => statements.listKeys.all(),
    revokeApiKey(id) {
      return statements.revokeKey.run(now(), id).changes > 0;
    },
    createConversation({
      title = "新對話",
      systemPrompt = "你是一位專業助理，請使用繁體中文回答。",
      nodeId = defaultNode.id,
      modelId = defaultNode.modelId,
    } = {}) {
      const id = randomUUID();
      const timestamp = now();
      statements.insertConversation.run(id, title, systemPrompt, nodeId, modelId, timestamp, timestamp);
      return this.getConversation(id);
    },
    listConversations: () => statements.listConversations.all(),
    getConversation(id) {
      const conversation = statements.getConversation.get(id);
      if (!conversation) return null;
      return { ...conversation, messages: statements.getMessages.all(id) };
    },
    updateConversationTarget(id, nodeId, modelId) {
      return statements.updateConversationTarget.run(nodeId, modelId, now(), id).changes > 0;
    },
    addMessage(conversationId, role, content) {
      const id = randomUUID();
      const timestamp = now();
      statements.insertMessage.run(id, conversationId, role, content, timestamp);
      statements.touchConversation.run(timestamp, conversationId);
      return { id, conversation_id: conversationId, role, content, created_at: timestamp };
    },
    updateMessageContent(id, conversationId, content) {
      const result = statements.updateMessageContent.run(content, id);
      if (result.changes > 0) statements.touchConversation.run(now(), conversationId);
      return result.changes > 0;
    },
    setConversationTitle(id, title) {
      statements.updateConversation.run(title, now(), id);
    },
    deleteConversation(id) {
      return statements.deleteConversation.run(id).changes > 0;
    },
    recordRequest(entry) {
      statements.insertRequest.run(
        randomUUID(), entry.apiKeyId || null, entry.nodeId || null, entry.route, entry.model || null,
        entry.status, entry.latencyMs, entry.promptTokens ?? null, entry.completionTokens ?? null,
        entry.queueMs ?? null, entry.ttftMs ?? null, entry.throughputTps ?? null,
        entry.requestPreview || null, entry.responsePreview || null, now(),
      );
    },
    listRequests(limit = 100) {
      return statements.listRequests.all(Math.min(Math.max(limit, 1), 250));
    },
    // The raw token is returned only here, at creation, exactly like an issued
    // client API key -- the database keeps only its digest from this point on.
    createEnrollmentToken({ id = randomUUID(), tokenDigest, label = null, ttlMs }) {
      const createdAt = now();
      const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
      statements.insertEnrollmentToken.run(id, tokenDigest, label, createdAt, expiresAt);
      return { id, label, created_at: createdAt, expires_at: expiresAt };
    },
    listEnrollmentTokens: () => statements.listEnrollmentTokens.all(),
    deleteEnrollmentToken(id) {
      return statements.deleteEnrollmentToken.run(id).changes > 0;
    },
    // Returns the token row only to distinguish "already used" from "never
    // existed" for the caller's error message; the actual single-use guarantee
    // comes from the atomic UPDATE below, not from this read.
    peekEnrollmentToken(tokenDigest) {
      return statements.getEnrollmentTokenByDigest.get(tokenDigest) || null;
    },
    consumeEnrollmentToken(tokenDigest, nodeId) {
      return statements.consumeEnrollmentToken.run(now(), nodeId, tokenDigest, now()).changes > 0;
    },
    pruneExpiredEnrollmentTokens() {
      statements.pruneExpiredEnrollmentTokens.run(now());
    },
  };
}
