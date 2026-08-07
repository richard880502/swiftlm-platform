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
  `);

  // Keep existing installations compatible: SQLite cannot add a non-null foreign key
  // to a populated table, so legacy records are backfilled below after the default node exists.
  addColumnIfMissing(db, "api_keys", "node_id", "node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT");
  addColumnIfMissing(db, "nodes", "upstream_api_key", "upstream_api_key TEXT");
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

  const statements = {
    insertNode: db.prepare(`
      INSERT INTO nodes(id, name, origin_base_url, model_id, model_name, upstream_api_key, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `),
    listNodes: db.prepare(`
      SELECT id, name, origin_base_url, model_id, model_name, enabled, created_at, updated_at
      FROM nodes ORDER BY created_at ASC
    `),
    getNode: db.prepare(`
      SELECT id, name, origin_base_url, model_id, model_name, enabled, created_at, updated_at
      FROM nodes WHERE id = ?
    `),
    getNodeForProxy: db.prepare(`
      SELECT id, name, origin_base_url, model_id, model_name, upstream_api_key, enabled, created_at, updated_at
      FROM nodes WHERE id = ?
    `),
    setNodeEnabled: db.prepare("UPDATE nodes SET enabled = ?, updated_at = ? WHERE id = ?"),
    insertKey: db.prepare(`
      INSERT INTO api_keys(id, name, prefix, digest, node_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getKeyByDigest: db.prepare(`
      SELECT k.id, k.name, k.prefix, k.node_id, k.created_at, k.last_used_at, k.revoked_at,
             n.name AS node_name, n.origin_base_url, n.model_id, n.model_name, n.upstream_api_key,
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
  };

  return {
    close: () => db.close(),
    createNode({ id = randomUUID(), name, originBaseUrl, modelId, modelName, upstreamApiKey }) {
      const createdAt = now();
      statements.insertNode.run(
        id, name, originBaseUrl, modelId, modelName,
        encryptNodeKey(upstreamApiKey, nodeKey), createdAt, createdAt,
      );
      return statements.getNode.get(id);
    },
    listNodes: () => statements.listNodes.all(),
    getNode: (id) => statements.getNode.get(id) || null,
    getNodeForProxy(id) {
      const node = statements.getNodeForProxy.get(id);
      return node ? { ...node, upstream_api_key: decryptNodeKey(node.upstream_api_key, nodeKey) } : null;
    },
    setNodeEnabled(id, enabled) {
      return statements.setNodeEnabled.run(enabled ? 1 : 0, now(), id).changes > 0;
    },
    createApiKey({ id, name, prefix, digest, nodeId }) {
      statements.insertKey.run(id, name, prefix, digest, nodeId, now());
      return { id, name, prefix, node_id: nodeId };
    },
    authenticateApiKey(digest) {
      const key = statements.getKeyByDigest.get(digest);
      if (!key || key.revoked_at || !key.node_enabled) return null;
      statements.touchKey.run(now(), key.id);
      return { ...key, upstream_api_key: decryptNodeKey(key.upstream_api_key, nodeKey) };
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
  };
}
