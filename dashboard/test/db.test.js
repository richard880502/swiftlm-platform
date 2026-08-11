import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/db.js";

const defaultNode = {
  id: "mac-mini",
  name: "Mac mini",
  originBaseUrl: "https://mac-mini-origin.example/v1",
  modelId: "majentik/qwen-test",
  modelName: "Qwen Test",
  upstreamApiKey: "default-node-api-key",
};

const nodeSecret = "test-key-hash-secret";

test("keys, conversations and history persist across reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-test-"));
  const database = path.join(directory, "test.sqlite");
  let store = createStore(database, { defaultNode, nodeSecret });

  store.createApiKey({
    id: "key-1", name: "Test", prefix: "sk-mlx-test…", digest: "digest-1", nodeId: defaultNode.id,
  });
  assert.equal(store.authenticateApiKey("digest-1").name, "Test");
  assert.equal(store.authenticateApiKey("digest-1").node_id, defaultNode.id);
  const conversation = store.createConversation();
  assert.equal(conversation.node_id, defaultNode.id);
  assert.equal(conversation.model_id, defaultNode.modelId);
  store.addMessage(conversation.id, "user", "你好");
  const assistant = store.addMessage(conversation.id, "assistant", "");
  assert.equal(
    store.updateMessageContent(assistant.id, conversation.id, "你好，有什麼可以幫你？"),
    true,
  );
  store.close();

  store = createStore(database, { defaultNode, nodeSecret });
  assert.equal(store.listApiKeys().length, 1);
  assert.equal(store.getConversation(conversation.id).messages.length, 2);
  assert.equal(
    store.getConversation(conversation.id).messages[1].content,
    "你好，有什麼可以幫你？",
  );
  assert.equal(store.revokeApiKey("key-1"), true);
  assert.equal(store.authenticateApiKey("digest-1"), null);
  store.close();
});

test("deleting a conversation also removes its messages", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-delete-test-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore(database, { defaultNode, nodeSecret });
  const conversation = store.createConversation({ title: "待刪除" });

  store.addMessage(conversation.id, "user", "這是一則測試訊息");
  assert.equal(store.getConversation(conversation.id).messages.length, 1);
  assert.equal(store.deleteConversation(conversation.id), true);
  assert.equal(store.getConversation(conversation.id), null);
  assert.equal(store.deleteConversation(conversation.id), false);
  store.close();
});

test("keys, conversations, and request records stay bound to their selected node", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-nodes-test-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore(database, { defaultNode, nodeSecret });
  const node = store.createNode({
    id: "mac-studio",
    name: "Mac Studio",
    originBaseUrl: "https://mac-studio-origin.example/v1",
    modelId: "majentik/qwen-studio",
    modelName: "Qwen Studio",
    upstreamApiKey: "studio-node-api-key",
  });
  store.createApiKey({ id: "key-2", name: "Studio Key", prefix: "sk-mlx-studio…", digest: "digest-2", nodeId: node.id });
  const conversation = store.createConversation({ nodeId: node.id, modelId: node.model_id });
  store.recordRequest({
    apiKeyId: "key-2", nodeId: node.id, route: "/v1/chat/completions", model: node.model_id,
    status: 200, latencyMs: 123, promptTokens: 10, completionTokens: 4,
    queueMs: 2, ttftMs: 30, throughputTps: 12.5,
  });

  assert.equal(store.authenticateApiKey("digest-2").node_name, "Mac Studio");
  assert.equal(store.authenticateApiKey("digest-2").upstream_api_key, "studio-node-api-key");
  assert.equal(store.getNode(node.id).upstream_api_key, undefined);
  assert.equal(store.getNodeForProxy(node.id).upstream_api_key, "studio-node-api-key");
  assert.equal(store.updateNodeUpstreamKey(node.id, "studio-node-key-rotated"), true);
  assert.equal(store.getNodeForProxy(node.id).upstream_api_key, "studio-node-key-rotated");
  assert.equal(store.getNode(node.id).upstream_api_key, undefined);
  assert.equal(store.getConversation(conversation.id).node_name, "Mac Studio");
  assert.equal(store.listRequests()[0].node_id, node.id);
  assert.equal(store.listRequests()[0].node_name, "Mac Studio");
  assert.equal(store.listRequests()[0].throughput_tps, 12.5);
  assert.equal(store.listRequests()[0].ttft_ms, 30);
  assert.equal(store.getNodeUsage(node.id).api_key_count, 1);
  assert.equal(store.deleteNode(node.id), false);
  assert.equal(store.deleteNode(node.id, { purge: true }), true);
  assert.equal(store.getNode(node.id), null);
  assert.equal(store.listApiKeys().length, 0);
  assert.equal(store.listRequests().length, 0);
  assert.equal(store.getConversation(conversation.id), null);
  store.close();
});

test("an unused non-default node can be deleted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-node-delete-test-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore(database, { defaultNode, nodeSecret });
  const node = store.createNode({
    id: "unused-node",
    name: "Unused Node",
    originBaseUrl: "https://unused.example/v1",
    modelId: "unused-model",
    modelName: "Unused Model",
    upstreamApiKey: "unused-node-api-key",
  });
  const usage = store.getNodeUsage(node.id);
  assert.equal(usage.api_key_count, 0);
  assert.equal(usage.conversation_count, 0);
  assert.equal(usage.request_count, 0);
  assert.equal(store.deleteNode(node.id), true);
  assert.equal(store.getNode(node.id), null);
  store.close();
});

test("an existing single-node database is migrated to the default node", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-legacy-test-"));
  const database = path.join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE api_requests (
      id TEXT PRIMARY KEY, api_key_id TEXT, route TEXT NOT NULL, model TEXT, status INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
      request_preview TEXT, response_preview TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO api_keys VALUES ('legacy-key', 'Legacy', 'sk-mlx-legacy…', 'legacy-digest', '2026-01-01', NULL, NULL);
    INSERT INTO conversations VALUES ('legacy-conversation', 'Legacy chat', 'system', '2026-01-01', '2026-01-01');
    INSERT INTO api_requests VALUES ('legacy-request', 'legacy-key', '/v1/models', 'legacy-model', 200, 10, NULL, NULL, NULL, NULL, '2026-01-01');
  `);
  legacy.close();

  const store = createStore(database, { defaultNode, nodeSecret });
  assert.equal(store.authenticateApiKey("legacy-digest").node_id, defaultNode.id);
  assert.equal(store.getConversation("legacy-conversation").node_id, defaultNode.id);
  assert.equal(store.listRequests()[0].node_id, defaultNode.id);
  store.close();
});
