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

export function loadConfig() {
  const dataDir = process.env.DATA_DIR?.trim() || path.resolve("data");
  return {
    port: intFromEnv("PORT", 8080),
    dataDir,
    databasePath: path.join(dataDir, "swiftlm-dashboard.sqlite"),
    adminPassword: required("ADMIN_PASSWORD"),
    sessionSecret: required("SESSION_SECRET"),
    keyHashSecret: required("KEY_HASH_SECRET"),
    upstreamBaseUrl: required("UPSTREAM_BASE_URL").replace(/\/$/, ""),
    upstreamApiKey: required("UPSTREAM_API_KEY"),
    modelId: process.env.MODEL_ID?.trim() || "majentik/Qwen3.6-35B-A3B-TurboQuant-MLX-4bit",
    sessionHours: intFromEnv("SESSION_HOURS", 24),
    requestBodyLimit: process.env.REQUEST_BODY_LIMIT?.trim() || "20mb",
  };
}
