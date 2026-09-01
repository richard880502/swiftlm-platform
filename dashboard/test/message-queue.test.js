import assert from "node:assert/strict";
import test from "node:test";

import { createMessageQueue } from "../public/message-queue.js";

test("message queue preserves FIFO order and tracks each conversation", () => {
  const queue = createMessageQueue();
  queue.enqueue({ conversationId: "one", content: "first" });
  queue.enqueue({ conversationId: "two", content: "second" });
  queue.enqueue({ conversationId: "one", content: "third" });

  assert.equal(queue.countFor("one"), 2);
  assert.equal(queue.countFor("two"), 1);
  assert.deepEqual(queue.take(), { conversationId: "one", content: "first" });
  assert.deepEqual(queue.take(), { conversationId: "two", content: "second" });
  assert.deepEqual(queue.take(), { conversationId: "one", content: "third" });
  assert.equal(queue.take(), null);
});

test("message queue has a bounded capacity", () => {
  const queue = createMessageQueue(1);
  assert.equal(queue.enqueue({ conversationId: "one", content: "first" }), true);
  assert.equal(queue.enqueue({ conversationId: "one", content: "second" }), false);
});
