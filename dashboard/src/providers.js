// Provider extensions for the shared OpenAI protocol adapter.
//
// Every backend the platform supports speaks the same OpenAI-compatible `/v1`
// surface, so the adapter in proxy.js owns `/models`, `/chat/completions`,
// streaming and usage for all of them. Only genuinely backend-specific behaviour
// lives here: which request fields a backend accepts, and how it reports
// inference metrics. A node that reports no metrics is not an error; the
// unsupported values are reported as null.

export const PROTOCOLS = ["openai"];
export const AUTH_TYPES = ["none", "bearer", "api_key_header", "mtls"];
// mTLS belongs to the target design but has no implementation yet, so it is
// rejected at the API boundary rather than silently degrading to "none".
export const SUPPORTED_AUTH_TYPES = ["none", "bearer", "api_key_header"];
export const DEFAULT_API_KEY_HEADER = "X-API-Key";
export const DEFAULT_PROVIDER = "swiftlm";
export const DEFAULT_PROTOCOL = "openai";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withIncludeUsage(body) {
  // Most OpenAI-compatible backends only send usage in the final SSE chunk when
  // it is explicitly requested.
  return { ...body, stream_options: { ...body.stream_options, include_usage: true } };
}

function withoutThinking(body) {
  if (!("enable_thinking" in body)) return body;
  const { enable_thinking: unsupported, ...rest } = body;
  return rest;
}

function asTemplateThinking(body) {
  if (!("enable_thinking" in body)) return body;
  const { enable_thinking: thinking, ...rest } = body;
  // vLLM rejects unknown top-level fields, but passes chat_template_kwargs to the
  // model's chat template, which is where Qwen-style thinking switches live.
  return {
    ...rest,
    chat_template_kwargs: { enable_thinking: Boolean(thinking), ...rest.chat_template_kwargs },
  };
}

const PROVIDERS = {
  swiftlm: {
    id: "swiftlm",
    label: "SwiftLM (Apple Silicon)",
    thinking: "native",
    capabilities: { upstream_metrics: true, queue_metrics: true, thinking: true },
    requestHeaders: ({ stream }) => ({ "X-MLX-Include-Metrics": stream ? "1" : "0" }),
    prepareBody: (body) => body,
    readStreamEvent: ({ eventName, data }) => (eventName === "mlx-metrics"
      ? { consumed: true, metrics: parseMetrics(data) }
      : { consumed: false }),
    readJsonMetrics: () => null,
  },
  vllm: {
    id: "vllm",
    label: "vLLM (NVIDIA / CPU)",
    thinking: "template",
    // vLLM exposes metrics on its own Prometheus endpoint rather than inline in a
    // response, so per-request queue time is not available through the OpenAI API.
    capabilities: { upstream_metrics: false, queue_metrics: false, thinking: true },
    requestHeaders: () => ({}),
    prepareBody: asTemplateThinking,
    readStreamEvent: () => ({ consumed: false }),
    readJsonMetrics: () => null,
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp",
    thinking: null,
    capabilities: { upstream_metrics: true, queue_metrics: false, thinking: false },
    requestHeaders: () => ({}),
    prepareBody: withoutThinking,
    readStreamEvent: () => ({ consumed: false }),
    // llama.cpp's server reports decode speed in `timings` on non-streamed responses.
    readJsonMetrics: (parsed) => {
      const throughput = finiteNumber(parsed?.timings?.predicted_per_second);
      return throughput == null ? null : { throughput_tps: throughput };
    },
  },
  generic: {
    id: "generic",
    label: "OpenAI-compatible",
    thinking: null,
    capabilities: { upstream_metrics: false, queue_metrics: false, thinking: false },
    requestHeaders: () => ({}),
    prepareBody: withoutThinking,
    readStreamEvent: () => ({ consumed: false }),
    readJsonMetrics: () => null,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function providerCatalog() {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    capabilities: { ...PROVIDERS[id].capabilities },
  }));
}

