import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      }
    } catch {
      // The child server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("gateway queues inference requests and reports isolated metrics", async (t) => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const upstream = http.createServer((request, response) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => response.write('data: {"choices":[{"delta":{"content":"測"}}]}\n\n'), 30);
    setTimeout(() => {
      response.end('data: {"usage":{"prompt_tokens":4,"completion_tokens":1},"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n');
      concurrent -= 1;
    }, 120);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const gatewayPort = await unusedPort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-gateway-test-"));
  const child = spawn(process.execPath, [path.join(directory, "server.mjs")], {
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TARGET_HOST: "127.0.0.1",
      GATEWAY_TARGET_PORT: String(upstreamPort),
      GATEWAY_REQUEST_LOG: path.join(temporary, "requests.jsonl"),
      PARALLEL_REQUESTS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${gatewayPort}`;
  await waitFor(`${base}/__mlx/health`, ({ ok }) => ok === true);
  const calls = Array.from({ length: 3 }, () => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "secret" }] }),
  }));

  const queued = await waitFor(
    `${base}/__mlx/requests`,
    ({ summary }) => summary.running === 2 && summary.waiting === 1,
  );
  assert.equal(queued.active.filter(({ state }) => state === "waiting").length, 1);

  const responses = await Promise.all(calls);
  await Promise.all(responses.map((response) => response.text()));
  assert.equal(maxConcurrent, 2);
  assert.equal(new Set(responses.map((response) => response.headers.get("x-mlx-request-id"))).size, 3);

  const completed = await waitFor(
    `${base}/__mlx/requests`,
    ({ summary, recent }) => summary.running === 0 && recent.length === 3,
  );
  assert.equal(completed.summary.waiting, 0);
  assert.deepEqual(completed.recent.map(({ completion_tokens }) => completion_tokens), [1, 1, 1]);
  assert.ok(completed.recent.every(({ stream_chunks_per_second }) => stream_chunks_per_second > 0));

  const log = fs.readFileSync(path.join(temporary, "requests.jsonl"), "utf8");
  assert.doesNotMatch(log, /secret/);
  assert.match(log, /"event":"queued"/);
  assert.match(log, /"event":"completed"/);

  const modelsResponse = await fetch(`${base}/v1/models?ignored=secret-query`);
  await modelsResponse.text();
  const allRequests = await waitFor(
    `${base}/__mlx/requests`,
    ({ recent }) => recent.some(({ path }) => path === "/v1/models"),
  );
  assert.doesNotMatch(JSON.stringify(allRequests), /secret-query/);
});
