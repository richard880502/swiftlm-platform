import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthHeaders,
  capabilitiesFor,
  detectProvider,
  isSupportedAuthType,
  isSupportedProtocol,
  isSupportedProvider,
  prepareRequestBody,
  providerHeaders,
  readJsonMetrics,
  readStreamEvent,
} from "../src/providers.js";

const swiftlm = { provider: "swiftlm" };
const vllm = { provider: "vllm" };
const llamacpp = { provider: "llamacpp" };
const generic = { provider: "generic" };

test("credential strategies map to the header each backend expects", () => {
  assert.deepEqual(buildAuthHeaders({ authType: "none" }), {});
  assert.deepEqual(buildAuthHeaders({ authType: "none", credential: "unused" }), {});
  assert.deepEqual(
    buildAuthHeaders({ authType: "bearer", credential: "abc" }),
    { Authorization: "Bearer abc" },
  );
  assert.deepEqual(
    buildAuthHeaders({ authType: "api_key_header", credential: "abc" }),
    { "X-API-Key": "abc" },
  );
  assert.deepEqual(
    buildAuthHeaders({ authType: "api_key_header", authHeader: "X-Node-Key", credential: "abc" }),
    { "X-Node-Key": "abc" },
  );
  // A missing credential must never produce a half-formed auth header.
  assert.deepEqual(buildAuthHeaders({ authType: "bearer" }), {});
});

test("only implemented protocols and auth strategies are accepted", () => {
  assert.equal(isSupportedProvider("vllm"), true);
  assert.equal(isSupportedProvider("tensorrt"), false);
  assert.equal(isSupportedProtocol("openai"), true);
  assert.equal(isSupportedProtocol("ollama"), false);
  assert.equal(isSupportedAuthType("api_key_header"), true);
  assert.equal(isSupportedAuthType("mtls"), false);
});

test("a node written before providers existed still behaves as SwiftLM", () => {
  const legacy = { origin_base_url: "https://legacy.example/v1" };
  assert.deepEqual(providerHeaders(legacy, { stream: true }), { "X-MLX-Include-Metrics": "1" });
  assert.equal(
    readStreamEvent(legacy, { eventName: "mlx-metrics", data: '{"ttft_ms":20}' }).consumed,
    true,
  );
});

test("SwiftLM keeps its own metrics header and thinking switch", () => {
  assert.deepEqual(providerHeaders(swiftlm, { stream: true }), { "X-MLX-Include-Metrics": "1" });
  assert.deepEqual(providerHeaders(swiftlm, { stream: false }), { "X-MLX-Include-Metrics": "0" });
  const body = prepareRequestBody(swiftlm, { messages: [], enable_thinking: true }, { stream: true });
  assert.equal(body.enable_thinking, true);
  assert.equal(body.stream_options.include_usage, true);
});

test("vLLM receives no SwiftLM header and gets thinking through the chat template", () => {
  assert.deepEqual(providerHeaders(vllm, { stream: true }), {});
  const body = prepareRequestBody(vllm, { messages: [], enable_thinking: true }, { stream: true });
  // vLLM rejects unknown top-level fields, so the SwiftLM-specific switch must not survive.
  assert.equal("enable_thinking" in body, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(body.stream_options.include_usage, true);
});

test("backends without a thinking switch simply drop it", () => {
  for (const node of [llamacpp, generic]) {
    const body = prepareRequestBody(node, { messages: [], enable_thinking: true }, { stream: false });
    assert.equal("enable_thinking" in body, false);
    assert.equal(body.stream_options, undefined);
    assert.deepEqual(providerHeaders(node, { stream: true }), {});
  }
});

test("a caller-supplied chat_template_kwargs is not overwritten", () => {
  const body = prepareRequestBody(
    vllm,
    { messages: [], enable_thinking: false, chat_template_kwargs: { enable_thinking: true } },
    { stream: false },
  );
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
});

test("provider metrics events are consumed only by the backend that emits them", () => {
  const event = { eventName: "mlx-metrics", data: '{"queue_ms":3,"ttft_ms":20,"throughput_tps":12.5}' };
  const consumed = readStreamEvent(swiftlm, event);
  assert.equal(consumed.consumed, true);
  assert.deepEqual(consumed.metrics, {
    prompt_tokens: null,
    completion_tokens: null,
    queue_ms: 3,
    ttft_ms: 20,
    throughput_tps: 12.5,
  });
  // vLLM has no inline metrics event, so the same frame stays part of the stream.
  assert.equal(readStreamEvent(vllm, event).consumed, false);
  assert.equal(readStreamEvent(swiftlm, { eventName: "mlx-metrics", data: "not-json" }).metrics, null);
});

test("unsupported metrics are reported as null instead of failing", () => {
  assert.equal(readJsonMetrics(vllm, { usage: { prompt_tokens: 5 } }), null);
  assert.deepEqual(readJsonMetrics(llamacpp, { timings: { predicted_per_second: 42.5 } }), {
    prompt_tokens: null,
    completion_tokens: null,
    queue_ms: null,
    ttft_ms: null,
    throughput_tps: 42.5,
  });
  assert.equal(capabilitiesFor(vllm).queue_metrics, false);
  assert.equal(capabilitiesFor(swiftlm).queue_metrics, true);
  assert.equal(capabilitiesFor({ provider: "vllm", capabilities: '{"queue_metrics":true}' }).queue_metrics, true);
  assert.equal(capabilitiesFor({ provider: "vllm", capabilities: "broken" }).queue_metrics, false);
});

test("a backend is identified from a single /v1/models probe", () => {
  assert.equal(
    detectProvider({ headers: { "x-mlx-request-id": "abc" }, models: [] }).provider,
    "swiftlm",
  );
  assert.equal(
    detectProvider({ headers: {}, models: [{ id: "Qwen/Qwen3-32B", owned_by: "vllm" }] }).provider,
    "vllm",
  );
  assert.equal(
    detectProvider({ headers: {}, models: [{ id: "m", max_model_len: 32768 }] }).provider,
    "vllm",
  );
  assert.equal(
    detectProvider({ headers: {}, models: [{ id: "m", owned_by: "llamacpp" }] }).provider,
    "llamacpp",
  );
  assert.equal(detectProvider({ headers: {}, models: [{ id: "m" }] }).provider, "generic");
  assert.equal(detectProvider().provider, "generic");
});
