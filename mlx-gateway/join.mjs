#!/usr/bin/env node
// swiftlm-node join <enrollment-token> -- redeems a one-time enrollment token
// issued by the Dashboard for a permanent node identity, and saves it locally so
// server.mjs can pick it up as node-agent mode on its next start.
//
//   swiftlm-node join enroll_xxxxx \
//     --server https://richard-swiftlm.zeabur.app \
//     --name "GPU 01" \
//     --base-url https://gpu-01-origin.example/v1 \
//     --model-id majentik/Qwen3.6-35B-A3B-TurboQuant-MLX-4bit
//
// --base-url is the address the Dashboard will use to reach THIS gateway once
// enrolled (through Wonder Mesh, Tailscale, or whatever private transport
// exposes it) -- not the local backend port. It must be reachable from the
// Dashboard at enrollment time, since the platform does not yet support a
// node-initiated outbound tunnel (an open question in the architecture proposal).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enroll, saveAgentState } from "./nodeAgent.mjs";

function parseArgs(argv) {
  const [token, ...rest] = argv;
  const options = { token };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    options[key] = rest[i + 1];
    i += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.token || !options.token.startsWith("enroll_")) {
    console.error("Usage: node join.mjs <enrollment-token> --server <dashboard-url> --name <name> --base-url <this gateway's /v1 url> [--model-id ...] [--model-name ...] [--provider swiftlm]");
    process.exitCode = 1;
    return;
  }
  const dashboardUrl = (options.server || process.env.DASHBOARD_BASE_URL || "").replace(/\/$/, "");
  if (!dashboardUrl) {
    console.error("Missing --server <dashboard-url> (or set DASHBOARD_BASE_URL)");
    process.exitCode = 1;
    return;
  }
  if (!options["base-url"]) {
    console.error("Missing --base-url: the address the Dashboard will use to reach this gateway once enrolled");
    process.exitCode = 1;
    return;
  }
  if (!options.name) {
    console.error("Missing --name <machine name>");
    process.exitCode = 1;
    return;
  }

  const modelId = options["model-id"] || process.env.MODEL_ID;
  if (!modelId) {
    console.error("Missing --model-id (or set MODEL_ID)");
    process.exitCode = 1;
    return;
  }

  try {
    const identity = await enroll({
      dashboardUrl,
      token: options.token,
      name: options.name,
      provider: options.provider || "swiftlm",
      baseUrl: options["base-url"],
      modelId,
      modelName: options["model-name"] || modelId,
    });
    const statePath = options["state-file"]
      || process.env.NODE_AGENT_STATE_FILE
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.state/node-agent.json");
    saveAgentState(statePath, { dashboard_url: dashboardUrl, node_id: identity.node_id, node_secret: identity.node_secret });
    console.log(JSON.stringify({ event: "enrolled", node_id: identity.node_id, state_file: statePath }));
    console.log("Restart the gateway to activate node-agent mode (signed heartbeats + Gateway-Identity verification).");
  } catch (error) {
    console.error(`Enrollment failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
