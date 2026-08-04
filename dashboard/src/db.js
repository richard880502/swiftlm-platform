import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function now() {
  return new Date().toISOString();
}

export function createStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS messages_conversation_idx
      ON messages(conversation_id, created_at);
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
    CREATE INDEX IF NOT EXISTS api_requests_created_idx
      ON api_requests(created_at DESC);
  `);

  const statements = {
    insertKey: db.prepare(`
      INSERT INTO api_keys(id, name, prefix, digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getKeyByDigest: db.prepare(`
      SELECT id, name, prefix, created_at, last_used_at, revoked_at
      FROM api_keys WHERE digest = ?
    `),
    touchKey: db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?"),
    listKeys: db.prepare(`
      SELECT id, name, prefix, created_at, last_used_at, revoked_at
      FROM api_keys ORDER BY created_at DESC
    `),
    revokeKey: db.prepare(`
      UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?
    `),
    insertConversation: db.prepare(`
      INSERT INTO conversations(id, title, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    listConversations: db.prepare(`
      SELECT c.id, c.title, c.system_prompt, c.created_at, c.updated_at,
             COUNT(m.id) AS message_count,
             COALESCE((SELECT content FROM messages lm
               WHERE lm.conversation_id = c.id
               ORDER BY lm.created_at DESC LIMIT 1), '') AS last_message
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `),
    getConversation: db.prepare("SELECT * FROM conversations WHERE id = ?"),
    getMessages: db.prepare(`
      SELECT id, role, content, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC
    `),
    insertMessage: db.prepare(`
      INSERT INTO messages(id, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    updateMessageContent: db.prepare(`
      UPDATE messages SET content = ? WHERE id = ?
    `),
    updateConversation: db.prepare(`
      UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?
    `),
    touchConversation: db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?"),
    deleteConversation: db.prepare("DELETE FROM conversations WHERE id = ?"),
    insertRequest: db.prepare(`
      INSERT INTO api_requests(
        id, api_key_id, route, model, status, latency_ms,
        prompt_tokens, completion_tokens, request_preview, response_preview, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listRequests: db.prepare(`
      SELECT r.id, r.route, r.model, r.status, r.latency_ms,
             r.prompt_tokens, r.completion_tokens, r.request_preview,
             r.response_preview, r.created_at, k.name AS api_key_name,
             k.prefix AS api_key_prefix
      FROM api_requests r
      LEFT JOIN api_keys k ON k.id = r.api_key_id
      ORDER BY r.created_at DESC LIMIT ?
    `),
  };

  return {
    close: () => db.close(),
    createApiKey({ id, name, prefix, digest }) {
      statements.insertKey.run(id, name, prefix, digest, now());
      return { id, name, prefix };
    },
    authenticateApiKey(digest) {
      const key = statements.getKeyByDigest.get(digest);
      if (!key || key.revoked_at) return null;
      statements.touchKey.run(now(), key.id);
      return key;
    },
    listApiKeys: () => statements.listKeys.all(),
    revokeApiKey(id) {
      const result = statements.revokeKey.run(now(), id);
      return result.changes > 0;
    },
    createConversation({ title = "新對話", systemPrompt = "你是一位專業助理，請使用繁體中文回答。" } = {}) {
      const id = randomUUID();
      const timestamp = now();
      statements.insertConversation.run(id, title, systemPrompt, timestamp, timestamp);
      return statements.getConversation.get(id);
    },
    listConversations: () => statements.listConversations.all(),
    getConversation(id) {
      const conversation = statements.getConversation.get(id);
      if (!conversation) return null;
      return { ...conversation, messages: statements.getMessages.all(id) };
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
        randomUUID(), entry.apiKeyId || null, entry.route, entry.model || null,
        entry.status, entry.latencyMs, entry.promptTokens ?? null,
        entry.completionTokens ?? null, entry.requestPreview || null,
        entry.responsePreview || null, now(),
      );
    },
    listRequests(limit = 100) {
      return statements.listRequests.all(Math.min(Math.max(limit, 1), 250));
    },
  };
}