export function isSupportedProvider(value) {
  return PROVIDER_IDS.includes(String(value || ""));
}

export function isSupportedProtocol(value) {
  return PROTOCOLS.includes(String(value || ""));
}

export function isSupportedAuthType(value) {
  return SUPPORTED_AUTH_TYPES.includes(String(value || ""));
}

// Unknown providers fall back to SwiftLM so that databases written before
// providers existed keep their exact previous behaviour.
export function providerFor(node) {
  return PROVIDERS[node?.provider] || PROVIDERS[DEFAULT_PROVIDER];
}

export function capabilitiesFor(node) {
  const defaults = providerFor(node).capabilities;
  if (!node?.capabilities) return { ...defaults };
  try {
    const stored = typeof node.capabilities === "string"
      ? JSON.parse(node.capabilities)
      : node.capabilities;
    return { ...defaults, ...stored };
  } catch {
    return { ...defaults };
  }
}

export function authRequiresCredential(authType) {
  return (authType || "bearer") !== "none";
}

export function buildAuthHeaders({ authType = "bearer", authHeader, credential } = {}) {
  if (!credential) return {};
  switch (authType) {
    case "none":
      return {};
    case "api_key_header":
      return { [authHeader || DEFAULT_API_KEY_HEADER]: credential };
    case "bearer":
      return { Authorization: `Bearer ${credential}` };
    default:
      return {};
  }
}

export function providerHeaders(node, { stream = false } = {}) {
  return providerFor(node).requestHeaders({ stream });
}

export function prepareRequestBody(node, body, { stream = false } = {}) {
  if (body === undefined || body === null || typeof body !== "object") return body;
  const prepared = providerFor(node).prepareBody(body, { stream });
  return stream ? withIncludeUsage(prepared) : prepared;
}

export function parseMetrics(data) {
  try {
    return normalizeMetrics(typeof data === "string" ? JSON.parse(data) : data);
  } catch {
    return null;
  }
}

// Provider metrics are normalized into the platform's own vocabulary so that
// activity history stays comparable across backends. Anything a backend does not
// report stays null rather than being guessed at.
export function normalizeMetrics(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    prompt_tokens: finiteNumber(raw.prompt_tokens),
    completion_tokens: finiteNumber(raw.completion_tokens),
    queue_ms: finiteNumber(raw.queue_ms),
    ttft_ms: finiteNumber(raw.ttft_ms),
    throughput_tps: finiteNumber(raw.throughput_tps),
  };
}

export function readStreamEvent(node, { eventName, data }) {
  return providerFor(node).readStreamEvent({ eventName, data });
}

export function readJsonMetrics(node, parsed) {
  return normalizeMetrics(providerFor(node).readJsonMetrics(parsed));
}

// Backend detection from a single `/v1/models` probe. Each backend leaves a
// distinctive fingerprint, so a new node rarely has to be classified by hand.
export function detectProvider({ headers, models } = {}) {
  const header = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  if (header("x-mlx-request-id")) {
    return { provider: "swiftlm", detected_from: "x-mlx-request-id header" };
  }
  const entries = Array.isArray(models) ? models : [];
  const ownedBy = String(entries[0]?.owned_by || "").toLowerCase();
  if (ownedBy.includes("vllm") || entries.some((entry) => entry?.max_model_len != null)) {
    return { provider: "vllm", detected_from: "/v1/models vLLM fields" };
  }
  if (ownedBy.includes("llamacpp") || ownedBy.includes("llama.cpp")) {
    return { provider: "llamacpp", detected_from: "/v1/models owned_by" };
  }
  if (ownedBy.includes("swiftlm") || ownedBy.includes("mlx")) {
    return { provider: "swiftlm", detected_from: "/v1/models owned_by" };
  }
  return { provider: "generic", detected_from: "OpenAI-compatible fallback" };
}
