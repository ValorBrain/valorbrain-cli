/**
 * Config — ~/.valorbrain/config.json, mode 0600.
 *
 * Same schema the engine's own CLI writes (src/agent-cmd.ts), so both tools
 * interoperate on one machine: whichever ran `init` first, the other reads the
 * same key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export function configPath() {
  return resolve(homedir(), ".valorbrain", "config.json");
}

export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  chmodSync(p, 0o600);
}

/** Resolve the REST base URL. Precedence: flag > env > saved config > default. */
export function resolveBaseUrl({ urlFlag, cfg } = {}) {
  return (
    urlFlag ||
    process.env.VALORBRAIN_URL ||
    cfg?.engine_url ||
    "https://valorbrain-api.valor.digital"
  ).replace(/\/+$/, "");
}

/** MCP endpoint lives on the MCP host, never on the REST host. */
export function resolveMcpUrl({ urlFlag, cfg } = {}) {
  return (
    urlFlag ||
    process.env.VALORBRAIN_MCP_URL ||
    cfg?.mcp_url ||
    "https://mcpbrain.valor.digital/mcp"
  ).replace(/\/+$/, "");
}

/** API key: flag > env > saved config. */
export function resolveApiKey({ keyFlag, cfg } = {}) {
  return keyFlag || process.env.VALORBRAIN_TOKEN || cfg?.api_key || null;
}
