import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/db.js";

test("keys, conversations and history persist across reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-test-"));
  const database = path.join(directory, "test.sqlite");
  let store = createStore(database);

  store.createApiKey({ id: "key-1", name: "Test", prefix: "sk-mlx-test…", digest: "digest-1" });
  assert.equal(store.authenticateApiKey("digest-1").name, "Test");
  const conversation = store.createConversation();
  store.addMessage(conversation.id, "user", "你好");
  store.addMessage(conversation.id, "assistant", "你好，有什麼可以幫你？");
  store.close();

  store = createStore(database);
  assert.equal(store.listApiKeys().length, 1);
  assert.equal(store.getConversation(conversation.id).messages.length, 2);
  assert.equal(store.revokeApiKey("key-1"), true);
  assert.equal(store.authenticateApiKey("digest-1"), null);
  store.close();
});

test("deleting a conversation also removes its messages", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swiftlm-dashboard-delete-test-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore(database);
  const conversation = store.createConversation({ title: "待刪除" });

  store.addMessage(conversation.id, "user", "這是一則測試訊息");
  assert.equal(store.getConversation(conversation.id).messages.length, 1);
  assert.equal(store.deleteConversation(conversation.id), true);
  assert.equal(store.getConversation(conversation.id), null);
  assert.equal(store.deleteConversation(conversation.id), false);
  store.close();
});
