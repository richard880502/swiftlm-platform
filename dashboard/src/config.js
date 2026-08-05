import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nodeIdFromEnv(name, fallback) {
  const value = (process.env[name] ?? fallback).trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(value)) {
    throw new Error(`${name} must contain letters, numbers, underscores, or hyphens`);
  }
  return value;
}

export function loadConfig() {
  const dataDir = process.env.DATA_DIR?.trim() || path.resolve("data");
  const modelId = process.env.MODEL_ID?.trim() || "majentik/Qwen3.6-35B-A3B-TurboQuant-MLX-4bit";
  return {
    port: intFromEnv("PORT", 8080),
    dataDir,
    databasePath: path.join(dataDir, "swiftlm-dashboard.sqlite"),
    adminPassword: required("ADMIN_PASSWORD"),
    sessionSecret: required("SESSION_SECRET"),
    keyHashSecret: required("KEY_HASH_SECRET"),
    upstreamBaseUrl: required("UPSTREAM_BASE_URL").replace(/\/$/, ""),
    upstreamApiKey: required("UPSTREAM_API_KEY"),
    modelId,
    defaultNode: {
      id: nodeIdFromEnv("DEFAULT_NODE_ID", "richard-macbook-air"),
      // Keep the historical node ID stable so existing keys and conversations keep routing correctly.
      name: process.env.DEFAULT_NODE_NAME?.trim() || "Richard Mac mini",
      originBaseUrl: required("UPSTREAM_BASE_URL").replace(/\/$/, ""),
      modelId,
      modelName: process.env.MODEL_DISPLAY_NAME?.trim() || modelId,
    },
    sessionHours: intFromEnv("SESSION_HOURS", 24),
    requestBodyLimit: process.env.REQUEST_BODY_LIMIT?.trim() || "20mb",
  };
}
