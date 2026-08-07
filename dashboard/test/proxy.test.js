import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { streamDashboardChat } from "../src/proxy.js";

class DisconnectingResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.writes = [];
    this.statusCode = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader() {}
  flushHeaders() {}
  json() {}

  write(value) {
    this.writes.push(value);
    if (this.writes.length === 1) {
      this.destroyed = true;
      this.emit("close");
    }
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

test("dashboard generation is fully persisted after the browser disconnects", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"保"}}]}\n\n');
    setTimeout(() => {
      response.write('data: {"choices":[{"delta":{"content":"存"}}]}\n\n');
      response.end('event: mlx-metrics\ndata: {"prompt_tokens":4,"completion_tokens":2,"queue_ms":3,"ttft_ms":20,"throughput_tps":12.5}\n\ndata: [DONE]\n\n');
    }, 15);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const address = upstream.address();
  const response = new DisconnectingResponse();
  let persisted;
  const progress = [];
  await streamDashboardChat({
    config: {
      upstreamApiKey: "test-only",
    },
    node: { origin_base_url: `http://127.0.0.1:${address.port}` },
    requestBody: { messages: [] },
    response,
    onProgress: ({ assistant }) => progress.push(assistant),
    onComplete: async (result) => {
      persisted = result;
      return { ok: true };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.writes.length, 1);
  assert.deepEqual(progress, ["保", "保存"]);
  assert.equal(persisted.assistant, "保存");
  assert.equal(persisted.completed, true);
  assert.equal(persisted.metrics.throughput_tps, 12.5);
});
